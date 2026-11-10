const express = require('express');
const router = express.Router();
const bcryptjs = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const path = require('path');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const mailer = require('../services/mailer');

// Multer config for CSV uploads
const upload = multer({
  dest: path.join(__dirname, '..', 'uploads'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// ─── Login ─────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin/dashboard');
  res.render('admin/login', { error: null });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const admin = db.queryOne('SELECT * FROM admins WHERE email = ?', [email.trim().toLowerCase()]);

  if (!admin || !bcryptjs.compareSync(password, admin.password_hash)) {
    return res.render('admin/login', { error: 'Invalid email or password' });
  }

  req.session.admin = { id: admin.id, email: admin.email, name: admin.name, is_super: !!admin.is_super };
  res.redirect('/admin/dashboard');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ─── Forgot Password ───────────────────────────────
router.get('/forgot-password', (req, res) => {
  if (req.session.admin) return res.redirect('/admin/dashboard');
  res.render('admin/forgot-password', { sent: false, error: null });
});

router.post('/forgot-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const admin = db.queryOne('SELECT * FROM admins WHERE email = ?', [email]);

  if (admin) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.run(
      'INSERT INTO admin_reset_tokens (admin_id, token, expires_at) VALUES (?, ?, ?)',
      [admin.id, token, expiresAt]
    );
    try {
      const link = await mailer.sendAdminPasswordReset(admin.email, admin.name, token);
      if (link) console.log('Admin password reset link (dev):', link);
    } catch (err) {
      console.error('Failed to send admin reset email:', err.message);
    }
  }

  res.render('admin/forgot-password', { sent: true, error: null });
});

// ─── Reset Password ────────────────────────────────
router.get('/reset-password', (req, res) => {
  if (req.session.admin) return res.redirect('/admin/dashboard');
  const { token } = req.query;
  if (!token) return res.redirect('/admin/login');

  const record = db.queryOne(`
    SELECT rt.*, a.name, a.email
    FROM admin_reset_tokens rt
    JOIN admins a ON rt.admin_id = a.id
    WHERE rt.token = ?
  `, [token]);

  const valid = record && !record.used && new Date(record.expires_at) >= new Date();
  res.render('admin/reset-password', {
    valid,
    token,
    error: valid ? null : 'This reset link is invalid or has expired.',
    success: false
  });
});

router.post('/reset-password', (req, res) => {
  const { token, new_password, confirm_password } = req.body;

  const record = db.queryOne(`
    SELECT rt.*, a.name, a.email
    FROM admin_reset_tokens rt
    JOIN admins a ON rt.admin_id = a.id
    WHERE rt.token = ?
  `, [token]);

  const valid = record && !record.used && new Date(record.expires_at) >= new Date();
  if (!valid) {
    return res.render('admin/reset-password', {
      valid: false, token,
      error: 'This reset link is invalid or has expired.',
      success: false
    });
  }

  if (!new_password || new_password.length < 6) {
    return res.render('admin/reset-password', {
      valid: true, token,
      error: 'Password must be at least 6 characters.',
      success: false
    });
  }

  if (new_password !== confirm_password) {
    return res.render('admin/reset-password', {
      valid: true, token,
      error: 'Passwords do not match.',
      success: false
    });
  }

  const hash = bcryptjs.hashSync(new_password, 10);
  db.transaction(() => {
    db.run('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, record.admin_id]);
    db.run('UPDATE admin_reset_tokens SET used = 1 WHERE id = ?', [record.id]);
  });
  db.save();

  res.render('admin/reset-password', { valid: true, token, error: null, success: true });
});

// ─── Dashboard ─────────────────────────────────────
router.get('/dashboard', requireAdmin, (req, res) => {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const candidateCount = db.queryOne('SELECT COUNT(*) as count FROM candidates').count;
  const submittedCount = db.queryOne('SELECT COUNT(*) as count FROM candidates WHERE has_submitted_input = 1').count;
  const locationCount = db.queryOne('SELECT COUNT(*) as count FROM locations').count;
  const assignmentCount = db.queryOne('SELECT COUNT(*) as count FROM assignments').count;

  // Per-candidate assignment breakdown for schedule summary
  const scheduleByCandidate = db.queryAll(`
    SELECT c.id, c.name,
           COUNT(a.id) AS shift_count
    FROM candidates c
    LEFT JOIN assignments a ON c.id = a.candidate_id
    GROUP BY c.id, c.name
    ORDER BY c.name
  `);

  // All assignments for the date-sorted schedule table
  const allAssignments = db.queryAll(`
    SELECT a.date, c.name AS candidate_name, l.name AS location_name
    FROM assignments a
    JOIN candidates c ON a.candidate_id = c.id
    JOIN locations l  ON a.location_id  = l.id
    ORDER BY a.date, l.name, c.name
  `);

  res.render('admin/dashboard', {
    settings,
    stats: { candidateCount, submittedCount, locationCount, assignmentCount },
    scheduleByCandidate,
    allAssignments
  });
});

// ─── Settings ──────────────────────────────────────
router.get('/settings', requireAdmin, (req, res) => {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const admins = db.queryAll('SELECT id, name, email, is_super, created_at FROM admins ORDER BY is_super DESC, name');
  res.render('admin/settings', {
    settings, admins,
    success: req.query.success || null,
    error:   req.query.error   || null,
    announce: !!req.query.announce
  });
});

router.post('/settings', requireAdmin, (req, res) => {
  const {
    schedule_start_date, schedule_end_date, input_deadline,
    lookback_window, lookback_type,
    duty_reminder_enabled, duty_reminder_days_first, duty_reminder_days_final
  } = req.body;
  const admins = db.queryAll('SELECT id, name, email, is_super, created_at FROM admins ORDER BY is_super DESC, name');

  if (schedule_start_date && schedule_end_date && schedule_start_date > schedule_end_date) {
    const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
    return res.render('admin/settings', { settings, admins, announce: false, success: null, error: 'Start date must be before end date.' });
  }

  const firstDays = parseInt(duty_reminder_days_first) || 7;
  const finalDays = parseInt(duty_reminder_days_final) || 1;
  if (duty_reminder_enabled && firstDays <= finalDays) {
    const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
    return res.render('admin/settings', { settings, admins, announce: false, success: null,
      error: `First reminder (${firstDays} days out) must be set further out than the final reminder (${finalDays} days out).` });
  }

  // Reset submission flags when any scheduling date changes (new round opened)
  const prev = db.queryOne('SELECT schedule_start_date, schedule_end_date, input_deadline FROM system_settings WHERE id = 1');
  const dateRangeChanged = (schedule_start_date || null) !== (prev.schedule_start_date || null)
                        || (schedule_end_date   || null) !== (prev.schedule_end_date   || null)
                        || (input_deadline      || null) !== (prev.input_deadline      || null);

  db.run(
    `UPDATE system_settings
     SET schedule_start_date = ?, schedule_end_date = ?, input_deadline = ?,
         lookback_window = ?, lookback_type = ?,
         duty_reminder_enabled = ?, duty_reminder_days_first = ?, duty_reminder_days_final = ?
     WHERE id = 1`,
    [
      schedule_start_date || null,
      schedule_end_date   || null,
      input_deadline      || null,
      parseInt(lookback_window) || 0,
      lookback_type || 'periods',
      duty_reminder_enabled ? 1 : 0,
      firstDays,
      finalDays
    ]
  );
  if (dateRangeChanged) {
    db.run('UPDATE candidates SET has_submitted_input = 0');
  }

  const successMsg = dateRangeChanged
    ? 'Settings saved. Availability submissions have been reset for the new date range.'
    : 'Settings saved successfully.';
  const qs = new URLSearchParams({ success: successMsg });
  if (dateRangeChanged) qs.set('announce', '1');
  res.redirect('/admin/settings?' + qs.toString());
});

router.post('/reset-submissions', requireAdmin, (req, res) => {
  db.run('UPDATE candidates SET has_submitted_input = 0');
  res.redirect('/admin/settings?announce=1&success=' + encodeURIComponent('Availability submissions reset. All deacons now show as not yet responded.'));
});

router.post('/announce-availability', requireAdmin, async (req, res) => {
  const { custom_message } = req.body;
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const candidates = db.queryAll('SELECT * FROM candidates ORDER BY name');
  const APP_URL = process.env.APP_URL || 'http://localhost:3000';

  let sent = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      db.run('INSERT INTO magic_links (candidate_id, token, expires_at) VALUES (?, ?, ?)',
        [candidate.id, token, expiresAt]);
      const magicUrl = `${APP_URL}/candidate/auth?token=${token}`;
      await mailer.sendAvailabilityOpenNotification(
        candidate.email, candidate.name, magicUrl,
        settings.schedule_start_date, settings.schedule_end_date,
        settings.input_deadline, custom_message || null
      );
      sent++;
    } catch (e) {
      console.error(`[announce] Failed for ${candidate.email}:`, e.message);
      failed++;
    }
  }

  const msg = failed > 0
    ? `Sent to ${sent} deacon${sent !== 1 ? 's' : ''}. ${failed} failed — check server logs.`
    : `Announcement sent to ${sent} deacon${sent !== 1 ? 's' : ''}.`;
  res.redirect('/admin/settings?success=' + encodeURIComponent(msg));
});

