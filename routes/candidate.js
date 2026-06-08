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

  // Fetch this candidate's assigned dates (if schedule has been generated)
  const myAssignments = db.queryAll(`
    SELECT a.date, l.name AS location_name
    FROM assignments a
    JOIN locations l ON a.location_id = l.id
    WHERE a.candidate_id = ?
    ORDER BY a.date
  `, [candidate.id]);

  res.render('candidate/portal', {
    candidate,
    settings,
    blackoutDates,
    isLocked,
    myAssignments,
    pendingSwapCount: getPendingSwapCount(candidate.id)
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

// ─── Shared helper: pending swap count for nav badge ──
function getPendingSwapCount(candidateId) {
  const row = db.queryOne(
    `SELECT COUNT(*) as cnt FROM swap_requests
     WHERE target_id = ? AND status = 'pending'`,
    [candidateId]
  );
  return row ? row.cnt : 0;
}

// ─── Schedule View ─────────────────────────────────
router.get('/schedule', requireCandidate, (req, res) => {
  const meId = req.session.candidate.id;
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const locations = db.queryAll('SELECT * FROM locations ORDER BY name');

  const assignments = db.queryAll(`
    SELECT a.id, a.date, a.candidate_id, a.location_id,
           c.name AS candidate_name, l.name AS location_name
    FROM assignments a
    JOIN candidates c ON a.candidate_id = c.id
    JOIN locations l ON a.location_id = l.id
    ORDER BY a.date, l.name, c.name
  `);

  // Build grid: date → location_id → [{id, name, isMe, candidate_id}]
  const scheduleGrid = {};
  const myDates = new Set();
  const myAssignments = [];   // my assignments available to offer in a swap
  const otherAssignments = []; // other deacons' assignments to trade for

  // Assignments already tied up in a pending swap request
  const pendingAssignmentIds = new Set(
    db.queryAll(
      `SELECT requester_assignment_id as aid FROM swap_requests WHERE status='pending'
       UNION
       SELECT target_assignment_id FROM swap_requests WHERE status='pending'`
    ).map(r => r.aid)
  );

  for (const a of assignments) {
    if (!scheduleGrid[a.date]) scheduleGrid[a.date] = {};
    if (!scheduleGrid[a.date][a.location_id]) scheduleGrid[a.date][a.location_id] = [];
    const isMe = a.candidate_id === meId;
    scheduleGrid[a.date][a.location_id].push({
      id: a.id, name: a.candidate_name, isMe,
      candidate_id: a.candidate_id,
      hasPendingSwap: pendingAssignmentIds.has(a.id)
    });
    if (isMe) {
      myDates.add(a.date);
      myAssignments.push({
        id: a.id, date: a.date,
        location_name: a.location_name,
        hasPendingSwap: pendingAssignmentIds.has(a.id)
      });
    } else {
      otherAssignments.push({
        id: a.id, date: a.date,
        candidate_name: a.candidate_name,
        candidate_id: a.candidate_id,
        location_name: a.location_name,
        hasPendingSwap: pendingAssignmentIds.has(a.id)
      });
    }
  }

  res.render('candidate/schedule', {
    candidate: req.session.candidate,
    settings,
    locations,
    scheduleGrid,
    myDates: [...myDates],
    myAssignments,
    otherAssignments,
    hasSchedule: assignments.length > 0,
    pendingSwapCount: getPendingSwapCount(meId)
  });
});

// ─── Swap Requests Page ─────────────────────────────
router.get('/swaps', requireCandidate, (req, res) => {
  const meId = req.session.candidate.id;

  const incoming = db.queryAll(`
    SELECT sr.*,
           rc.name AS requester_name, rc.email AS requester_email,
           ra.date AS requester_date, rl.name AS requester_location,
           ta.date AS target_date,   tl.name AS target_location
    FROM swap_requests sr
    JOIN candidates rc ON sr.requester_id = rc.id
    JOIN candidates tc ON sr.target_id    = tc.id
    JOIN assignments ra ON sr.requester_assignment_id = ra.id
    JOIN assignments ta ON sr.target_assignment_id    = ta.id
    JOIN locations   rl ON ra.location_id = rl.id
    JOIN locations   tl ON ta.location_id = tl.id
    WHERE sr.target_id = ? AND sr.status = 'pending'
    ORDER BY sr.created_at DESC
  `, [meId]);

  const outgoing = db.queryAll(`
    SELECT sr.*,
           tc.name AS target_name,
           ra.date AS requester_date, rl.name AS requester_location,
           ta.date AS target_date,   tl.name AS target_location
    FROM swap_requests sr
    JOIN candidates tc ON sr.target_id    = tc.id
    JOIN assignments ra ON sr.requester_assignment_id = ra.id
    JOIN assignments ta ON sr.target_assignment_id    = ta.id
    JOIN locations   rl ON ra.location_id = rl.id
    JOIN locations   tl ON ta.location_id = tl.id
    WHERE sr.requester_id = ? AND sr.status = 'pending'
    ORDER BY sr.created_at DESC
  `, [meId]);

  const history = db.queryAll(`
    SELECT sr.*,
           rc.name AS requester_name, tc.name AS target_name,
           ra.date AS requester_date, rl.name AS requester_location,
           ta.date AS target_date,   tl.name AS target_location
    FROM swap_requests sr
    JOIN candidates rc ON sr.requester_id = rc.id
    JOIN candidates tc ON sr.target_id    = tc.id
    JOIN assignments ra ON sr.requester_assignment_id = ra.id
    JOIN assignments ta ON sr.target_assignment_id    = ta.id
    JOIN locations   rl ON ra.location_id = rl.id
    JOIN locations   tl ON ta.location_id = tl.id
    WHERE (sr.requester_id = ? OR sr.target_id = ?) AND sr.status != 'pending'
    ORDER BY sr.resolved_at DESC
    LIMIT 20
  `, [meId, meId]);

  res.render('candidate/swaps', {
    candidate: req.session.candidate,
    incoming,
    outgoing,
    history,
    pendingSwapCount: incoming.length,
    success: req.query.success || null,
    error:   req.query.error   || null
  });
});

// ─── Propose a Swap ─────────────────────────────────
router.post('/swaps/propose', requireCandidate, async (req, res) => {
  const meId = req.session.candidate.id;
  const { my_assignment_id, their_assignment_id, message } = req.body;

  const redirect = (err) => res.redirect('/candidate/swaps?error=' + encodeURIComponent(err));

  // Verify both assignments exist
  const myA   = db.queryOne('SELECT a.*, l.name AS location_name FROM assignments a JOIN locations l ON a.location_id=l.id WHERE a.id=?', [my_assignment_id]);
  const theirA = db.queryOne('SELECT a.*, l.name AS location_name, c.name AS candidate_name, c.email AS candidate_email FROM assignments a JOIN locations l ON a.location_id=l.id JOIN candidates c ON a.candidate_id=c.id WHERE a.id=?', [their_assignment_id]);

  if (!myA)    return redirect('Your assignment was not found.');
  if (!theirA) return redirect('The other assignment was not found.');
  if (myA.candidate_id !== meId)   return redirect('That is not your assignment.');
  if (theirA.candidate_id === meId) return redirect('You cannot swap with yourself.');

  // Check no pending swap already involves these two assignments
  const conflict = db.queryOne(
    `SELECT id FROM swap_requests WHERE status='pending' AND
     (requester_assignment_id=? OR target_assignment_id=? OR
      requester_assignment_id=? OR target_assignment_id=?)`,
    [my_assignment_id, my_assignment_id, their_assignment_id, their_assignment_id]
  );
  if (conflict) return redirect('One of these assignments already has a pending swap request.');

  // Check for duplicate request between same two people for same dates
  const dup = db.queryOne(
    `SELECT id FROM swap_requests WHERE status='pending' AND requester_id=? AND target_id=?`,
    [meId, theirA.candidate_id]
  );
  if (dup) return redirect('You already have a pending swap request with that person.');

  db.run(
    `INSERT INTO swap_requests (requester_id, requester_assignment_id, target_id, target_assignment_id, message)
     VALUES (?, ?, ?, ?, ?)`,
    [meId, my_assignment_id, theirA.candidate_id, their_assignment_id, message || null]
  );

  // Email the target
  try {
    const me = db.queryOne('SELECT name FROM candidates WHERE id=?', [meId]);
    await mailer.sendSwapRequest(
      theirA.candidate_email, theirA.candidate_name, me.name,
      { date: myA.date,    location_name: myA.location_name },
      { date: theirA.date, location_name: theirA.location_name },
      message
    );
  } catch (err) {
    console.error('Swap request email failed:', err.message);
  }

  res.redirect('/candidate/swaps?success=' + encodeURIComponent(
    `Swap request sent to ${theirA.candidate_name}. They will be notified by email.`
  ));
});

// ─── Approve a Swap ─────────────────────────────────
router.post('/swaps/:id/approve', requireCandidate, async (req, res) => {
  const meId = req.session.candidate.id;
  const swap = db.queryOne('SELECT * FROM swap_requests WHERE id=?', [req.params.id]);

  if (!swap || swap.status !== 'pending') return res.redirect('/candidate/swaps?error=Swap+not+found+or+already+resolved.');
  if (swap.target_id !== meId)            return res.redirect('/candidate/swaps?error=Not+authorized.');

  const myA    = db.queryOne('SELECT a.*, l.name AS location_name FROM assignments a JOIN locations l ON a.location_id=l.id WHERE a.id=?', [swap.target_assignment_id]);
  const theirA = db.queryOne('SELECT a.*, l.name AS location_name FROM assignments a JOIN locations l ON a.location_id=l.id WHERE a.id=?', [swap.requester_assignment_id]);
  const requester = db.queryOne('SELECT * FROM candidates WHERE id=?', [swap.requester_id]);
  const me        = db.queryOne('SELECT * FROM candidates WHERE id=?', [meId]);

  if (!myA || !theirA || !requester) return res.redirect('/candidate/swaps?error=Assignments+no+longer+exist+(schedule+may+have+been+regenerated).');

  // Validate blackout dates — warn but still allow (soft constraint)
  const blackoutMe   = db.queryOne('SELECT id FROM blackout_dates WHERE candidate_id=? AND date=?', [meId, theirA.date]);
  const blackoutThem = db.queryOne('SELECT id FROM blackout_dates WHERE candidate_id=? AND date=?', [swap.requester_id, myA.date]);
  if (blackoutMe)   console.warn(`Swap approved but ${me.name} has blackout on ${theirA.date}`);
  if (blackoutThem) console.warn(`Swap approved but ${requester.name} has blackout on ${myA.date}`);

  // Execute swap — exchange the candidate_ids on the two assignments
  db.transaction(() => {
    db.run('UPDATE assignments SET candidate_id=? WHERE id=?', [meId,           swap.requester_assignment_id]);
    db.run('UPDATE assignments SET candidate_id=? WHERE id=?', [swap.requester_id, swap.target_assignment_id]);
    db.run(
      `UPDATE swap_requests SET status='approved', resolved_at=datetime('now') WHERE id=?`,
      [swap.id]
    );
    // Cancel any other pending swaps that involved these two assignments
    db.run(
      `UPDATE swap_requests SET status='cancelled', resolved_at=datetime('now')
       WHERE id != ? AND status='pending' AND
             (requester_assignment_id IN (?,?) OR target_assignment_id IN (?,?))`,
      [swap.id, swap.requester_assignment_id, swap.target_assignment_id,
                swap.requester_assignment_id, swap.target_assignment_id]
    );
  });

  // Email requester
  try {
    await mailer.sendSwapResolved(
      requester.email, requester.name, me.name, true,
      { date: theirA.date, location_name: theirA.location_name },
      { date: myA.date,    location_name: myA.location_name }
    );
  } catch (err) {
    console.error('Swap approval email failed:', err.message);
  }

  res.redirect('/candidate/swaps?success=' + encodeURIComponent(
    `Swap approved! You are now assigned ${theirA.date} — ${theirA.location_name}.`
  ));
});

// ─── Decline a Swap ─────────────────────────────────
router.post('/swaps/:id/decline', requireCandidate, async (req, res) => {
  const meId = req.session.candidate.id;
  const swap = db.queryOne('SELECT * FROM swap_requests WHERE id=?', [req.params.id]);

  if (!swap || swap.status !== 'pending') return res.redirect('/candidate/swaps?error=Swap+not+found+or+already+resolved.');
  if (swap.target_id !== meId)            return res.redirect('/candidate/swaps?error=Not+authorized.');

  const theirA    = db.queryOne('SELECT a.*, l.name AS location_name FROM assignments a JOIN locations l ON a.location_id=l.id WHERE a.id=?', [swap.requester_assignment_id]);
  const myA       = db.queryOne('SELECT a.*, l.name AS location_name FROM assignments a JOIN locations l ON a.location_id=l.id WHERE a.id=?', [swap.target_assignment_id]);
  const requester = db.queryOne('SELECT * FROM candidates WHERE id=?', [swap.requester_id]);
  const me        = db.queryOne('SELECT * FROM candidates WHERE id=?', [meId]);

  db.run(`UPDATE swap_requests SET status='declined', resolved_at=datetime('now') WHERE id=?`, [swap.id]);

  try {
    if (requester && theirA && myA) {
      await mailer.sendSwapResolved(
        requester.email, requester.name, me.name, false,
        { date: theirA.date, location_name: theirA.location_name },
        { date: myA.date,    location_name: myA.location_name }
      );
    }
  } catch (err) {
    console.error('Swap decline email failed:', err.message);
  }

  res.redirect('/candidate/swaps?success=Swap+request+declined.');
});

// ─── Cancel a Swap (requester withdraws) ────────────
router.post('/swaps/:id/cancel', requireCandidate, (req, res) => {
  const meId = req.session.candidate.id;
  const swap = db.queryOne('SELECT * FROM swap_requests WHERE id=?', [req.params.id]);

  if (!swap || swap.status !== 'pending') return res.redirect('/candidate/swaps?error=Swap+not+found+or+already+resolved.');
  if (swap.requester_id !== meId)         return res.redirect('/candidate/swaps?error=Not+authorized.');

  db.run(`UPDATE swap_requests SET status='cancelled', resolved_at=datetime('now') WHERE id=?`, [swap.id]);
  res.redirect('/candidate/swaps?success=Swap+request+cancelled.');
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
