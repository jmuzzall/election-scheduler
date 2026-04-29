const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { generateSchedule } = require('../services/scheduler');
const mailer = require('../services/mailer');

// ─── Generate Schedule ─────────────────────────────
router.post('/generate-schedule', requireAdmin, (req, res) => {
  try {
    const result = generateSchedule();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── Manual Assignment Override ────────────────────
router.post('/assignments/add', requireAdmin, (req, res) => {
  const { candidate_id, location_id, date } = req.body;

  try {
    const existing = db.queryOne(
      'SELECT * FROM assignments WHERE candidate_id = ? AND date = ?',
      [candidate_id, date]
    );

    if (existing) {
      return res.status(400).json({ error: 'Candidate is already assigned on this date.' });
    }

    db.run('INSERT INTO assignments (candidate_id, location_id, date) VALUES (?, ?, ?)',
      [candidate_id, location_id, date]);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/assignments/:id/delete', requireAdmin, (req, res) => {
  db.run('DELETE FROM assignments WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

router.post('/assignments/:id/update', requireAdmin, (req, res) => {
  const { candidate_id } = req.body;

  try {
    const assignment = db.queryOne('SELECT * FROM assignments WHERE id = ?', [req.params.id]);
    if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });

    const conflict = db.queryOne(
      'SELECT * FROM assignments WHERE candidate_id = ? AND date = ? AND id != ?',
      [candidate_id, assignment.date, req.params.id]
    );

    if (conflict) {
      return res.status(400).json({ error: 'Candidate is already assigned on this date.' });
    }

    db.run('UPDATE assignments SET candidate_id = ? WHERE id = ?', [candidate_id, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Send Magic Links ──────────────────────────────
router.post('/send-magic-link/:candidateId', requireAdmin, async (req, res) => {
  const candidate = db.queryOne('SELECT * FROM candidates WHERE id = ?', [req.params.candidateId]);

  if (!candidate) {
    return res.status(404).json({ error: 'Candidate not found.' });
  }

  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  db.run('INSERT INTO magic_links (candidate_id, token, expires_at) VALUES (?, ?, ?)',
    [candidate.id, token, expiresAt]);

  try {
    const link = await mailer.sendMagicLink(candidate.email, candidate.name, token);
    res.json({ success: true, message: `Magic link sent to ${candidate.email}`, link });
  } catch (err) {
    console.error('Failed to send magic link:', err);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

router.post('/send-all-magic-links', requireAdmin, async (req, res) => {
  const candidates = db.queryAll('SELECT * FROM candidates');

  let sent = 0;
  let failed = 0;
  const links = [];

  for (const candidate of candidates) {
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    db.run('INSERT INTO magic_links (candidate_id, token, expires_at) VALUES (?, ?, ?)',
      [candidate.id, token, expiresAt]);

    try {
      const link = await mailer.sendMagicLink(candidate.email, candidate.name, token);
      links.push({ name: candidate.name, email: candidate.email, link });
      sent++;
    } catch (err) {
      console.error(`Failed to send to ${candidate.email}:`, err);
      failed++;
    }
  }

  res.json({ success: true, sent, failed, total: candidates.length, links });
});

// ─── Export Schedule to Excel ──────────────────────
router.get('/export-schedule', requireAdmin, async (req, res) => {
  const ExcelJS = require('exceljs');
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const locations = db.queryAll('SELECT * FROM locations ORDER BY name');

  const assignments = db.queryAll(`
    SELECT a.date, a.location_id, c.name as candidate_name, l.name as location_name
    FROM assignments a
    JOIN candidates c ON a.candidate_id = c.id
    JOIN locations l ON a.location_id = l.id
    ORDER BY a.date, l.name, c.name
  `);

  // Group by date
  const scheduleByDate = {};
  for (const a of assignments) {
    if (!scheduleByDate[a.date]) scheduleByDate[a.date] = {};
    if (!scheduleByDate[a.date][a.location_name]) scheduleByDate[a.date][a.location_name] = [];
    scheduleByDate[a.date][a.location_name].push(a.candidate_name);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Election Scheduler';
  const sheet = workbook.addWorksheet('Schedule');

  // Header row
  const headerRow = ['Date', ...locations.map(l => l.name)];
  const header = sheet.addRow(headerRow);
  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF2C3E50' }
  };
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
  header.alignment = { horizontal: 'center', vertical: 'middle' };

  // Set column widths
  sheet.getColumn(1).width = 16;
  locations.forEach((l, i) => {
    sheet.getColumn(i + 2).width = 25;
  });

  // Data rows
  const dates = Object.keys(scheduleByDate).sort();
  for (const date of dates) {
    const dayName = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });
    const formattedDate = `${dayName} ${date}`;

    const rowData = [formattedDate];
    for (const loc of locations) {
      const names = scheduleByDate[date][loc.name] || [];
      rowData.push(names.join(', '));
    }

    const row = sheet.addRow(rowData);
    row.alignment = { vertical: 'top', wrapText: true };

    if (dates.indexOf(date) % 2 === 0) {
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF0F3F4' }
      };
    }
  }

  // Add borders
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="schedule-${new Date().toISOString().split('T')[0]}.xlsx"`);

  await workbook.xlsx.write(res);
  res.end();
});

// ─── Export Blackout Dates to Excel ───────────────
router.get('/export-blackouts', requireAdmin, async (req, res) => {
  const ExcelJS = require('exceljs');

  // Fetch every blackout date with the candidate's name, sorted by date then name
  const rows = db.queryAll(`
    SELECT b.date, c.name AS candidate_name
    FROM blackout_dates b
    JOIN candidates c ON b.candidate_id = c.id
    ORDER BY b.date ASC, c.name ASC
  `);

  // Group candidates under each date
  const byDate = {};
  for (const row of rows) {
    if (!byDate[row.date]) byDate[row.date] = [];
    byDate[row.date].push(row.candidate_name);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Election Scheduler';

  // ── Sheet 1: By Date (one row per date) ─────────
  const byDateSheet = workbook.addWorksheet('By Date');

  const hdr1 = byDateSheet.addRow(['Date', 'Day', '# Unavailable', 'Candidates Unavailable']);
  hdr1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A5276' } };
  hdr1.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
  hdr1.alignment = { horizontal: 'center', vertical: 'middle' };
  byDateSheet.getColumn(1).width = 14;
  byDateSheet.getColumn(2).width = 12;
  byDateSheet.getColumn(3).width = 16;
  byDateSheet.getColumn(4).width = 60;

  const sortedDates = Object.keys(byDate).sort();
  sortedDates.forEach((date, idx) => {
    const names = byDate[date];
    const dayName = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });
    const row = byDateSheet.addRow([date, dayName, names.length, names.join(', ')]);
    row.alignment = { vertical: 'top', wrapText: true };
    if (idx % 2 === 0) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F4FD' } };
    }
    row.eachCell(cell => {
      cell.border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' }
      };
    });
  });

  // ── Sheet 2: By Candidate (one row per candidate) ─
  const byCandSheet = workbook.addWorksheet('By Candidate');

  const candidates = db.queryAll('SELECT id, name FROM candidates ORDER BY name');
  const hdr2 = byCandSheet.addRow(['Candidate', '# Blackout Dates', 'Blackout Dates']);
  hdr2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A5276' } };
  hdr2.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
  hdr2.alignment = { horizontal: 'center', vertical: 'middle' };
  byCandSheet.getColumn(1).width = 28;
  byCandSheet.getColumn(2).width = 18;
  byCandSheet.getColumn(3).width = 70;

  const blackoutsByCandidate = db.queryAll(`
    SELECT c.name AS candidate_name, GROUP_CONCAT(b.date, ', ') AS dates, COUNT(*) AS cnt
    FROM blackout_dates b
    JOIN candidates c ON b.candidate_id = c.id
    GROUP BY b.candidate_id
    ORDER BY c.name ASC
  `);

  // Also include candidates with zero blackout dates
  const candidatesWithBlackouts = new Set(blackoutsByCandidate.map(r => r.candidate_name));
  const allCandidateRows = [
    ...blackoutsByCandidate,
    ...candidates
      .filter(c => !candidatesWithBlackouts.has(c.name))
      .map(c => ({ candidate_name: c.name, cnt: 0, dates: '(none)' }))
  ].sort((a, b) => a.candidate_name.localeCompare(b.candidate_name));

  allCandidateRows.forEach((r, idx) => {
    const row = byCandSheet.addRow([r.candidate_name, r.cnt, r.dates]);
    row.alignment = { vertical: 'top', wrapText: true };
    if (idx % 2 === 0) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F4FD' } };
    }
    row.eachCell(cell => {
      cell.border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' }
      };
    });
  });

  const today = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="blackout-dates-${today}.xlsx"`);

  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