router.post('/change-password', requireAdmin, (req, res) => {
  const { current_password, new_password } = req.body;
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const adminRow = db.queryOne('SELECT * FROM admins WHERE id = ?', [req.session.admin.id]);
  const admins = db.queryAll('SELECT id, name, email, is_super, created_at FROM admins ORDER BY is_super DESC, name');

  const renderSettings = (success, error) =>
    res.render('admin/settings', { settings, admins, success, error });

  if (!adminRow || !bcryptjs.compareSync(current_password, adminRow.password_hash)) {
    return renderSettings(null, 'Current password is incorrect.');
  }

  if (!new_password || new_password.length < 6) {
    return renderSettings(null, 'New password must be at least 6 characters.');
  }

  const hash = bcryptjs.hashSync(new_password, 10);
  db.run('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, req.session.admin.id]);
  return renderSettings('Password changed successfully.', null);
});

// ─── Admin User Management ──────────────────────────
router.post('/admins/add', requireAdmin, (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password || password.length < 6) {
    return res.redirect('/admin/settings?error=' + encodeURIComponent('All fields required; password must be at least 6 characters.'));
  }

  try {
    const hash = bcryptjs.hashSync(password, 10);
    db.run('INSERT INTO admins (name, email, password_hash, is_super) VALUES (?, ?, ?, 0)',
      [name.trim(), email.trim().toLowerCase(), hash]);
    res.redirect('/admin/settings?success=' + encodeURIComponent(`Admin "${name}" added successfully.`));
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      res.redirect('/admin/settings?error=' + encodeURIComponent('An admin with that email already exists.'));
    } else {
      res.redirect('/admin/settings?error=' + encodeURIComponent(err.message));
    }
  }
});

