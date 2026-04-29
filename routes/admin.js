const express = require('express');
const router = express.Router();
const bcryptjs = require('bcryptjs');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const path = require('path');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

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

  res.render('admin/dashboard', {
    settings,
    stats: { candidateCount, submittedCount, locationCount, assignmentCount }
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
      trim: true
    });

    let added = 0;
    let skipped = 0;

    db.transaction(() => {
      for (const row of records) {
        const name = row['Name'] || row['name'] || '';
        const email = row['Email'] || row['email'] || '';
        const maxShifts = parseInt(row['Max Shifts'] || row['max_shifts'] || '4') || 4;

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

    res.redirect(`/admin/candidates?success=${added} candidates imported, ${skipped} skipped.`);
  } catch (err) {
    res.redirect('/admin/candidates?error=CSV parse error: ' + encodeURIComponent(err.message));
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
