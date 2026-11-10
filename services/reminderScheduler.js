/**
 * Availability Reminder Scheduler
 *
 * Checks every 30 minutes whether we are inside the 48-hour or 24-hour
 * window before the input_deadline. Sends an email to every candidate who
 * has NOT yet submitted their blackout dates, skipping anyone who already
 * received that specific reminder for the current deadline.
 */

const crypto = require('crypto');
const db     = require('../db');
const mailer = require('./mailer');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

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

// ── Magic link helper ─────────────────────────────────────────────────────────

function createMagicLink(candidateId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  db.run(
    'INSERT INTO magic_links (candidate_id, token, expires_at) VALUES (?, ?, ?)',
    [candidateId, token, expiresAt]
  );
  return `${APP_URL}/candidate/auth?token=${token}`;
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
    const magicLinkUrl = createMagicLink(candidate.id);
    await mailer.sendAvailabilityReminder(
      candidate.email,
      candidate.name,
      deadlineDisplay,
      type,
      magicLinkUrl
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
async function sendManualReminders(customMessage) {
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
      const magicLinkUrl = createMagicLink(candidate.id);
      await mailer.sendAvailabilityReminder(
        candidate.email,
        candidate.name,
        deadlineDisplay,
        'manual',
        magicLinkUrl,
        customMessage || null
      );
      sent++;
    } catch (err) {
      console.error(`[ReminderScheduler] Manual send failed for ${candidate.name}:`, err.message);
      skipped++;
    }
  }
  return { sent, skipped, total: unsubmitted.length };
}

/**
 * Send a follow-up login reminder to candidates who have never set a password
 * (i.e. never clicked their original magic link) and still haven't submitted.
 * Generates a fresh magic link for each.
 */
async function sendFollowupReminders(customMessage) {
  const unactivated = db.queryAll(
    `SELECT id, name, email FROM candidates
     WHERE password_hash IS NULL AND has_submitted_input = 0`
  );

  let sent = 0, skipped = 0;
  for (const candidate of unactivated) {
    try {
      const magicLinkUrl = createMagicLink(candidate.id);
      await mailer.sendLoginFollowup(
        candidate.email,
        candidate.name,
        magicLinkUrl,
        customMessage || null
      );
      sent++;
    } catch (err) {
      console.error(`[ReminderScheduler] Follow-up failed for ${candidate.name}:`, err.message);
      skipped++;
    }
  }
  return { sent, skipped, total: unactivated.length };
}

// ── Sunday group reminder helpers ────────────────────────────────────────────

const DEFAULT_CC = 'jim.muzzall@gmail.com,ashley@mcleanpres.org,jvogan@mcleanpres.org';

function getEasternComponents() {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
      weekday: 'long'
    }).formatToParts(now).map(p => [p.type, p.value])
  );
  const weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return {
    dayOfWeek: weekdays.indexOf(parts.weekday),
    hour: parseInt(parts.hour, 10) % 24,
    dateStr: `${parts.year}-${parts.month}-${parts.day}`
  };
}

function getUpcomingSundayStr(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  const daysUntilSunday = (7 - d.getDay()) % 7;
  const s = new Date(year, month - 1, day + daysUntilSunday);
  return `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
}

function getNextSundayStr(sundayStr) {
  const [year, month, day] = sundayStr.split('-').map(Number);
  const s = new Date(year, month - 1, day + 7);
  return `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
}