// ─── Invite Admin by Email ──────────────────────────
router.post('/admins/invite', requireAdmin, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.redirect('/admin/settings?error=' + encodeURIComponent('Name and email are required.'));
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Create or reuse the admin record (password_hash left null until they accept)
  try {
    let admin = db.queryOne('SELECT * FROM admins WHERE email = ?', [normalizedEmail]);
    if (admin && admin.password_hash) {
      return res.redirect('/admin/settings?error=' + encodeURIComponent(
        `${normalizedEmail} is already an active admin. Use "Add Admin" if you want to set a password directly.`
      ));
    }
    if (!admin) {
      db.run('INSERT INTO admins (name, email, password_hash, is_super) VALUES (?, ?, NULL, 0)',
        [name.trim(), normalizedEmail]);
      admin = db.queryOne('SELECT * FROM admins WHERE email = ?', [normalizedEmail]);
    }

    // Generate 48-hour invite token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    db.run(
      'INSERT INTO admin_invite_tokens (admin_id, token, expires_at) VALUES (?, ?, ?)',
      [admin.id, token, expiresAt]
    );

    // Send the invite email
    const inviteLink = await mailer.sendAdminInvite(
      normalizedEmail, name.trim(), req.session.admin.name, token
    );

    // In dev mode mailer returns the link — show it so it's not lost
    const devNote = process.env.SMTP_HOST ? '' :
      ` (SMTP not configured — link logged to server console: ${inviteLink})`;

    res.redirect('/admin/settings?success=' + encodeURIComponent(
      `Invitation sent to ${normalizedEmail}.${devNote} The link expires in 48 hours.`
    ));
  } catch (err) {
    res.redirect('/admin/settings?error=' + encodeURIComponent(err.message));
  }
});

// ─── Accept Admin Invite ────────────────────────────
router.get('/accept-invite', (req, res) => {
  const { token } = req.query;
  if (!token) return res.render('admin/accept-invite', { error: 'No invite token provided.', token: null, name: null });

  const row = db.queryOne(
    `SELECT t.*, a.name, a.email
     FROM admin_invite_tokens t
     JOIN admins a ON t.admin_id = a.id
     WHERE t.token = ?`, [token]
  );

  if (!row) return res.render('admin/accept-invite', { error: 'This invite link is invalid or has already been used.', token: null, name: null });
  if (row.used) return res.render('admin/accept-invite', { error: 'This invite link has already been used.', token: null, name: null });
  if (new Date(row.expires_at) < new Date()) return res.render('admin/accept-invite', { error: 'This invite link has expired. Ask the administrator to send a new one.', token: null, name: null });

  res.render('admin/accept-invite', { error: null, token, name: row.name, email: row.email });
});

