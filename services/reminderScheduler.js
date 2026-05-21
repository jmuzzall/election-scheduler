/**
 * Availability Reminder Scheduler
 *
 * Checks every 30 minutes whether we are inside the 48-hour or 24-hour
 * window before the input_deadline. Sends an email to every candidate who
 * has NOT yet submitted their blackout dates, skipping anyone who already
 * received that specific reminder for the current deadline.
 */

const db     = require('../db');
const mailer = require('./mailer');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse whatever datetime string is stored in system_settings.input_deadline
 * into a JS Date. Handles both "YYYY-MM-DDTHH:MM" and "YYYY-MM-DD HH:MM:SS".
 */
function parseDeadline(raw) {
  if (!raw) return null;
  // Normalise the separator so Date.parse works everywhere
  return new Date(raw.replace(' ', 'T'));
}

/**
 * Return a human-readable deadline string, e.g. "Sunday, January 5, 2025 at 11:59 PM".
 */
function formatDeadline(dt) {
  return dt.toLocaleString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
    hour:    'numeric',
    minute:  '2-digit',
    timeZoneName: 'short'
  });
}

// ── Core check ───────────────────────────────────────────────────────────────

async function checkAndSendReminders() {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  if (!settings || !settings.input_deadline) return;

  const deadline  = parseDeadline(settings.input_deadline);
  if (!deadline || isNaN(deadline.getTime())) return;

  const now       = new Date();
  const hoursLeft = (deadline - now) / (1000 * 60 * 60);

  // Windows: 48h reminder fires when 48 ≥ hoursLeft > 24
  //          24h reminder fires when 24 ≥ hoursLeft > 0
  const in48hWindow = hoursLeft <= 48 && hoursLeft > 24;
  const in24hWindow = hoursLeft <= 24 && hoursLeft > 0;

  if (!in48hWindow && !in24hWindow) return;

  // Candidates who still haven't submitted
  const unsubmitted = db.queryAll(
    'SELECT id, name, email FROM candidates WHERE has_submitted_input = 0'
  );
  if (unsubmitted.length === 0) return;

  // Use the raw string as the dedup key so a changed deadline triggers fresh reminders
  const deadlineKey     = settings.input_deadline;
  const deadlineDisplay = formatDeadline(deadline);

  console.log(
    `[ReminderScheduler] ${hoursLeft.toFixed(1)}h left — ` +
    `${unsubmitted.length} unsubmitted candidate(s). ` +
    `Windows: 48h=${in48hWindow} 24h=${in24hWindow}`
  );

  for (const candidate of unsubmitted) {
    if (in48hWindow) {
      await maybeSend(candidate, deadlineKey, deadlineDisplay, '48h');
    }
    if (in24hWindow) {
      await maybeSend(candidate, deadlineKey, deadlineDisplay, '24h');
    }
  }
}

/**
 * Send a reminder only if it hasn't been sent before for this candidate +
 * deadline + type combination.
 */
async function maybeSend(candidate, deadlineKey, deadlineDisplay, type) {
  const alreadySent = db.queryOne(
    `SELECT id FROM reminder_log
     WHERE candidate_id = ? AND deadline = ? AND reminder_type = ?`,
    [candidate.id, deadlineKey, type]
  );
  if (alreadySent) return;

  try {
    await mailer.sendAvailabilityReminder(
      candidate.email,
      candidate.name,
      deadlineDisplay,
      type
    );
    db.run(
      `INSERT OR IGNORE INTO reminder_log (candidate_id, deadline, reminder_type)
       VALUES (?, ?, ?)`,
      [candidate.id, deadlineKey, type]
    );
    console.log(`[ReminderScheduler] ${type} reminder sent → ${candidate.name} <${candidate.email}>`);
  } catch (err) {
    console.error(`[ReminderScheduler] Failed to send ${type} reminder to ${candidate.name}:`, err.message);
  }
}

// ── Manual send (admin-triggered) ────────────────────────────────────────────

/**
 * Send an immediate reminder to all unsubmitted candidates regardless of the
 * time window. Does NOT record into reminder_log so it won't block the
 * scheduled 48h/24h sends.
 *
 * Returns { sent: number, skipped: number } count object.
 */
async function sendManualReminders() {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  if (!settings || !settings.input_deadline) {
    throw new Error('No input deadline is set. Please configure one in Settings first.');
  }

  const deadline = parseDeadline(settings.input_deadline);
  if (!deadline || isNaN(deadline.getTime())) {
    throw new Error('The input deadline stored in settings could not be parsed.');
  }

  const deadlineDisplay = formatDeadline(deadline);
  const unsubmitted = db.queryAll(
    'SELECT id, name, email FROM candidates WHERE has_submitted_input = 0'
  );

  let sent = 0, skipped = 0;
  for (const candidate of unsubmitted) {
    try {
      await mailer.sendAvailabilityReminder(
        candidate.email,
        candidate.name,
        deadlineDisplay,
        'manual'   // not '48h'/'24h' so it doesn't consume those log slots
      );
      sent++;
    } catch (err) {
      console.error(`[ReminderScheduler] Manual send failed for ${candidate.name}:`, err.message);
      skipped++;
    }
  }
  return { sent, skipped, total: unsubmitted.length };
}

// ── Scheduler boot ───────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

function start() {
  console.log('[ReminderScheduler] Started — checks every 30 minutes.');
  // Run once immediately on boot, then on interval
  checkAndSendReminders().catch(err =>
    console.error('[ReminderScheduler] Error on startup check:', err.message)
  );
  setInterval(() => {
    checkAndSendReminders().catch(err =>
      console.error('[ReminderScheduler] Error on interval check:', err.message)
    );
  }, CHECK_INTERVAL_MS);
}

module.exports = { start, checkAndSendReminders, sendManualReminders };
