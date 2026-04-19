const express = require('express');
const router = express.Router();
const bcryptjs = require('bcryptjs');
const db = require('../db');
const { requireCandidate } = require('../middleware/auth');

// ─── Magic Link Authentication (still works as fallback) ──
router.get('/auth', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.render('candidate/error', { message: 'No access token provided.' });
  }

  const link = db.queryOne(`
    SELECT ml.*, c.name, c.email, c.id as cid
    FROM magic_links ml
    JOIN candidates c ON ml.candidate_id = c.id
    WHERE ml.token = ?
  `, [token]);

  if (!link) {
    return res.render('candidate/error', { message: 'Invalid or expired access link.' });
  }

  if (link.used) {
    return res.render('candidate/error', {
      message: 'This access link has already been used. Please request a new one from the administrator.'
    });
  }

  if (new Date(link.expires_at) < new Date()) {
    return res.render('candidate/error', {
      message: 'This access link has expired. Please request a new one from the administrator.'
    });
  }

  // Mark token as used
  db.run('UPDATE magic_links SET used = 1 WHERE id = ?', [link.id]);

  // Create session
  req.session.candidate = {
    id: link.cid,
    name: link.name,
    email: link.email
  };

  res.redirect('/candidate/portal');
});

// ─── Candidate Login (email + password) ────────────
router.get('/login', (req, res) => {
  if (req.session.candidate) return res.redirect('/candidate/portal');
  res.render('candidate/login', { step: 'email', email: '', error: null, message: null });
});

router.post('/login', (req, res) => {
  const { email, password, new_password, confirm_password, step } = req.body;
  const normalizedEmail = (email || '').trim().toLowerCase();

  const candidate = db.queryOne('SELECT * FROM candidates WHERE email = ?', [normalizedEmail]);
  if (!candidate) {
    return res.render('candidate/login', {
      step: 'email', email: normalizedEmail, error: 'No candidate found with that email address.', message: null
    });
  }

  // Step: email submitted — decide whether to show password or create-password form
  if (step === 'email') {
    if (candidate.password_hash) {
      return res.render('candidate/login', {
        step: 'password', email: normalizedEmail, error: null, message: null
      });
    } else {
      return res.render('candidate/login', {
        step: 'create-password', email: normalizedEmail, error: null, message: null
      });
    }
  }

  // Step: first-time password creation
  if (step === 'create-password') {
    if (!new_password || new_password.length < 6) {
      return res.render('candidate/login', {
        step: 'create-password', email: normalizedEmail,
        error: 'Password must be at least 6 characters.', message: null
      });
    }
    if (new_password !== confirm_password) {
      return res.render('candidate/login', {
        step: 'create-password', email: normalizedEmail,
        error: 'Passwords do not match.', message: null
      });
    }

    const hash = bcryptjs.hashSync(new_password, 10);
    db.run('UPDATE candidates SET password_hash = ? WHERE id = ?', [hash, candidate.id]);

    req.session.candidate = { id: candidate.id, name: candidate.name, email: candidate.email };
    return res.redirect('/candidate/portal');
  }

  // Step: returning user — verify password
  if (step === 'password') {
    if (!password || !bcryptjs.compareSync(password, candidate.password_hash)) {
      return res.render('candidate/login', {
        step: 'password', email: normalizedEmail, error: 'Incorrect password.', message: null
      });
    }

    req.session.candidate = { id: candidate.id, name: candidate.name, email: candidate.email };
    return res.redirect('/candidate/portal');
  }

  res.redirect('/candidate/login');
});

// ─── Portal ────────────────────────────────────────
router.get('/portal', requireCandidate, (req, res) => {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const candidate = db.queryOne('SELECT * FROM candidates WHERE id = ?', [req.session.candidate.id]);

  if (!candidate) {
    req.session.destroy();
    return res.redirect('/candidate/login');
  }

  // Get existing blackout dates for this candidate (user-submitted only)
  const blackoutDates = db.queryAll(
    'SELECT date FROM blackout_dates WHERE candidate_id = ? AND is_system_generated = 0',
    [candidate.id]
  ).map(r => r.date);

  // Check if deadline has passed
  const now = new Date();
  const deadline = settings.input_deadline ? new Date(settings.input_deadline) : null;
  const isLocked = deadline ? now > deadline : false;

  res.render('candidate/portal', {
    candidate,
    settings,
    blackoutDates,
    isLocked
  });
});

// ─── Save Blackout Dates ───────────────────────────
router.post('/save-blackouts', requireCandidate, (req, res) => {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');

  // Check deadline
  const now = new Date();
  const deadline = settings.input_deadline ? new Date(settings.input_deadline) : null;
  if (deadline && now > deadline) {
    return res.status(403).json({ error: 'The submission deadline has passed.' });
  }

  const { dates } = req.body;
  const candidateId = req.session.candidate.id;

  db.transaction(() => {
    // Remove existing user-submitted blackout dates
    db.run('DELETE FROM blackout_dates WHERE candidate_id = ? AND is_system_generated = 0', [candidateId]);

    // Insert new blackout dates
    if (dates && dates.length > 0) {
      for (const date of dates) {
        try {
          db.run('INSERT INTO blackout_dates (candidate_id, date, is_system_generated) VALUES (?, ?, 0)',
            [candidateId, date]);
        } catch (e) {
          // Ignore duplicate
        }
      }
    }

    // Mark as submitted
    db.run('UPDATE candidates SET has_submitted_input = 1 WHERE id = ?', [candidateId]);
  });

  res.json({ success: true, message: 'Your availability has been saved.' });
});

// ─── Logout ────────────────────────────────────────
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

module.exports = router;