router.post('/accept-invite', (req, res) => {
  const { token, password, confirm_password } = req.body;
  if (!token) return res.redirect('/admin/login');

  const row = db.queryOne(
    `SELECT t.*, a.name, a.email, a.id as admin_id
     FROM admin_invite_tokens t
     JOIN admins a ON t.admin_id = a.id
     WHERE t.token = ?`, [token]
  );

  const fail = (msg) => res.render('admin/accept-invite', { error: msg, token, name: row ? row.name : null, email: row ? row.email : null });

  if (!row || row.used) return fail('This invite link is no longer valid.');
  if (new Date(row.expires_at) < new Date()) return fail('This invite link has expired.');
  if (!password || password.length < 6) return fail('Password must be at least 6 characters.');
  if (password !== confirm_password) return fail('Passwords do not match.');

  const hash = bcryptjs.hashSync(password, 10);
  db.run('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, row.admin_id]);
  db.run('UPDATE admin_invite_tokens SET used = 1 WHERE id = ?', [row.id]);

  // Log them in immediately
  req.session.admin = { id: row.admin_id, email: row.email, name: row.name, is_super: 0 };
  res.redirect('/admin/dashboard');
});

router.post('/admins/:id/delete', requireAdmin, (req, res) => {
  const target = db.queryOne('SELECT * FROM admins WHERE id = ?', [req.params.id]);

  if (!target) {
    return res.redirect('/admin/settings?error=Admin not found.');
  }
  if (target.is_super) {
    return res.redirect('/admin/settings?error=' + encodeURIComponent('The super admin cannot be deleted.'));
  }
  if (target.id === req.session.admin.id) {
    return res.redirect('/admin/settings?error=' + encodeURIComponent('You cannot delete your own account.'));
  }

  db.run('DELETE FROM admins WHERE id = ?', [req.params.id]);
  res.redirect('/admin/settings?success=' + encodeURIComponent(`Admin "${target.name}" removed.`));
});

// ─── Candidates ────────────────────────────────────
router.get('/candidates', requireAdmin, (req, res) => {
  const candidates = db.queryAll('SELECT * FROM candidates ORDER BY name');
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  res.render('admin/candidates', { candidates, settings, success: req.query.success || null, error: req.query.error || null });
});

router.post('/candidates/add', requireAdmin, (req, res) => {
  const { name, email, max_shifts } = req.body;

  try {
    db.run('INSERT INTO candidates (name, email, max_shifts) VALUES (?, ?, ?)',
      [name.trim(), email.trim().toLowerCase(), parseInt(max_shifts) || 26]);
    res.redirect('/admin/candidates?success=Candidate added successfully.');
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      res.redirect('/admin/candidates?error=A candidate with that email already exists.');
    } else {
      res.redirect('/admin/candidates?error=' + encodeURIComponent(err.message));
    }
  }
});

router.post('/candidates/upload', requireAdmin, (req, res) => {
  // Wrap multer so its errors redirect gracefully instead of crashing to the error page
  upload.single('csv')(req, res, (multerErr) => {
    if (multerErr) {
      let msg;
      if (multerErr.code === 'LIMIT_FILE_SIZE') {
        msg = 'File too large (limit is 5 MB). Try splitting your list into smaller batches.';
      } else if (multerErr.message && multerErr.message.includes('CSV')) {
        msg = 'Wrong file type — only .csv files are accepted. ' +
              'If you have an Excel file (.xlsx), open it in Excel and use ' +
              'File → Save As → CSV UTF-8 (.csv), then upload that file.';
      } else {
        msg = 'Upload failed: ' + multerErr.message;
      }
      return res.redirect('/admin/candidates?error=' + encodeURIComponent(msg));
    }

    if (!req.file) {
      return res.redirect('/admin/candidates?error=' + encodeURIComponent(
        'No file was selected. Click "Choose File", pick your CSV, then click Upload.'
      ));
    }

    const fs = require('fs');
    let content;
    try {
      content = fs.readFileSync(req.file.path, 'utf-8');
    } finally {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }

    let records;
    try {
      records = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true
      });
    } catch (parseErr) {
      let msg;
      if (parseErr.message.includes('Invalid Record Length') || parseErr.message.includes('column')) {
        msg = 'The CSV has inconsistent columns — some rows have more or fewer values than ' +
              'the header row. Check for stray commas or unmatched quotes in your data. ' +
              `(Detail: ${parseErr.message})`;
      } else {
        msg = 'Could not read the file. Make sure it is saved as a plain .csv file, ' +
              `not .xlsx or .xls. (Detail: ${parseErr.message})`;
      }
      return res.redirect('/admin/candidates?error=' + encodeURIComponent(msg));
    }

    if (records.length === 0) {
      return res.redirect('/admin/candidates?error=' + encodeURIComponent(
        'The file has no data rows. It needs a header row (Name, Email) ' +
        'followed by at least one row of data.'
      ));
    }

    // Case-insensitive column lookup
    const headers = Object.keys(records[0]);
    function col(row, ...names) {
      for (const n of names) {
        const match = headers.find(h => h.toLowerCase() === n.toLowerCase());
        if (match && row[match]) return row[match];
      }
      return '';
    }

    const hasName  = headers.some(h => ['name','full name','fullname','first name'].includes(h.toLowerCase()));
    const hasEmail = headers.some(h => ['email','email address','e-mail'].includes(h.toLowerCase()));

    if (!hasName || !hasEmail) {
      const missing = [];
      if (!hasName)  missing.push('"Name" (or "Full Name")');
      if (!hasEmail) missing.push('"Email" (or "Email Address")');
      return res.redirect('/admin/candidates?error=' + encodeURIComponent(
        `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(' and ')}. ` +
        `Your file has these columns: ${headers.map(h => `"${h}"`).join(', ')}. ` +
        `Rename the columns and try again.`
      ));
    }

    let added = 0;
    const duplicates  = [];   // names already in the system
    const missingData = [];   // rows that lacked a name or email

    db.transaction(() => {
      for (let i = 0; i < records.length; i++) {
        const row       = records[i];
        const name      = col(row, 'Name', 'Full Name', 'FullName', 'First Name');
        const email     = col(row, 'Email', 'Email Address', 'E-mail');
        const maxShifts = parseInt(col(row, 'Max Shifts', 'max_shifts', 'MaxShifts') || '26') || 26;

        if (!name || !email) {
          const label = name || email || `row ${i + 2}`;
          const reason = !name && !email ? 'no name or email'
                       : !name           ? 'missing name'
                                         : 'missing email';
          missingData.push(`${label} (${reason})`);
          continue;
        }

        try {
          db.run('INSERT INTO candidates (name, email, max_shifts) VALUES (?, ?, ?)',
            [name.trim(), email.trim().toLowerCase(), maxShifts]);
          added++;
        } catch (e) {
          duplicates.push(name.trim());
        }
      }
    });

    // Build a detailed, human-readable result
    const parts = [];
    if (added > 0)           parts.push(`✓ ${added} deacon${added !== 1 ? 's' : ''} added.`);
    if (duplicates.length)   {
      const preview = duplicates.slice(0, 5).join(', ') + (duplicates.length > 5 ? ` … and ${duplicates.length - 5} more` : '');
      parts.push(`${duplicates.length} already in system (skipped): ${preview}.`);
    }
    if (missingData.length)  {
      const preview = missingData.slice(0, 3).join('; ') + (missingData.length > 3 ? ` … and ${missingData.length - 3} more` : '');
      parts.push(`${missingData.length} row${missingData.length !== 1 ? 's' : ''} skipped — missing data: ${preview}.`);
    }
    if (added === 0 && !duplicates.length && !missingData.length) {
      parts.push('No rows were processed. Check that your file has data below the header row.');
    }

    const param = added > 0 ? 'success' : 'error';
    res.redirect(`/admin/candidates?${param}=` + encodeURIComponent(parts.join('  ')));
  });
});

