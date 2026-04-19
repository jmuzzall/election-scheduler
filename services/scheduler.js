const db = require('../db');

/**
 * Get all Sundays between two dates (inclusive).
 */
function getSundays(startDate, endDate) {
  const sundays = [];
  const current = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');

  while (current.getDay() !== 0 && current <= end) {
    current.setDate(current.getDate() + 1);
  }

  while (current <= end) {
    sundays.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 7);
  }

  return sundays;
}

/**
 * Get all dates between two dates (inclusive).
 */
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

/**
 * Shuffle array using Fisher-Yates.
 */
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Pre-processing: For candidates who haven't submitted input and the deadline
 * has passed, auto-generate blackout dates for Mon-Sat (leaving Sundays open).
 */
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
        } catch (e) {
          // Ignore duplicates
        }
      }
    }
  });

  console.log(`Pre-processed ${unsubmitted.length} candidates who missed the deadline.`);
}

/**
 * Main scheduling algorithm.
 */
function generateSchedule() {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  if (!settings || !settings.schedule_start_date || !settings.schedule_end_date) {
    throw new Error('Schedule date range not configured. Set start and end dates in Settings.');
  }

  // Pre-process unsubmitted candidates
  preprocessCandidates(settings);

  // Clear existing assignments
  db.run('DELETE FROM assignments');

  // Get all Sundays in range
  const sundays = getSundays(settings.schedule_start_date, settings.schedule_end_date);
  if (sundays.length === 0) {
    throw new Error('No Sundays found in the configured date range.');
  }

  // Get all locations
  const locations = db.queryAll('SELECT * FROM locations ORDER BY name');
  if (locations.length === 0) {
    throw new Error('No locations configured. Add locations before generating a schedule.');
  }

  // Get all candidates
  const candidates = db.queryAll('SELECT * FROM candidates');
  if (candidates.length === 0) {
    throw new Error('No candidates found. Upload candidates before generating a schedule.');
  }

  // Build blackout set for fast lookup
  const blackoutRows = db.queryAll('SELECT candidate_id, date FROM blackout_dates');
  const blackoutSet = new Set(blackoutRows.map(r => `${r.candidate_id}-${r.date}`));

  // Track shift counts and daily assignments
  const shiftCounts = {};
  const dailyAssigned = {};
  candidates.forEach(c => { shiftCounts[c.id] = 0; });

  const allAssignments = [];

  for (const sunday of sundays) {
    dailyAssigned[sunday] = new Set();
    const shuffled = shuffle(candidates);

    for (const location of locations) {
      let slotsRemaining = location.slots_per_day;

      for (const candidate of shuffled) {
        if (slotsRemaining <= 0) break;
        if (blackoutSet.has(`${candidate.id}-${sunday}`)) continue;
        if (shiftCounts[candidate.id] >= candidate.max_shifts) continue;
        if (dailyAssigned[sunday].has(candidate.id)) continue;

        allAssignments.push({
          candidate_id: candidate.id,
          location_id: location.id,
          date: sunday
        });

        shiftCounts[candidate.id]++;
        dailyAssigned[sunday].add(candidate.id);
        slotsRemaining--;
      }
    }
  }

  // Save all assignments in a transaction
  db.transaction(() => {
    for (const a of allAssignments) {
      db.run('INSERT INTO assignments (candidate_id, location_id, date) VALUES (?, ?, ?)',
        [a.candidate_id, a.location_id, a.date]);
    }
  });

  return {
    totalAssignments: allAssignments.length,
    sundays: sundays.length,
    locations: locations.length,
    candidates: candidates.length
  };
}

module.exports = { generateSchedule, getSundays };
