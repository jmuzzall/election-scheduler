const db = require('../db');

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
function generateSchedule() {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  if (!settings || !settings.schedule_start_date || !settings.schedule_end_date) {
    throw new Error('Schedule date range not configured. Set start and end dates in Settings.');
  }

  preprocessCandidates(settings);
  db.run('DELETE FROM assignments');

  const sundays = getSundays(settings.schedule_start_date, settings.schedule_end_date);
  if (sundays.length === 0) throw new Error('No Sundays found in the configured date range.');

  const locations = db.queryAll('SELECT * FROM locations ORDER BY name');
  if (locations.length === 0) throw new Error('No locations configured. Add locations before generating a schedule.');

  const candidates = db.queryAll('SELECT * FROM candidates');
  if (candidates.length === 0) throw new Error('No candidates found. Upload candidates before generating a schedule.');

  const blackoutRows = db.queryAll('SELECT candidate_id, date FROM blackout_dates');
  const blackoutSet = new Set(blackoutRows.map(r => `${r.candidate_id}-${r.date}`));

  // ── Pre-compute effective capacity for each candidate ──────────────────────
  // Effective capacity = the most they could realistically work:
  //   min(their max_shifts preference, number of Sundays they are available)
  const availableCount = {};   // how many Sundays they're not blacked out
  const effectiveCap = {};     // min(max_shifts, availableCount)
  candidates.forEach(c => {
    availableCount[c.id] = sundays.filter(s => !blackoutSet.has(`${c.id}-${s}`)).length;
    effectiveCap[c.id] = Math.min(c.max_shifts, availableCount[c.id]);
  });

  // ── Tracking state ─────────────────────────────────────────────────────────
  const shiftCounts = {};        // shifts assigned so far
  const dailyAssigned = {};      // set of candidate IDs per Sunday (hard: one per day)
  const lastServedIndex = {};    // index of the most recent Sunday each person was assigned

  candidates.forEach(c => {
    shiftCounts[c.id] = 0;
    lastServedIndex[c.id] = -99; // far in the past
  });

  const allAssignments = [];
  let unfilledSlots = 0;

  // ── Utilization sort ───────────────────────────────────────────────────────
  // Lower ratio → person has more "room" relative to their capacity → higher priority.
  // Tiebreaker 1: fewest effective available dates (most constrained candidate goes first
  //   so they are not squeezed out by less-constrained peers with equal utilization).
  // Tiebreaker 2: candidate ID (deterministic, avoids random re-ordering across runs).
  function byUtilization(list) {
    return [...list].sort((a, b) => {
      const ra = shiftCounts[a.id] / (effectiveCap[a.id] || 1);
      const rb = shiftCounts[b.id] / (effectiveCap[b.id] || 1);
      return (ra - rb)
          || (effectiveCap[a.id] - effectiveCap[b.id])   // most constrained first
          || (a.id - b.id);                               // deterministic tiebreaker
    });
  }

  // ── Phase 1: Greedy fill ───────────────────────────────────────────────────
  for (let si = 0; si < sundays.length; si++) {
    const sunday = sundays[si];
    dailyAssigned[sunday] = new Set();

    for (const location of locations) {
      let slotsRemaining = location.slots_per_day;

      // ── 1a: Under cap + no back-to-back ─────────────────────────────────
      for (const c of byUtilization(candidates)) {
        if (slotsRemaining <= 0) break;
        if (blackoutSet.has(`${c.id}-${sunday}`)) continue;
        if (dailyAssigned[sunday].has(c.id)) continue;
        if (shiftCounts[c.id] >= c.max_shifts) continue;
        if (lastServedIndex[c.id] === si - 1) continue;   // back-to-back
        assign(c, location.id, sunday, si, shiftCounts, dailyAssigned, lastServedIndex, allAssignments);
        slotsRemaining--;
      }

      // ── 1b: Under cap + back-to-back OK (relax consecutive constraint) ──
      if (slotsRemaining > 0) {
        for (const c of byUtilization(candidates)) {
          if (slotsRemaining <= 0) break;
          if (blackoutSet.has(`${c.id}-${sunday}`)) continue;
          if (dailyAssigned[sunday].has(c.id)) continue;
          if (shiftCounts[c.id] >= c.max_shifts) continue;
          assign(c, location.id, sunday, si, shiftCounts, dailyAssigned, lastServedIndex, allAssignments);
          slotsRemaining--;
        }
      }

      // ── 1c: Over cap — sorted fewest shifts first (relax max_shifts) ────
      if (slotsRemaining > 0) {
        const overCap = candidates
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

  // ── Phase 2: Swap improvement ──────────────────────────────────────────────
  // Repeatedly find the most over-utilized candidate and try to transfer one of
  // their assignments to the most under-utilized candidate who can legally take it.
  // A swap is valid when the recipient is:
  //   • not blacked out on that date
  //   • not already assigned on that date
  //   • would not create a back-to-back for themselves
  //   • would not create a back-to-back for the donor (after removal)
  // Stop when no swap improves the ratio spread, or after MAX_SWAPS attempts.

  const MAX_SWAPS = 500;
  let swapsDone = 0;

  for (let iter = 0; iter < MAX_SWAPS; iter++) {
    // Sort by utilization ratio descending (most over-used first)
    const ranked = [...candidates].sort((a, b) => {
      const ra = shiftCounts[a.id] / (effectiveCap[a.id] || 1);
      const rb = shiftCounts[b.id] / (effectiveCap[b.id] || 1);
      return rb - ra;
    });

    const donor = ranked[0];
    // Best recipient: under-utilized, still under their cap
    const recipient = ranked.slice(1).reverse().find(c => shiftCounts[c.id] < c.max_shifts);

    if (!recipient) break; // everyone is at cap — no point swapping

    const donorRatio = shiftCounts[donor.id] / (effectiveCap[donor.id] || 1);
    const recipientRatio = shiftCounts[recipient.id] / (effectiveCap[recipient.id] || 1);

    // Only bother if there's a meaningful imbalance (> 5% of capacity)
    if (donorRatio - recipientRatio < 0.05) break;

    // Find a donor assignment the recipient can legally take
    const sundayIndexMap = Object.fromEntries(sundays.map((s, i) => [s, i]));

    const swappable = allAssignments.find(a => {
      if (a.candidate_id !== donor.id) return false;
      const si = sundayIndexMap[a.date];

      // Recipient must be available
      if (blackoutSet.has(`${recipient.id}-${a.date}`)) return false;
      // Recipient must not already serve that day
      if (dailyAssigned[a.date].has(recipient.id)) return false;
      // Recipient must not create a back-to-back
      if (sundays[si - 1] && dailyAssigned[sundays[si - 1]] && dailyAssigned[sundays[si - 1]].has(recipient.id)) return false;
      if (sundays[si + 1] && dailyAssigned[sundays[si + 1]] && dailyAssigned[sundays[si + 1]].has(recipient.id)) return false;

      return true;
    });

    if (!swappable) break; // donor has no transferable assignment

    // Execute the swap
    const si = sundayIndexMap[swappable.date];
    dailyAssigned[swappable.date].delete(donor.id);
    dailyAssigned[swappable.date].add(recipient.id);
    shiftCounts[donor.id]--;
    shiftCounts[recipient.id]++;
    swappable.candidate_id = recipient.id;

    // Update lastServedIndex for donor (recalculate from remaining assignments)
    lastServedIndex[donor.id] = allAssignments
      .filter(a => a.candidate_id === donor.id)
      .reduce((max, a) => Math.max(max, sundayIndexMap[a.date]), -99);

    // Update lastServedIndex for recipient
    lastServedIndex[recipient.id] = Math.max(lastServedIndex[recipient.id], si);

    swapsDone++;
  }

  console.log(`Scheduler: ${allAssignments.length} assignments, ${swapsDone} balance swaps, ${unfilledSlots} unfilled slots.`);

  // ── Save ───────────────────────────────────────────────────────────────────
  db.transaction(() => {
    for (const a of allAssignments) {
      db.run('INSERT INTO assignments (candidate_id, location_id, date) VALUES (?, ?, ?)',
        [a.candidate_id, a.location_id, a.date]);
    }
  });

  // ── Stats for response ─────────────────────────────────────────────────────
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
    balanceStats: {
      min: Math.min(...shiftValues),
      max: Math.max(...shiftValues),
      avg: Math.round(avg * 10) / 10,
      stdDev: Math.round(stdDev * 100) / 100
    }
  };
}

module.exports = { generateSchedule, getSundays };
