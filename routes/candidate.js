const express = require('express');
const router = express.Router();
const bcryptjs = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { requireCandidate } = require('../middleware/auth');
const mailer = require('../services/mailer');

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

// ─── Schedule View ─────────────────────────────────
router.get('/schedule', requireCandidate, (req, res) => {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const locations = db.queryAll('SELECT * FROM locations ORDER BY name');

  const assignments = db.queryAll(`
    SELECT a.date, a.candidate_id, a.location_id,
           c.name AS candidate_name, l.name AS location_name
    FROM assignments a
    JOIN candidates c ON a.candidate_id = c.id
    JOIN locations l ON a.location_id = l.id
    ORDER BY a.date, l.name, c.name
  `);

  // Build grid: date → location_id → [{name, isMe}]
  const scheduleGrid = {};
  const myDates = new Set();

  for (const a of assignments) {
    if (!scheduleGrid[a.date]) scheduleGrid[a.date] = {};
    if (!scheduleGrid[a.date][a.location_id]) scheduleGrid[a.date][a.location_id] = [];
    const isMe = a.candidate_id === req.session.candidate.id;
    scheduleGrid[a.date][a.location_id].push({ name: a.candidate_name, isMe });
    if (isMe) myDates.add(a.date);
  }

  res.render('candidate/schedule', {
    candidate: req.session.candidate,
    settings,
    locations,
    scheduleGrid,
    myDates: [...myDates],
    hasSchedule: assignments.length > 0
  });
});

// ─── Forgot Password ───────────────────────────────
router.get('/forgot-password', (req, res) => {
  if (req.session.candidate) return res.redirect('/candidate/portal');
  res.render('candidate/forgot-password', { sent: false, error: null });
});

router.post('/forgot-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const candidate = db.queryOne('SELECT * FROM candidates WHERE email = ?', [email]);

  // Always show "sent" to prevent email enumeration, but only send if account + password exist
  if (candidate && candidate.password_hash) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    db.run(
      'INSERT INTO candidate_reset_tokens (candidate_id, token, expires_at) VALUES (?, ?, ?)',
      [candidate.id, token, expiresAt]
    );

    try {
      const link = await mailer.sendPasswordReset(candidate.email, candidate.name, token);
      if (link) console.log('Password reset link (dev):', link);
    } catch (err) {
      console.error('Failed to send reset email:', err.message);
    }
  }

  res.render('candidate/forgot-password', { sent: true, error: null });
});

// ─── Reset Password ────────────────────────────────
router.get('/reset-password', (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/candidate/login');

  const record = db.queryOne(`
    SELECT rt.*, c.name, c.email
    FROM candidate_reset_tokens rt
    JOIN candidates c ON rt.candidate_id = c.id
    WHERE rt.token = ?
  `, [token]);

  const valid = record && !record.used && new Date(record.expires_at) >= new Date();
  res.render('candidate/reset-password', {
    valid,
    token,
    error: valid ? null : 'This reset link is invalid or has expired.',
    success: false
  });
});

router.post('/reset-password', (req, res) => {
  const { token, new_password, confirm_password } = req.body;

  const record = db.queryOne(`
    SELECT rt.*, c.name, c.email
    FROM candidate_reset_tokens rt
    JOIN candidates c ON rt.candidate_id = c.id
    WHERE rt.token = ?
  `, [token]);

  const valid = record && !record.used && new Date(record.expires_at) >= new Date();
  if (!valid) {
    return res.render('candidate/reset-password', {
      valid: false, token,
      error: 'This reset link is invalid or has expired.',
      success: false
    });
  }

  if (!new_password || new_password.length < 6) {
    return res.render('candidate/reset-password', {
      valid: true, token,
      error: 'Password must be at least 6 characters.',
      success: false
    });
  }

  if (new_password !== confirm_password) {
    return res.render('candidate/reset-password', {
      valid: true, token,
      error: 'Passwords do not match.',
      success: false
    });
  }

  const hash = bcryptjs.hashSync(new_password, 10);
  db.run('UPDATE candidates SET password_hash = ? WHERE id = ?', [hash, record.candidate_id]);
  db.run('UPDATE candidate_reset_tokens SET used = 1 WHERE id = ?', [record.id]);

  res.render('candidate/reset-password', { valid: true, token, error: null, success: true });
});

// ─── Logout ────────────────────────────────────────
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

module.exports = router;