function formatSundayForEmail(sundayStr) {
  return new Date(sundayStr + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

function buildSundayReminderPayload(settings, upcomingSunday) {
  const deacons = db.queryAll(`
    SELECT DISTINCT c.name, c.email
    FROM assignments a
    JOIN candidates c ON a.candidate_id = c.id
    WHERE a.date = ?
    ORDER BY c.name
  `, [upcomingSunday]);

  const nextSunday = getNextSundayStr(upcomingSunday);
  const nextWeekDeacons = db.queryAll(`
    SELECT DISTINCT c.name, c.email
    FROM assignments a
    JOIN candidates c ON a.candidate_id = c.id
    WHERE a.date = ?
    ORDER BY c.name
  `, [nextSunday]);

  const ccRaw = settings.sunday_email_cc || DEFAULT_CC;
  const ccList = ccRaw.split(',').map(e => e.trim()).filter(Boolean);
  const nextWeekEmails = nextWeekDeacons.map(d => d.email);
  const allCC = [...new Set([...ccList, ...nextWeekEmails])];

  return {
    deacons,
    nextWeekDeacons: nextWeekDeacons.length > 0 ? nextWeekDeacons : null,
    toEmails: deacons.map(d => d.email),
    toNames: deacons.map(d => d.name),
    ccEmails: allCC,
    serviceDate: formatSundayForEmail(upcomingSunday),
    subject: settings.sunday_email_subject || 'Duty Deacon Reminder',
    customBody: settings.sunday_email_body || ''
  };
}

/**
 * Automated check: fires on the configured day+hour (ET).
 * Sends once per upcoming Sunday (deduped via sunday_reminder_log).
 */
async function checkAndSendSundayReminders() {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  if (!settings || !settings.sunday_reminder_enabled) return;

  const { dayOfWeek, hour, dateStr } = getEasternComponents();
  const configDay  = parseInt(settings.sunday_reminder_day)  || 4;
  const configHour = parseInt(settings.sunday_reminder_hour) || 14;

  if (dayOfWeek !== configDay || hour < configHour) return;

  const upcomingSunday = getUpcomingSundayStr(dateStr);

  const alreadySent = db.queryOne(
    'SELECT id FROM sunday_reminder_log WHERE sunday_date = ?',
    [upcomingSunday]
  );
  if (alreadySent) return;

  const payload = buildSundayReminderPayload(settings, upcomingSunday);
  if (payload.deacons.length === 0) {
    console.log(`[SundayReminder] No deacons scheduled for ${upcomingSunday} — skipping.`);
    return;
  }

  try {
    await mailer.sendSundayDutyReminder(payload);
    const recipients = [...payload.toEmails, ...payload.ccEmails].join(', ');
    db.run(
      'INSERT OR IGNORE INTO sunday_reminder_log (sunday_date, recipients, subject) VALUES (?, ?, ?)',
      [upcomingSunday, recipients, payload.subject]
    );
    console.log(`[SundayReminder] Sent for ${upcomingSunday} → ${payload.toNames.join(', ')}`);
  } catch (err) {
    console.error('[SundayReminder] Failed to send:', err.message);
  }
}

/**
 * Manual trigger: send Sunday reminder for the upcoming Sunday right now.
 * Records in sunday_reminder_log (overwrites if already sent for that Sunday).
 */
async function sendManualSundayReminder() {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const { dateStr } = getEasternComponents();
  const upcomingSunday = getUpcomingSundayStr(dateStr);

  const payload = buildSundayReminderPayload(settings, upcomingSunday);
  if (payload.deacons.length === 0) {
    throw new Error(`No deacons are scheduled for the upcoming Sunday (${upcomingSunday}).`);
  }

  await mailer.sendSundayDutyReminder(payload);

  const recipients = [...payload.toEmails, ...payload.ccEmails].join(', ');
  db.run(
    'INSERT OR REPLACE INTO sunday_reminder_log (sunday_date, recipients, subject) VALUES (?, ?, ?)',
    [upcomingSunday, recipients, payload.subject]
  );

  return {
    sunday: upcomingSunday,
    deacons: payload.toNames,
    sent: payload.toEmails.length
  };
}

/**
 * Send a test email with placeholder data to the given address.
 * Subject prefixed with [TEST], no CC.
 */
async function sendTestSundayEmail(toEmail) {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  const serviceDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  await mailer.sendSundayDutyReminder({
    toEmails: [toEmail],
    toNames: ['Test Deacon 1', 'Test Deacon 2'],
    ccEmails: [],
    serviceDate,
    nextWeekDeacons: [{ name: 'Test Deacon 3' }, { name: 'Test Deacon 4' }],
    subject: settings.sunday_email_subject || 'Duty Deacon Reminder',
    customBody: settings.sunday_email_body || '',
    isTest: true
  });
}

// ── Duty reminder helpers ─────────────────────────────────────────────────────

function formatAssignmentDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Automated check: send 'first' reminder when the assignment is within
 * duty_reminder_days_first days, and 'final' reminder within
 * duty_reminder_days_final days. Deduped via duty_reminder_log.
 */
async function checkAndSendDutyReminders() {
  const settings = db.queryOne('SELECT * FROM system_settings WHERE id = 1');
  if (!settings || !settings.duty_reminder_enabled) return;

  const daysFirst = parseInt(settings.duty_reminder_days_first) || 7;
  const daysFinal = parseInt(settings.duty_reminder_days_final) || 1;
  const portalUrl = `${APP_URL}/candidate/login`;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];

  const assignments = db.queryAll(`
    SELECT a.id AS assignment_id, a.date, a.location_id,
           c.id AS candidate_id, c.name, c.email,
           l.name AS location_name
    FROM assignments a
    JOIN candidates c ON a.candidate_id = c.id
    JOIN locations l ON a.location_id = l.id
    WHERE a.date >= ?
    ORDER BY a.date
  `, [todayStr]);

  let sent = 0, skipped = 0;

  for (const a of assignments) {
    const assignDate = new Date(a.date + 'T00:00:00');
    const daysUntil = Math.ceil((assignDate - today) / (1000 * 60 * 60 * 24));
    const formattedDate = formatAssignmentDate(a.date);

    const shouldFirst = daysUntil <= daysFirst && daysUntil > daysFinal;
    const shouldFinal = daysUntil <= daysFinal && daysUntil >= 0;

    for (const type of ['first', 'final']) {
      if (type === 'first' && !shouldFirst) continue;
      if (type === 'final' && !shouldFinal) continue;

      const already = db.queryOne(
        `SELECT id FROM duty_reminder_log
         WHERE candidate_id = ? AND assignment_date = ? AND location_id = ? AND reminder_type = ?`,
        [a.candidate_id, a.date, a.location_id, type]
      );
      if (already) { skipped++; continue; }

      try {
        await mailer.sendDutyReminder(
          a.email, a.name, formattedDate, a.location_name, type, portalUrl
        );
        db.run(
          `INSERT OR IGNORE INTO duty_reminder_log
           (candidate_id, assignment_date, location_id, reminder_type)
           VALUES (?, ?, ?, ?)`,
          [a.candidate_id, a.date, a.location_id, type]
        );
        console.log(`[DutyReminder] '${type}' sent → ${a.name} <${a.email}> for ${a.date} @ ${a.location_name}`);
        sent++;
      } catch (err) {
        console.error(`[DutyReminder] Failed '${type}' for ${a.name}:`, err.message);
        skipped++;
      }
    }
  }

  if (sent > 0 || skipped > 0) {
    console.log(`[DutyReminder] Check done — sent: ${sent}, skipped/failed: ${skipped}`);
  }
  return { sent, skipped };
}

/**
 * Manual send: immediately notifies ALL deacons with future assignments
 * using the 'first' (heads-up) email style. Does NOT write to duty_reminder_log
 * so automated first/final sends still fire later.
 */
async function sendManualDutyReminders(customMessage) {
  const portalUrl = `${APP_URL}/candidate/login`;
  const todayStr = new Date().toISOString().split('T')[0];

  const assignments = db.queryAll(`
    SELECT a.id AS assignment_id, a.date, a.location_id,
           c.id AS candidate_id, c.name, c.email,
           l.name AS location_name
    FROM assignments a
    JOIN candidates c ON a.candidate_id = c.id
    JOIN locations l ON a.location_id = l.id
    WHERE a.date >= ?
    ORDER BY c.name, a.date
  `, [todayStr]);

  let sent = 0;
  for (const a of assignments) {
    try {
      await mailer.sendDutyReminder(
        a.email, a.name, formatAssignmentDate(a.date), a.location_name,
        'first', portalUrl, customMessage || null
      );
      sent++;
    } catch (err) {
      console.error(`[DutyReminder] Manual send failed for ${a.name}:`, err.message);
    }
  }
  return { sent, total: assignments.length };
}

// ── Scheduler boot ───────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

function start() {
  console.log('[ReminderScheduler] Started — checks every 15 minutes.');
  const runAll = () => {
    checkAndSendReminders().catch(err =>
      console.error('[ReminderScheduler] Error:', err.message)
    );
    checkAndSendDutyReminders().catch(err =>
      console.error('[DutyReminder] Error:', err.message)
    );
    checkAndSendSundayReminders().catch(err =>
      console.error('[SundayReminder] Error:', err.message)
    );
  };
  runAll();
  setInterval(runAll, CHECK_INTERVAL_MS);
}

module.exports = {
  start,
  checkAndSendReminders,
  sendManualReminders,
  sendFollowupReminders,
  sendManualDutyReminders,
  sendManualSundayReminder,
  sendTestSundayEmail
};
