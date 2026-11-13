const db = require('../db');
const { CAMPUSES, campusOf } = require('./campus');

// ─── Date helpers ───────────────────────────────────────────────────────────

function getSundays(startDate, endDate) {
  const sundays = [];
  const current = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (current.getDay() !== 0 && current <= end) current.setDate(current.getDate() + 1);
  while (current <= end) {
    sundays.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 7);
  }
  return sundays;
}

function getAllDates(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// ─── Pre-processing ─────────────────────────────────────────────────────────

function preprocessCandidates(settings) {
  const now = new Date();
  const deadline = settings.input_deadline ? new Date(settings.input_deadline) : null;
  if (!deadline || now <= deadline) return;

  const unsubmitted = db.queryAll('SELECT id FROM candidates WHERE has_submitted_input = 0');
  if (unsubmitted.length === 0) return;

  const allDates = getAllDates(settings.schedule_start_date, settings.schedule_end_date);
  const nonSundayDates = allDates.filter(d => new Date(d + 'T00:00:00').getDay() !== 0);

  db.transaction(() => {
    for (const candidate of unsubmitted) {
      for (const date of nonSundayDates) {
        try {
          db.run(
            'INSERT INTO blackout_dates (candidate_id, date, is_system_generated) VALUES (?, ?, 1)',
            [candidate.id, date]
          );
        } catch (e) { /* ignore duplicates */ }
      }
    }
  });
  console.log(`Pre-processed ${unsubmitted.length} candidates who missed the deadline.`);
}

// ─── Core assignment helper ──────────────────────────────────────────────────

function assign(candidate, locationId, sunday, sundayIndex, shiftCounts, dailyAssigned, lastServedIndex, allAssignments) {
  allAssignments.push({ candidate_id: candidate.id, location_id: locationId, date: sunday });
  shiftCounts[candidate.id]++;
  dailyAssigned[sunday].add(candidate.id);
  lastServedIndex[candidate.id] = sundayIndex;
}

// ─── Main schedule generator ─────────────────────────────────────────────────

/**
 * Balanced scheduling algorithm — three phases:
 *
 * Phase 1 — Proportional greedy fill
 *   For each slot, candidates are sorted by their *utilization ratio*
 *   (shifts assigned so far ÷ effective capacity), lowest first.
 *   "Effective capacity" = min(max_shifts, available Sundays), so people
 *   with fewer available dates are not over-loaded relative to their window.
 *
 *   Three sub-passes per slot, each relaxing one more soft constraint:
 *     1a. Under cap  + no back-to-back  (ideal)
 *     1b. Under cap  + back-to-back OK  (relax consecutive constraint)
 *     1c. Over cap   + fewest shifts    (relax max_shifts cap)
 *
 *   Blackout dates are a hard constraint and are never overridden.
 *   One assignment per person per Sunday is also a hard constraint.
 *
 * Phase 2 — Swap improvement
 *   Iteratively find the most over-utilized candidate and try to hand
 *   one of their assignments to the most under-utilized candidate who
 *   can legally take it (not blacked out, not already serving that Sunday,
 *   not creating a back-to-back). Repeats until no further improvement
 *   is possible or the iteration cap is reached.
 */
// ─── Shared scheduling core ──────────────────────────────────────────────────

function _runCore(startDate, endDate, settings, targetTable) {
  const lookbackWindow = parseInt(settings.lookback_window) || 0;
  const lookbackType   = settings.lookback_type || 'periods';

  const historicalShifts = {};
  const historicalCap    = {};
  let   historicalPeriods = [];

  const tempCandidates = db.queryAll('SELECT * FROM candidates');
  tempCandidates.forEach(c => { historicalShifts[c.id] = 0; historicalCap[c.id] = 0; });

  if (lookbackWindow > 0) {
    let archives;
    if (lookbackType === 'months') {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - lookbackWindow);
      archives = db.queryAll(
        `SELECT * FROM schedule_archives WHERE created_at >= ? ORDER BY created_at DESC`,
        [cutoff.toISOString().slice(0, 19)]
      );
    } else {
      archives = db.queryAll(
        `SELECT * FROM schedule_archives ORDER BY created_at DESC LIMIT ?`,
        [lookbackWindow]
      );
    }

    historicalPeriods = archives.map(a => a.label);

    const emailToId = {};
    tempCandidates.forEach(c => { emailToId[c.email.toLowerCase()] = c.id; });

    const maxShiftsById = {};
    tempCandidates.forEach(c => { maxShiftsById[c.id] = c.max_shifts || 1; });

    for (const archive of archives) {
      const counts = db.queryAll(
        `SELECT candidate_email, COUNT(*) as cnt FROM archive_assignments
         WHERE archive_id = ? GROUP BY candidate_email`,
        [archive.id]
      );
      for (const row of counts) {
        const cid = emailToId[(row.candidate_email || '').toLowerCase()];
        if (cid !== undefined) {
          historicalShifts[cid] += row.cnt;
          historicalCap[cid]    += (maxShiftsById[cid] || 1);
        }
      }
    }

    if (archives.length > 0) {
      console.log(`[Scheduler] Historical fairness: ${archives.length} archive(s) — ${historicalPeriods.join(', ')}`);
    }
  }

  const sundays = getSundays(startDate, endDate);
  if (sundays.length === 0) throw new Error('No Sundays found in the configured date range.');

  const locations = db.queryAll('SELECT * FROM locations ORDER BY name');
  if (locations.length === 0) throw new Error('No locations configured. Add locations before generating a schedule.');

  const candidates = db.queryAll('SELECT * FROM candidates');
  if (candidates.length === 0) throw new Error('No candidates found. Upload candidates before generating a schedule.');

  const blackoutRows = db.queryAll('SELECT candidate_id, date FROM blackout_dates');
  const blackoutSet = new Set(blackoutRows.map(r => `${r.candidate_id}-${r.date}`));

  const availableCount = {};
  const effectiveCap = {};
  candidates.forEach(c => {
    availableCount[c.id] = sundays.filter(s => !blackoutSet.has(`${c.id}-${s}`)).length;
    effectiveCap[c.id] = Math.min(c.max_shifts, availableCount[c.id]);
  });

  const shiftCounts = {};
  const dailyAssigned = {};
  const lastServedIndex = {};

  candidates.forEach(c => {
    shiftCounts[c.id] = 0;
    lastServedIndex[c.id] = -99;
  });

  const allAssignments = [];
  let unfilledSlots = 0;

  function compositeRatio(c) {
    const totalShifts = shiftCounts[c.id] + historicalShifts[c.id];
    const totalCap    = (effectiveCap[c.id] || 1) + historicalCap[c.id];
    return totalShifts / totalCap;
  }

  function byUtilization(list) {
    return [...list].sort((a, b) =>
      (compositeRatio(a) - compositeRatio(b))
      || (effectiveCap[a.id] - effectiveCap[b.id])
      || (a.id - b.id)
    );
  }

  for (let si = 0; si < sundays.length; si++) {
    const sunday = sundays[si];
    dailyAssigned[sunday] = new Set();

    for (const location of locations) {
      let slotsRemaining = location.slots_per_day;
      const pool = candidates.filter(c => campusOf(c) === campusOf(location));

      for (const c of byUtilization(pool)) {
        if (slotsRemaining <= 0) break;
        if (blackoutSet.has(`${c.id}-${sunday}`)) continue;
        if (dailyAssigned[sunday].has(c.id)) continue;
        if (shiftCounts[c.id] >= c.max_shifts) continue;
        if (lastServedIndex[c.id] === si - 1) continue;
        assign(c, location.id, sunday, si, shiftCounts, dailyAssigned, lastServedIndex, allAssignments);
        slotsRemaining--;
      }

      if (slotsRemaining > 0) {
        for (const c of byUtilization(pool)) {
          if (slotsRemaining <= 0) break;
          if (blackoutSet.has(`${c.id}-${sunday}`)) continue;
          if (dailyAssigned[sunday].has(c.id)) continue;
          if (shiftCounts[c.id] >= c.max_shifts) continue;
          assign(c, location.id, sunday, si, shiftCounts, dailyAssigned, lastServedIndex, allAssignments);
          slotsRemaining--;
        }
      }

      if (slotsRemaining > 0) {
        const overCap = pool
          .filter(c =>
            !blackoutSet.has(`${c.id}-${sunday}`) &&
            !dailyAssigned[sunday].has(c.id) &&
            shiftCounts[c.id] >= c.max_shifts
          )
          .sort((a, b) => shiftCounts[a.id] - shiftCounts[b.id]);

        for (const c of overCap) {
          if (slotsRemaining <= 0) break;
          assign(c, location.id, sunday, si, shiftCounts, dailyAssigned, lastServedIndex, allAssignments);
          slotsRemaining--;
        }
      }

      unfilledSlots += slotsRemaining;
    }
  }

  const MAX_SWAPS = 500;
  let swapsDone = 0;
  const sundayIndexMap = Object.fromEntries(sundays.map((s, i) => [s, i]));

  // Balance within each campus; a Herndon shift can only move to another Herndon deacon.
  for (const campus of CAMPUSES) {
    const campusPool = candidates.filter(c => campusOf(c) === campus);
    if (campusPool.length < 2) continue;

    for (let iter = 0; iter < MAX_SWAPS; iter++) {
      const ranked = [...campusPool].sort((a, b) => compositeRatio(b) - compositeRatio(a));
      const donor = ranked[0];
      const recipient = ranked.slice(1).reverse().find(c => shiftCounts[c.id] < c.max_shifts);

      if (!recipient) break;
      if (compositeRatio(donor) - compositeRatio(recipient) < 0.05) break;

      const swappable = allAssignments.find(a => {
        if (a.candidate_id !== donor.id) return false;
        const si = sundayIndexMap[a.date];
        if (blackoutSet.has(`${recipient.id}-${a.date}`)) return false;
        if (dailyAssigned[a.date].has(recipient.id)) return false;
        if (sundays[si - 1] && dailyAssigned[sundays[si - 1]] && dailyAssigned[sundays[si - 1]].has(recipient.id)) return false;
        if (sundays[si + 1] && dailyAssigned[sundays[si + 1]] && dailyAssigned[sundays[si + 1]].has(recipient.id)) return false;
        return true;
      });

      if (!swappable) break;

      const si = sundayIndexMap[swappable.date];
      dailyAssigned[swappable.date].delete(donor.id);
      dailyAssigned[swappable.date].add(recipient.id);
      shiftCounts[donor.id]--;
      shiftCounts[recipient.id]++;
      swappable.candidate_id = recipient.id;

      lastServedIndex[donor.id] = allAssignments
        .filter(a => a.candidate_id === donor.id)
        .reduce((max, a) => Math.max(max, sundayIndexMap[a.date]), -99);
      lastServedIndex[recipient.id] = Math.max(lastServedIndex[recipient.id], si);

      swapsDone++;
    }
  }

  console.log(`[Scheduler → ${targetTable}] ${allAssignments.length} assignments, ${swapsDone} swaps, ${unfilledSlots} unfilled.`);

  db.transaction(() => {
    for (const a of allAssignments) {
      db.run(`INSERT INTO ${targetTable} (candidate_id, location_id, date) VALUES (?, ?, ?)`,
        [a.candidate_id, a.location_id, a.date]);
    }
  });

  const shiftValues = candidates.map(c => shiftCounts[c.id]);
  const avg = shiftValues.reduce((s, v) => s + v, 0) / shiftValues.length;
  const stdDev = Math.sqrt(shiftValues.reduce((s, v) => s + (v - avg) ** 2, 0) / shiftValues.length);

  return {
    totalAssignments: allAssignments.length,
    unfilledSlots,
    swapsDone,
    sundays: sundays.length,
    locations: locations.length,
    candidates: candidates.length,
    historicalPeriods,
    balanceStats: {
      min: Math.min(...shiftValues),
      max: Math.max(...shiftValues),
      avg: Math.round(avg * 10) / 10,
      stdDev: Math.round(stdDev * 100) / 100
    }
  };
}

