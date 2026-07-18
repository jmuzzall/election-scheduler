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
  res.render('admin/settings', { settings, admins, success: req.query.success || null, error: req.query.error || null });
});

router.post('/settings', requireAdmin, (req, res) => {
  const { schedule_start_date, schedule_end_date, input_deadline } = req.body;
  const admins = db.queryAll('SELECT id, name, email, is_super, created_at FROM admins ORDER BY is_super DESC, name');

  if (schedule_start_date && schedule_end_date && schedule_start_date > schedule_end_date) {
    const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
    return res.render('admin/settings', { settings, admins, success: null, error: 'Start date must be before end date.' });
  }

  db.run(
    'UPDATE system_settings SET schedule_start_date = ?, schedule_end_date = ?, input_deadline = ? WHERE id = 1',
    [schedule_start_date || null, schedule_end_date || null, input_deadline || null]
  );

  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  res.render('admin/settings', { settings, admins, success: 'Settings saved successfully.', error: null });
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

router.post('/candidates/upload', requireAdmin, upload.single('csv'), (req, res) => {
  if (!req.file) {
    return res.redirect('/admin/candidates?error=No file uploaded.');
  }

  const fs = require('fs');
  const content = fs.readFileSync(req.file.path, 'utf-8');
  fs.unlinkSync(req.file.path);

  try {
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true           // strip Excel BOM characters automatically
    });

    if (records.length === 0) {
      return res.redirect('/admin/candidates?error=' + encodeURIComponent(
        'The CSV file appears to be empty or has no data rows.'
      ));
    }

    // Build a case-insensitive column lookup from the actual headers
    const headers = Object.keys(records[0]);
    function col(row, ...candidates) {
      for (const c of candidates) {
        const match = headers.find(h => h.toLowerCase() === c.toLowerCase());
        if (match && row[match]) return row[match];
      }
      return '';
    }

    // Detect which name/email columns are present (for the error message)
    const hasName  = headers.some(h => ['name','full name','fullname','first name'].includes(h.toLowerCase()));
    const hasEmail = headers.some(h => ['email','email address','e-mail'].includes(h.toLowerCase()));

    if (!hasName || !hasEmail) {
      return res.redirect('/admin/candidates?error=' + encodeURIComponent(
        `CSV is missing required columns. Found: [${headers.join(', ')}]. ` +
        `Need a column called "Name" (or "Full Name") and one called "Email" (or "Email Address").`
      ));
    }

    let added = 0;
    let skipped = 0;

    db.transaction(() => {
      for (const row of records) {
        const name      = col(row, 'Name', 'Full Name', 'FullName', 'First Name');
        const email     = col(row, 'Email', 'Email Address', 'E-mail');
        const maxShifts = parseInt(col(row, 'Max Shifts', 'max_shifts', 'MaxShifts') || '26') || 26;

        if (!name || !email) { skipped++; continue; }

        try {
          db.run('INSERT INTO candidates (name, email, max_shifts) VALUES (?, ?, ?)',
            [name.trim(), email.trim().toLowerCase(), maxShifts]);
          added++;
        } catch (e) {
          skipped++; // Duplicate email
        }
      }
    });

    res.redirect('/admin/candidates?success=' + encodeURIComponent(
      `${added} deacon(s) imported successfully, ${skipped} skipped (duplicate or missing data).`
    ));
  } catch (err) {
    res.redirect('/admin/candidates?error=' + encodeURIComponent(
      'CSV parse error: ' + err.message +
      ' — Make sure the file is saved as CSV (not .xlsx) and has Name and Email columns.'
    ));
  }
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

  // Group assignments by date then location
  const scheduleGrid = {};
  for (const a of assignments) {
    if (!scheduleGrid[a.date]) scheduleGrid[a.date] = {};
    if (!scheduleGrid[a.date][a.location_id]) scheduleGrid[a.date][a.location_id] = [];
    scheduleGrid[a.date][a.location_id].push(a);
  }

  res.render('admin/schedule', {
    settings,
    locations,
    candidates,
    scheduleGrid,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

module.exports = router;