router.post('/candidates/:id/edit', requireAdmin, (req, res) => {
  const { name, email, max_shifts } = req.body;

  try {
    db.run('UPDATE candidates SET name = ?, email = ?, max_shifts = ? WHERE id = ?',
      [name.trim(), email.trim().toLowerCase(), parseInt(max_shifts) || 26, req.params.id]);
    res.redirect('/admin/candidates?success=Candidate updated.');
  } catch (err) {
    res.redirect('/admin/candidates?error=' + encodeURIComponent(err.message));
  }
});

router.post('/candidates/:id/delete', requireAdmin, (req, res) => {
  db.run('DELETE FROM blackout_dates WHERE candidate_id = ?', [req.params.id]);
  db.run('DELETE FROM assignments WHERE candidate_id = ?', [req.params.id]);
  db.run('DELETE FROM magic_links WHERE candidate_id = ?', [req.params.id]);
  db.run('DELETE FROM candidates WHERE id = ?', [req.params.id]);
  res.redirect('/admin/candidates?success=Candidate deleted.');
});

// ─── Locations ─────────────────────────────────────
router.get('/locations', requireAdmin, (req, res) => {
  const locations = db.queryAll('SELECT * FROM locations ORDER BY name');
  res.render('admin/locations', { locations, success: req.query.success || null, error: req.query.error || null });
});

router.post('/locations/add', requireAdmin, (req, res) => {
  const { name, slots_per_day } = req.body;

  try {
    db.run('INSERT INTO locations (name, slots_per_day) VALUES (?, ?)',
      [name.trim(), parseInt(slots_per_day) || 1]);
    res.redirect('/admin/locations?success=Location added.');
  } catch (err) {
    res.redirect('/admin/locations?error=' + encodeURIComponent(err.message));
  }
});

router.post('/locations/:id/edit', requireAdmin, (req, res) => {
  const { name, slots_per_day } = req.body;
  db.run('UPDATE locations SET name = ?, slots_per_day = ? WHERE id = ?',
    [name.trim(), parseInt(slots_per_day) || 1, req.params.id]);
  res.redirect('/admin/locations?success=Location updated.');
});

router.post('/locations/:id/delete', requireAdmin, (req, res) => {
  db.run('DELETE FROM assignments WHERE location_id = ?', [req.params.id]);
  db.run('DELETE FROM locations WHERE id = ?', [req.params.id]);
  res.redirect('/admin/locations?success=Location deleted.');
});