function generateSchedule() {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  if (!settings || !settings.schedule_start_date || !settings.schedule_end_date) {
    throw new Error('Schedule date range not configured. Set start and end dates in Settings.');
  }
  preprocessCandidates(settings);
  db.run('DELETE FROM assignments');
  return _runCore(settings.schedule_start_date, settings.schedule_end_date, settings, 'assignments');
}

function generateDraftSchedule() {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  if (!settings || !settings.draft_start_date || !settings.draft_end_date) {
    throw new Error('Upcoming schedule date range not configured. Set draft start and end dates on the Upcoming page.');
  }
  const draftSettings = Object.assign({}, settings, {
    schedule_start_date: settings.draft_start_date,
    schedule_end_date:   settings.draft_end_date,
    input_deadline:      settings.draft_input_deadline
  });
  preprocessCandidates(draftSettings);
  let result;
  db.transaction(() => {
    db.run('DELETE FROM draft_assignments');
    result = _runCore(settings.draft_start_date, settings.draft_end_date, settings, 'draft_assignments');
  });
  return result;
}

async function generateScheduleBuffer() {
  const ExcelJS = require('exceljs');
  const settings  = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const locations = db.queryAll('SELECT * FROM locations ORDER BY name');

  const assignments = db.queryAll(`
    SELECT a.date, l.name AS location_name, c.name AS candidate_name
    FROM assignments a
    JOIN candidates c ON a.candidate_id = c.id
    JOIN locations  l ON a.location_id  = l.id
    ORDER BY a.date, l.name, c.name
  `);

  const byDate = {};
  for (const a of assignments) {
    if (!byDate[a.date]) byDate[a.date] = {};
    if (!byDate[a.date][a.location_name]) byDate[a.date][a.location_name] = [];
    byDate[a.date][a.location_name].push(a.candidate_name);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Election Scheduler';
  const sheet = workbook.addWorksheet('Schedule');

  const headerRow = sheet.addRow(['Date', ...locations.map(l => l.name)]);
  headerRow.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B3A5C' } };
  headerRow.font  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

  sheet.getColumn(1).width = 16;
  locations.forEach((_, i) => { sheet.getColumn(i + 2).width = 25; });

  const dates = Object.keys(byDate).sort();
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const dayName = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });
    const rowData = [`${dayName} ${date}`, ...locations.map(l => (byDate[date][l.name] || []).join(', '))];
    const row = sheet.addRow(rowData);
    row.alignment = { vertical: 'top', wrapText: true };
    if (i % 2 === 0) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F3F4' } };
    }
  }

  sheet.eachRow(row => row.eachCell(cell => {
    cell.border = {
      top: { style: 'thin' }, left: { style: 'thin' },
      bottom: { style: 'thin' }, right: { style: 'thin' }
    };
  }));

  const label = (settings && settings.schedule_start_date)
    ? `${settings.schedule_start_date}--${settings.schedule_end_date || 'present'}`
    : new Date().toISOString().split('T')[0];

  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer, filename: `schedule-${label}.xlsx` };
}

module.exports = { generateSchedule, generateDraftSchedule, generateScheduleBuffer, getSundays };