// ─── Schedule ──────────────────────────────────────
router.get('/schedule', requireAdmin, (req, res) => {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const locations = db.queryAll('SELECT * FROM locations ORDER BY name');
  const candidates = db.queryAll('SELECT * FROM candidates ORDER BY name');

  const assignments = db.queryAll(`
    SELECT a.id, a.date, a.candidate_id, a.location_id, c.name as candidate_name, l.name as location_name
    FROM assignments a
    JOIN candidates c ON a.candidate_id = c.id
    JOIN locations l ON a.location_id = l.id
    ORDER BY a.date, l.name, c.name
  `);

  const scheduleGrid = {};
  for (const a of assignments) {
    if (!scheduleGrid[a.date]) scheduleGrid[a.date] = {};
    if (!scheduleGrid[a.date][a.location_id]) scheduleGrid[a.date][a.location_id] = [];
    scheduleGrid[a.date][a.location_id].push(a);
  }

  // Show archive reminder banner when live assignments differ from the latest archive content
  const lastArchive = db.queryOne('SELECT * FROM schedule_archives ORDER BY created_at DESC LIMIT 1');
  const liveSig = assignments.map(a => `${a.date}:${a.candidate_id}:${a.location_id}`).sort().join('|');
  const archiveSig = lastArchive
    ? db.queryAll(
        `SELECT aa.date, c.id AS candidate_id, l.id AS location_id
         FROM archive_assignments aa
         JOIN candidates c ON c.email = aa.candidate_email
         JOIN locations  l ON l.name  = aa.location_name
         WHERE aa.archive_id = ?`,
        [lastArchive.id]
      ).map(r => `${r.date}:${r.candidate_id}:${r.location_id}`).sort().join('|')
    : '';
  const showArchiveBanner = assignments.length > 0 && liveSig !== archiveSig;

  res.render('admin/schedule', {
    settings,
    locations,
    candidates,
    scheduleGrid,
    showArchiveBanner,
    lastArchive: lastArchive || null,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// ─── Archives ──────────────────────────────────────
router.get('/archives', requireAdmin, (req, res) => {
  const archives = db.queryAll('SELECT * FROM schedule_archives ORDER BY created_at DESC');
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');

  // Mark which archives fall within the current lookback window
  const lookbackWindow = parseInt(settings.lookback_window) || 0;
  const lookbackType   = settings.lookback_type || 'periods';

  let inLookbackIds = new Set();
  if (lookbackWindow > 0) {
    let windowArchives;
    if (lookbackType === 'months') {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - lookbackWindow);
      windowArchives = db.queryAll(
        'SELECT id FROM schedule_archives WHERE created_at >= ? ORDER BY created_at DESC',
        [cutoff.toISOString().slice(0, 19)]
      );
    } else {
      windowArchives = db.queryAll(
        'SELECT id FROM schedule_archives ORDER BY created_at DESC LIMIT ?',
        [lookbackWindow]
      );
    }
    inLookbackIds = new Set(windowArchives.map(a => a.id));
  }

  const archivesWithFlag = archives.map(a => ({ ...a, inLookback: inLookbackIds.has(a.id) }));

  res.render('admin/archives', {
    archives: archivesWithFlag,
    settings,
    lookbackWindow,
    lookbackType,
    success: req.query.success || null,
    error:   req.query.error   || null
  });
});

router.get('/archives/:id', requireAdmin, (req, res) => {
  const archive = db.queryOne('SELECT * FROM schedule_archives WHERE id = ?', [req.params.id]);
  if (!archive) return res.redirect('/admin/archives?error=Archive+not+found.');

  const assignments = db.queryAll(
    'SELECT * FROM archive_assignments WHERE archive_id = ? ORDER BY date, location_name, candidate_name',
    [archive.id]
  );

  // Group by date + location for the schedule grid
  const grid = {};
  for (const a of assignments) {
    if (!grid[a.date]) grid[a.date] = {};
    if (!grid[a.date][a.location_name]) grid[a.date][a.location_name] = [];
    grid[a.date][a.location_name].push(a.candidate_name);
  }

  // Per-candidate totals
  const byCandidateMap = {};
  for (const a of assignments) {
    const key = a.candidate_email;
    if (!byCandidateMap[key]) byCandidateMap[key] = { name: a.candidate_name, email: a.candidate_email, count: 0 };
    byCandidateMap[key].count++;
  }
  const byCandidate = Object.values(byCandidateMap).sort((a, b) => a.name.localeCompare(b.name));

  // Unique location names in this archive
  const locationNames = [...new Set(assignments.map(a => a.location_name))].sort();

  res.render('admin/archive-detail', { archive, grid, byCandidate, locationNames });
});

router.post('/archives', requireAdmin, (req, res) => {
  const { label, notes } = req.body;
  if (!label || !label.trim()) {
    return res.redirect('/admin/schedule?error=' + encodeURIComponent('A period label is required to create an archive.'));
  }

  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const assignments = db.queryAll(`
    SELECT a.date, l.name AS location_name, c.name AS candidate_name, c.email AS candidate_email
    FROM assignments a
    JOIN candidates c ON a.candidate_id = c.id
    JOIN locations l  ON a.location_id  = l.id
  `);

  if (assignments.length === 0) {
    return res.redirect('/admin/schedule?error=' + encodeURIComponent('There are no assignments to archive. Generate a schedule first.'));
  }

  db.transaction(() => {
    const result = db.run(
      `INSERT INTO schedule_archives (label, notes, period_start, period_end, input_deadline, assignment_count, created_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        label.trim(),
        notes ? notes.trim() : null,
        settings.schedule_start_date || null,
        settings.schedule_end_date   || null,
        settings.input_deadline      || null,
        assignments.length,
        req.session.admin.name
      ]
    );
    const archiveId = result.lastInsertRowid;

    for (const a of assignments) {
      db.run(
        'INSERT INTO archive_assignments (archive_id, date, location_name, candidate_name, candidate_email) VALUES (?, ?, ?, ?, ?)',
        [archiveId, a.date, a.location_name, a.candidate_name, a.candidate_email]
      );
    }
  });

  res.redirect('/admin/archives?success=' + encodeURIComponent(`Schedule archived as "${label.trim()}".`));
});

router.post('/archives/:id/delete', requireAdmin, (req, res) => {
  const archive = db.queryOne('SELECT * FROM schedule_archives WHERE id = ?', [req.params.id]);
  if (!archive) return res.redirect('/admin/archives?error=Archive+not+found.');
  db.run('DELETE FROM schedule_archives WHERE id = ?', [req.params.id]);
  res.redirect('/admin/archives?success=' + encodeURIComponent(`Archive "${archive.label}" deleted.`));
});

// ─── Upcoming (Draft) Schedule ─────────────────────
router.get('/upcoming', requireAdmin, (req, res) => {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const locations = db.queryAll('SELECT * FROM locations ORDER BY name');
  const candidates = db.queryAll('SELECT * FROM candidates ORDER BY name');

  const draftAssignments = db.queryAll(`
    SELECT d.id, d.date, d.candidate_id, d.location_id,
           c.name AS candidate_name, l.name AS location_name
    FROM draft_assignments d
    JOIN candidates c ON d.candidate_id = c.id
    JOIN locations l ON d.location_id = l.id
    ORDER BY d.date, l.name, c.name
  `);

  const draftGrid = {};
  for (const a of draftAssignments) {
    if (!draftGrid[a.date]) draftGrid[a.date] = {};
    if (!draftGrid[a.date][a.location_id]) draftGrid[a.date][a.location_id] = [];
    draftGrid[a.date][a.location_id].push(a);
  }

  // Count deacons who have submitted at least one blackout for the draft period
  let submittedDraftCount;
  if (settings.draft_start_date && settings.draft_end_date) {
    const rows = db.queryAll(
      `SELECT DISTINCT candidate_id FROM blackout_dates
       WHERE is_system_generated = 0 AND date >= ? AND date <= ?`,
      [settings.draft_start_date, settings.draft_end_date]
    );
    submittedDraftCount = rows.length;
  }

  const liveAssignmentCount = (db.queryOne('SELECT COUNT(*) as cnt FROM assignments') || {}).cnt || 0;

  res.render('admin/upcoming', {
    settings,
    locations,
    candidates,
    draftGrid,
    submittedDraftCount,
    liveAssignmentCount,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

router.post('/draft/settings', requireAdmin, (req, res) => {
  const { draft_start_date, draft_end_date, draft_input_deadline, draft_visible_to_candidates } = req.body;

  if (draft_start_date && draft_end_date && draft_start_date > draft_end_date) {
    return res.redirect('/admin/upcoming?error=' + encodeURIComponent('Start date must be before end date.'));
  }

  db.run(
    `UPDATE system_settings
     SET draft_start_date = ?, draft_end_date = ?, draft_input_deadline = ?,
         draft_visible_to_candidates = ?
     WHERE id = 1`,
    [
      draft_start_date || null,
      draft_end_date   || null,
      draft_input_deadline || null,
      draft_visible_to_candidates ? 1 : 0
    ]
  );

  res.redirect('/admin/upcoming?success=' + encodeURIComponent('Upcoming schedule settings saved.'));
});

router.post('/draft/activate', requireAdmin, (req, res) => {
  const { archive_label, archive_notes } = req.body;

  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const draftAssignments = db.queryAll(`
    SELECT d.date, l.name AS location_name, c.name AS candidate_name, c.email AS candidate_email
    FROM draft_assignments d
    JOIN candidates c ON d.candidate_id = c.id
    JOIN locations l ON d.location_id = l.id
  `);

  if (draftAssignments.length === 0) {
    return res.redirect('/admin/upcoming?error=' + encodeURIComponent('The upcoming schedule has no assignments. Generate it first before activating.'));
  }

  const liveAssignments = db.queryAll(`
    SELECT a.date, l.name AS location_name, c.name AS candidate_name, c.email AS candidate_email
    FROM assignments a
    JOIN candidates c ON a.candidate_id = c.id
    JOIN locations l ON a.location_id = l.id
  `);

  if (liveAssignments.length > 0 && (!archive_label || !archive_label.trim())) {
    return res.redirect('/admin/upcoming?error=' + encodeURIComponent(
      'An archive label is required because the current schedule has assignments. ' +
      'Provide a label so the current schedule is saved before being replaced.'
    ));
  }

  db.transaction(() => {
    // Archive the current live schedule if it has assignments
    if (liveAssignments.length > 0 && archive_label && archive_label.trim()) {
      const result = db.run(
        `INSERT INTO schedule_archives (label, notes, period_start, period_end, input_deadline, assignment_count, created_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          archive_label.trim(),
          archive_notes ? archive_notes.trim() : null,
          settings.schedule_start_date || null,
          settings.schedule_end_date   || null,
          settings.input_deadline      || null,
          liveAssignments.length,
          req.session.admin.name
        ]
      );
      const archiveId = result.lastInsertRowid;
      for (const a of liveAssignments) {
        db.run(
          'INSERT INTO archive_assignments (archive_id, date, location_name, candidate_name, candidate_email) VALUES (?, ?, ?, ?, ?)',
          [archiveId, a.date, a.location_name, a.candidate_name, a.candidate_email]
        );
      }
    }

    // Promote draft to live
    db.run('DELETE FROM assignments');
    const draftRows = db.queryAll('SELECT * FROM draft_assignments');
    for (const d of draftRows) {
      db.run('INSERT INTO assignments (candidate_id, location_id, date) VALUES (?, ?, ?)',
        [d.candidate_id, d.location_id, d.date]);
    }

    // Promote draft settings to live settings
    db.run(
      `UPDATE system_settings
       SET schedule_start_date = draft_start_date,
           schedule_end_date   = draft_end_date,
           input_deadline      = draft_input_deadline,
           draft_start_date    = NULL,
           draft_end_date      = NULL,
           draft_input_deadline = NULL,
           draft_visible_to_candidates = 0
       WHERE id = 1`
    );

    // Clear draft
    db.run('DELETE FROM draft_assignments');
  });

  res.redirect('/admin/schedule?success=' + encodeURIComponent('Upcoming schedule activated! It is now the live schedule.'));
});

router.post('/draft/clear', requireAdmin, (req, res) => {
  db.run('DELETE FROM draft_assignments');
  db.run(
    `UPDATE system_settings
     SET draft_start_date = NULL, draft_end_date = NULL,
         draft_input_deadline = NULL, draft_visible_to_candidates = 0
     WHERE id = 1`
  );
  res.redirect('/admin/upcoming?success=' + encodeURIComponent('Upcoming schedule cleared.'));
});

// ─── Sunday Duty Reminders settings page ───────────
router.get('/duty-reminders', requireAdmin, (req, res) => {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const recentLogs = db.queryAll(
    'SELECT * FROM sunday_reminder_log ORDER BY sent_at DESC LIMIT 5'
  );

  // Compute upcoming Sunday in Eastern Time for display
  const etParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'long'
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  const etDateStr = `${etParts.year}-${etParts.month}-${etParts.day}`;
  const [y, m, d] = etDateStr.split('-').map(Number);
  const etDate = new Date(y, m - 1, d);
  const daysUntilSunday = (7 - etDate.getDay()) % 7;
  const upcoming = new Date(y, m - 1, d + daysUntilSunday);
  const upcomingSundayDisplay = upcoming.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  res.render('admin/duty-reminders', {
    settings,
    recentLogs,
    upcomingSundayDisplay,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

router.post('/duty-reminders', requireAdmin, (req, res) => {
  const {
    sunday_reminder_enabled,
    sunday_reminder_day,
    sunday_reminder_hour,
    sunday_email_subject,
    sunday_email_body,
    sunday_email_cc
  } = req.body;

  db.run(
    `UPDATE system_settings
     SET sunday_reminder_enabled = ?,
         sunday_reminder_day = ?,
         sunday_reminder_hour = ?,
         sunday_email_subject = ?,
         sunday_email_body = ?,
         sunday_email_cc = ?
     WHERE id = 1`,
    [
      sunday_reminder_enabled ? 1 : 0,
      parseInt(sunday_reminder_day) || 4,
      parseInt(sunday_reminder_hour) || 14,
      sunday_email_subject || 'Duty Deacon Reminder',
      sunday_email_body || '',
      sunday_email_cc || 'jim.muzzall@gmail.com,ashley@mcleanpres.org,jvogan@mcleanpres.org'
    ]
  );

  res.redirect('/admin/duty-reminders?success=' + encodeURIComponent('Settings saved successfully.'));
});

module.exports = router;
