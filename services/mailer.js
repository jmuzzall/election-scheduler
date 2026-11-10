const nodemailer = require('nodemailer');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let transporter = null;

function getTransporter() {
  if (!transporter) {
    // If SMTP credentials are configured, use them; otherwise use a preview-only logger
    if (process.env.SMTP_HOST && process.env.SMTP_PASS && process.env.SMTP_PASS !== 'your-gmail-app-password') {
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
    } else {
      // Console-only transport for development (no real emails sent)
      transporter = {
        sendMail: async (options) => {
          console.log('\n====== EMAIL (dev mode - not actually sent) ======');
          console.log(`To:      ${options.to}`);
          console.log(`Subject: ${options.subject}`);
          console.log(`Body:\n${options.text || options.html}`);
          console.log('==================================================\n');
          return { messageId: 'dev-' + Date.now() };
        }
      };
      console.log('SMTP not configured — magic link emails will be logged to console.');
    }
  }
  return transporter;
}

async function sendMagicLink(email, name, token) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const link = `${appUrl}/candidate/auth?token=${token}`;
  const transport = getTransporter();

  await transport.sendMail({
    from: `"Scheduling System" <${process.env.SMTP_USER || 'noreply@localhost'}>`,
    to: email,
    subject: 'Your Scheduling Portal Access Link',
    text: [
      `Hello ${name},`,
      '',
      'You have been invited to submit your availability for upcoming Sunday duty scheduling.',
      '',
      `Click the link below to access your portal:`,
      link,
      '',
      'This link will expire in 24 hours and can only be used once.',
      '',
      'If you did not expect this email, please ignore it.',
      '',
      '— Scheduling System'
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Sunday Duty Scheduling</h2>
        <p>Hello <strong>${name}</strong>,</p>
        <p>You have been invited to submit your availability for upcoming Sunday duty scheduling.</p>
        <p style="margin: 24px 0;">
          <a href="${link}" style="background: #3498db; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
            Access Your Portal
          </a>
        </p>
        <p style="color: #7f8c8d; font-size: 13px;">This link expires in 24 hours and can only be used once.</p>
        <p style="color: #7f8c8d; font-size: 13px;">If you did not expect this email, please ignore it.</p>
      </div>
    `
  });

  return link;
}

async function sendPasswordReset(email, name, token) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const link = `${appUrl}/candidate/reset-password?token=${token}`;
  const transport = getTransporter();

  await transport.sendMail({
    from: `"Scheduling System" <${process.env.SMTP_USER || 'noreply@localhost'}>`,
    to: email,
    subject: 'Reset Your Scheduling Portal Password',
    text: [
      `Hello ${name},`,
      '',
      'We received a request to reset your password for the Sunday Duty Scheduling portal.',
      '',
      'Click the link below to choose a new password:',
      link,
      '',
      'This link will expire in 1 hour.',
      '',
      'If you did not request a password reset, you can safely ignore this email.',
      '',
      '— Scheduling System'
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Password Reset</h2>
        <p>Hello <strong>${name}</strong>,</p>
        <p>We received a request to reset your password for the Sunday Duty Scheduling portal.</p>
        <p style="margin: 24px 0;">
          <a href="${link}" style="background: #e67e22; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
            Reset My Password
          </a>
        </p>
        <p style="color: #7f8c8d; font-size: 13px;">This link expires in 1 hour.</p>
        <p style="color: #7f8c8d; font-size: 13px;">If you did not request a password reset, you can safely ignore this email.</p>
      </div>
    `
  });

  return link;
}

/**
 * Notify the swap target that someone wants to trade with them.
 * requesterAssignment / targetAssignment: { date, location_name }
 */
async function sendSwapRequest(targetEmail, targetName, requesterName, requesterAssignment, targetAssignment, message) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const link = `${appUrl}/candidate/swaps`;
  const transport = getTransporter();

  const msgBlock = message ? `\n\nMessage from ${requesterName}: "${message}"` : '';

  await transport.sendMail({
    from: `"Scheduling System" <${process.env.SMTP_USER || 'noreply@localhost'}>`,
    to: targetEmail,
    subject: `Swap Request from ${requesterName}`,
    text: [
      `Hello ${targetName},`,
      '',
      `${requesterName} has proposed a schedule swap with you:`,
      '',
      `  They offer:  ${requesterAssignment.date} — ${requesterAssignment.location_name}`,
      `  In exchange: ${targetAssignment.date} — ${targetAssignment.location_name} (yours)`,
      msgBlock,
      '',
      'Log in to review and respond:',
      link,
      '',
      '— Scheduling System'
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#1B3A5C;">Schedule Swap Request</h2>
        <p>Hello <strong>${targetName}</strong>,</p>
        <p><strong>${requesterName}</strong> would like to swap Sunday duties with you:</p>
        <table style="border-collapse:collapse;width:100%;margin:16px 0;">
          <tr style="background:#f0f4f8;">
            <td style="padding:10px;border:1px solid #cdd9e8;font-weight:bold;">They offer</td>
            <td style="padding:10px;border:1px solid #cdd9e8;">${requesterAssignment.date} &mdash; ${requesterAssignment.location_name}</td>
          </tr>
          <tr>
            <td style="padding:10px;border:1px solid #cdd9e8;font-weight:bold;">You give up</td>
            <td style="padding:10px;border:1px solid #cdd9e8;">${targetAssignment.date} &mdash; ${targetAssignment.location_name}</td>
          </tr>
        </table>
        ${message ? `<p style="background:#fff8e1;padding:10px;border-left:4px solid #C5963A;">${requesterName} says: "${message}"</p>` : ''}
        <p style="margin:24px 0;">
          <a href="${link}" style="background:#1B3A5C;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;">
            Review Swap Request
          </a>
        </p>
        <p style="color:#7f8c8d;font-size:13px;">Log in to approve or decline this request.</p>
      </div>
    `
  });
  return link;
}

/**
 * Notify the requester that their swap was approved or declined.
 */
async function sendSwapResolved(requesterEmail, requesterName, targetName, approved, requesterAssignment, targetAssignment) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const transport = getTransporter();
  const status = approved ? 'Approved' : 'Declined';
  const color = approved ? '#27ae60' : '#e74c3c';

  await transport.sendMail({
    from: `"Scheduling System" <${process.env.SMTP_USER || 'noreply@localhost'}>`,
    to: requesterEmail,
    subject: `Swap ${status} by ${targetName}`,
    text: approved
      ? [
          `Hello ${requesterName},`,
          '',
          `Great news — ${targetName} approved your swap request.`,
          '',
          `You are now assigned: ${targetAssignment.date} — ${targetAssignment.location_name}`,
          `${targetName} is now assigned: ${requesterAssignment.date} — ${requesterAssignment.location_name}`,
          '',
          '— Scheduling System'
        ].join('\n')
      : [
          `Hello ${requesterName},`,
          '',
          `${targetName} has declined your swap request.`,
          '',
          `Your assignment remains: ${requesterAssignment.date} — ${requesterAssignment.location_name}`,
          '',
          '— Scheduling System'
        ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:${color};">Swap ${status}</h2>
        <p>Hello <strong>${requesterName}</strong>,</p>
        ${approved
          ? `<p><strong>${targetName}</strong> approved your swap. Your schedule has been updated:</p>
             <table style="border-collapse:collapse;width:100%;margin:16px 0;">
               <tr style="background:#f0f4f8;"><td style="padding:10px;border:1px solid #cdd9e8;font-weight:bold;">Your new assignment</td>
               <td style="padding:10px;border:1px solid #cdd9e8;">${targetAssignment.date} &mdash; ${targetAssignment.location_name}</td></tr>
             </table>`
          : `<p><strong>${targetName}</strong> declined your swap request. Your original assignment remains unchanged.</p>`
        }
        <p style="color:#7f8c8d;font-size:13px;">Log in to view the current schedule.</p>
      </div>
    `
  });
}

/**
 * Send an availability reminder to a candidate who hasn't submitted blackout dates.
 * reminderType: '48h' or '24h'
 */
async function sendAvailabilityReminder(email, name, deadlineFormatted, reminderType, magicLinkUrl, customMessage) {
  const appUrl   = process.env.APP_URL || 'http://localhost:3000';
  const loginUrl = `${appUrl}/candidate/login`;
  const linkUrl  = magicLinkUrl || loginUrl;
  const transport = getTransporter();

  const isFinal  = reminderType === '24h';
  const isManual = reminderType === 'manual';
  const urgency  = isFinal ? 'Final Reminder: ' : '';
  const timeNote = isFinal   ? ' (approximately 24 hours from now)'
                 : isManual  ? ''
                 :             ' (approximately 48 hours from now)';
  const subject  = isFinal
    ? `Final Reminder — Please Submit Your Blackout Dates Before the Window Closes`
    : `Reminder — Please Submit Your Blackout Dates for Deacon Duty Scheduling`;

  const customBlock = customMessage
    ? `\n\n${customMessage}`
    : '';
  const customHtmlBlock = customMessage
    ? `<div style="background:#f0f4f8;border-left:4px solid #1B3A5C;padding:12px 16px;margin:16px 0;border-radius:0 6px 6px 0;font-style:italic;">${escapeHtml(customMessage).replace(/\n/g, '<br>')}</div>`
    : '';

  await transport.sendMail({
    from: `"Sunday Duty Scheduler" <${process.env.SMTP_USER || 'noreply@localhost'}>`,
    to: email,
    subject,
    text: [
      `Dear ${name},`,
      '',
      `You have not yet put in your blackout dates for duty deacon service.`,
      '',
      `Please do so before the deadline of ${deadlineFormatted}${timeNote}, before the window closes.`,
      '',
      `If you do not have any blackout dates, please respond in the software or we will assume ` +
      `you are available for all Sundays in the scheduling period.`,
      customBlock,
      '',
      `Log in here: ${linkUrl}`,
      '',
      'Thank you for your service.',
      '',
      '— Sunday Duty Deacon Rotation Scheduler'
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1B3A5C;padding:20px 24px;border-radius:6px 6px 0 0;">
          <h2 style="color:#fff;margin:0;font-size:20px;">
            ${urgency}Blackout Date Submission Reminder
          </h2>
        </div>
        <div style="padding:24px;border:1px solid #dee2e6;border-top:none;border-radius:0 0 6px 6px;">
          <p>Dear <strong>${name}</strong>,</p>
          <p>You have not yet put in your blackout dates for duty deacon service.</p>
          <div style="background:#fff8e1;border-left:4px solid #C5963A;padding:14px 18px;margin:20px 0;border-radius:0 6px 6px 0;">
            <strong>Submission deadline:</strong> ${deadlineFormatted}${timeNote ? `<br><em style="font-size:13px;">${timeNote.trim()}</em>` : ''}
          </div>
          ${customHtmlBlock}
          <p>
            If you do not have any blackout dates, please log in to the portal and indicate
            this — otherwise we will assume you are available for <em>all</em> Sundays in
            the scheduling period.
          </p>
          <p style="margin:28px 0;">
            <a href="${linkUrl}"
               style="background:#1B3A5C;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">
              Log In &amp; Submit Availability
            </a>
          </p>
          <p style="color:#7f8c8d;font-size:13px;">
            Thank you for your service to McLean Presbyterian Church.
          </p>
        </div>
      </div>
    `
  });
}

/**
 * Follow-up to candidates who never activated their account (no password set).
 * Includes a fresh magic link so they can log in directly.
 */
async function sendLoginFollowup(email, name, magicLinkUrl, customMessage) {
  const transport = getTransporter();

  const customBlock = customMessage
    ? `\n\n${customMessage}`
    : '';
  const customHtmlBlock = customMessage
    ? `<div style="background:#f0f4f8;border-left:4px solid #1B3A5C;padding:12px 16px;margin:16px 0;border-radius:0 6px 6px 0;font-style:italic;">${escapeHtml(customMessage).replace(/\n/g, '<br>')}</div>`
    : '';

  await transport.sendMail({
    from: `"Sunday Duty Scheduler" <${process.env.SMTP_USER || 'noreply@localhost'}>`,
    to: email,
    subject: `Action Required — Please Set Up Your Deacon Scheduling Account`,
    text: [
      `Dear ${name},`,
      '',
      `We noticed you haven't yet created your login for the Sunday Duty Deacon Scheduling portal.`,
      '',
      `We've generated a fresh link below — just click it to set up your account and ` +
      `submit your availability. No need to remember a password; the link takes you straight in.`,
      customBlock,
      '',
      `Your personal login link (valid for 48 hours):`,
      magicLinkUrl,
      '',
      `Once you're in, please indicate any Sundays you are NOT available to serve.  ` +
      `If you have no conflicts, simply save with nothing selected and we will assume you are available for all dates.`,
      '',
      'Thank you for your service.',
      '',
      '— Sunday Duty Deacon Rotation Scheduler'
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1B3A5C;padding:20px 24px;border-radius:6px 6px 0 0;">
          <h2 style="color:#fff;margin:0;font-size:20px;">
            Please Set Up Your Scheduling Account
          </h2>
        </div>
        <div style="padding:24px;border:1px solid #dee2e6;border-top:none;border-radius:0 0 6px 6px;">
          <p>Dear <strong>${name}</strong>,</p>
          <p>
            We noticed you haven't yet created your login for the Sunday Duty Deacon
            Scheduling portal.
          </p>
          <p>
            We've generated a fresh link below — just click it to set up your account and
            submit your availability. <strong>No password needed</strong> — the link takes
            you straight in.
          </p>
          ${customHtmlBlock}
          <p style="margin:28px 0;">
            <a href="${magicLinkUrl}"
               style="background:#C5963A;color:#fff;padding:14px 32px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:16px;display:inline-block;">
              Set Up My Account &amp; Submit Availability
            </a>
          </p>
          <p style="color:#7f8c8d;font-size:13px;">
            This link is personal to you and expires in 48 hours.
            Once you're in, please indicate any Sundays you are <em>not</em> available to serve.
            If you have no conflicts, simply save with nothing selected.
          </p>
          <p style="color:#7f8c8d;font-size:13px;">
            Thank you for your service to McLean Presbyterian Church.
          </p>
        </div>
      </div>
    `
  });
}

/**
 * Invite a new admin to set up their account via a one-time link.
 */
async function sendAdminInvite(email, name, inviterName, token) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const link = `${appUrl}/admin/accept-invite?token=${token}`;
  const transport = getTransporter();

  await transport.sendMail({
    from: `"Sunday Duty Scheduler" <${process.env.SMTP_USER || 'noreply@localhost'}>`,
    to: email,
    subject: `You've been invited to administer the Sunday Duty Deacon Rotation Scheduler`,
    text: [
      `Hello ${name},`,
      '',
      `${inviterName} has invited you to be an administrator of the Sunday Duty Deacon Rotation Scheduler for McLean Presbyterian Church.`,
      '',
      `Click the link below to accept the invitation and set up your password:`,
      link,
      '',
      `This invitation link expires in 48 hours and can only be used once.`,
      '',
      `If you did not expect this invitation, please ignore this email.`,
      '',
      '— Sunday Duty Deacon Rotation Scheduler'
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1B3A5C;padding:20px 24px;border-radius:6px 6px 0 0;">
          <h2 style="color:#fff;margin:0;font-size:20px;">Admin Invitation</h2>
        </div>
        <div style="padding:24px;border:1px solid #dee2e6;border-top:none;border-radius:0 0 6px 6px;">
          <p>Hello <strong>${name}</strong>,</p>
          <p>
            <strong>${inviterName}</strong> has invited you to be an administrator of the
            <strong>Sunday Duty Deacon Rotation Scheduler</strong> for McLean Presbyterian Church.
          </p>
          <p>Click the button below to accept the invitation and choose your password:</p>
          <p style="margin:28px 0;">
            <a href="${link}"
               style="background:#1B3A5C;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">
              Accept Invitation &amp; Set Password
            </a>
          </p>
          <p style="color:#7f8c8d;font-size:13px;">
            This link expires in 48 hours and can only be used once.<br>
            If you did not expect this invitation, you can safely ignore this email.
          </p>
        </div>
      </div>
    `
  });

  return link;
}

/**
 * Send the weekly Sunday group reminder to all deacons serving that Sunday.
 * isTest: if true, prefix [TEST] in subject and suppress CC.
 */
async function sendSundayDutyReminder({ toEmails, toNames, ccEmails, serviceDate, nextWeekDeacons, subject, customBody, isTest = false }) {
  const transport = getTransporter();

  const greeting = toNames.length >= 2
    ? `Dear ${toNames.slice(0, -1).join(', ')} and ${toNames[toNames.length - 1]},`
    : toNames.length === 1
      ? `Dear ${toNames[0]},`
      : 'Dear Duty Deacons,';

  const nextWeekNames = nextWeekDeacons && nextWeekDeacons.length > 0
    ? nextWeekDeacons.map(d => d.name)
    : null;
  const nextWeekLine = nextWeekNames
    ? (nextWeekNames.length >= 2
        ? `Next week, ${nextWeekNames.slice(0, -1).join(', ')} and ${nextWeekNames[nextWeekNames.length - 1]} are scheduled to serve.`
        : `Next week, ${nextWeekNames[0]} is scheduled to serve.`)
    : "Next week’s duty assignments have not yet been finalized.";

  const finalSubject = isTest ? `[TEST] ${subject}` : subject;
  const finalCC = isTest ? [] : (ccEmails || []);

  const textParts = [
    greeting,
    `You are scheduled to serve on ${serviceDate}.`,
    ''
  ];
  if (nextWeekLine) { textParts.push(nextWeekLine, ''); }
  if (customBody) { textParts.push(customBody, ''); }
  textParts.push('— McLean Presbyterian Church\n   Sunday Duty Deacon Rotation Scheduler');

  const customHtml = customBody
    ? `<p style="margin:16px 0;">${customBody.replace(/\n/g, '<br>')}</p>`
    : '';
  const nextWeekHtml = nextWeekLine
    ? `<p style="margin:16px 0;">${nextWeekLine}</p>`
    : '';

  const mailOptions = {
    from: `"McLean Presbyterian Church" <${process.env.SMTP_USER || 'noreply@localhost'}>`,
    to: toEmails.join(', '),
    subject: finalSubject,
    text: textParts.join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1B3A5C;padding:20px 24px;border-radius:6px 6px 0 0;">
          <h2 style="color:#fff;margin:0;font-size:20px;">Sunday Duty Deacon Reminder</h2>
        </div>
        <div style="padding:24px;border:1px solid #dee2e6;border-top:none;border-radius:0 0 6px 6px;">
          <p style="margin:0 0 4px 0;">${greeting}</p>
          <p style="margin:0 0 16px 0;">You are scheduled to serve on:</p>
          <div style="background:#fff8e1;border-left:4px solid #C5963A;padding:14px 18px;margin:0 0 16px 0;border-radius:0 6px 6px 0;">
            <span style="font-size:17px;font-weight:bold;">${serviceDate}</span>
          </div>
          ${nextWeekHtml}
          ${customHtml}
          <hr style="border:none;border-top:1px solid #dee2e6;margin:20px 0;">
          <p style="color:#7f8c8d;font-size:13px;margin:0;">
            McLean Presbyterian Church<br>
            Sunday Duty Deacon Rotation Scheduler
          </p>
        </div>
      </div>
    `
  };

  if (finalCC.length > 0) {
    mailOptions.cc = finalCC.join(', ');
  }

  await transport.sendMail(mailOptions);
}

/**
 * Remind an assigned deacon of their upcoming duty date.
 * reminderType: 'first' (heads-up ~7 days out) or 'final' (close-in reminder)
 */
async function sendDutyReminder(email, name, formattedDate, locationName, reminderType, portalUrl, customMessage) {
  const transport = getTransporter();

  const isFinal = reminderType === 'final';
  const subject = isFinal
    ? `Reminder: Your Sunday Duty Is Coming Up — ${formattedDate}`
    : `Heads-Up: You Are Serving Next Sunday, ${formattedDate}`;
  const headline = isFinal
    ? 'Upcoming Sunday Duty Reminder'
    : 'You Are Serving Next Sunday';
  const bodyText = isFinal
    ? `Your Sunday Duty Deacon service at ${locationName} is just a few days away. Please plan accordingly.`
    : `You are included in next week's Sunday Duty Deacon rotation at ${locationName}. Please plan accordingly.`;

  const customBlock = customMessage
    ? `\n\n${customMessage}`
    : '';
  const customHtmlBlock = customMessage
    ? `<div style="background:#f0f4f8;border-left:4px solid #1B3A5C;padding:12px 16px;margin:16px 0;border-radius:0 6px 6px 0;font-style:italic;">${escapeHtml(customMessage).replace(/\n/g, '<br>')}</div>`
    : '';

  await transport.sendMail({
    from: `"Sunday Duty Scheduler" <${process.env.SMTP_USER || 'noreply@localhost'}>`,
    to: email,
    subject,
    text: [
      `Dear ${name},`,
      '',
      bodyText,
      '',
      `Date: ${formattedDate}`,
      `Location: ${locationName}`,
      customBlock,
      '',
      `Log in to view your full schedule: ${portalUrl}`,
      '',
      'Thank you for your service.',
      '',
      '— Sunday Duty Deacon Rotation Scheduler'
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1B3A5C;padding:20px 24px;border-radius:6px 6px 0 0;">
          <h2 style="color:#fff;margin:0;font-size:20px;">${headline}</h2>
        </div>
        <div style="padding:24px;border:1px solid #dee2e6;border-top:none;border-radius:0 0 6px 6px;">
          <p>Dear <strong>${name}</strong>,</p>
          <p>${bodyText}</p>
          <div style="background:#fff8e1;border-left:4px solid #C5963A;padding:14px 18px;margin:20px 0;border-radius:0 6px 6px 0;">
            <strong>Date:</strong> ${formattedDate}<br>
            <strong>Location:</strong> ${locationName}
          </div>
          ${customHtmlBlock}
          <p style="margin:28px 0;">
            <a href="${portalUrl}"
               style="background:#1B3A5C;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">
              View My Schedule
            </a>
          </p>
          <p style="color:#7f8c8d;font-size:13px;">
            Thank you for your service to McLean Presbyterian Church.
          </p>
        </div>
      </div>
    `
  });
}

/**
 * Notify a list of admins/overseers that a swap was accepted.
 */
async function sendSwapApprovedNotification(notifyEmails, requesterName, targetName, requesterAssignment, targetAssignment, scheduleAttachment) {
  const transport = getTransporter();

  const mailOptions = {
    from: `"Sunday Duty Scheduler" <${process.env.SMTP_USER || 'noreply@localhost'}>`,
    bcc: notifyEmails.join(', '),
    subject: `Schedule Swap Approved — ${requesterName} & ${targetName}`,
    text: [
      'A duty deacon schedule swap has been approved.',
      '',
      `  ${requesterName} will now serve on: ${requesterAssignment.date} — ${requesterAssignment.location_name}`,
      `  ${targetName} will now serve on:    ${targetAssignment.date} — ${targetAssignment.location_name}`,
      '',
      scheduleAttachment ? 'The updated schedule is attached.' : '',
      '',
      '— Sunday Duty Deacon Rotation Scheduler'
    ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1B3A5C;padding:20px 24px;border-radius:6px 6px 0 0;">
          <h2 style="color:#fff;margin:0;font-size:20px;">Schedule Swap Approved</h2>
        </div>
        <div style="padding:24px;border:1px solid #dee2e6;border-top:none;border-radius:0 0 6px 6px;">
          <p>A duty deacon schedule swap has been approved.</p>
          <table style="border-collapse:collapse;width:100%;margin:16px 0;">
            <tr style="background:#f0f4f8;">
              <td style="padding:10px;border:1px solid #cdd9e8;font-weight:bold;">${requesterName}</td>
              <td style="padding:10px;border:1px solid #cdd9e8;">will now serve on <strong>${requesterAssignment.date}</strong> — ${requesterAssignment.location_name}</td>
            </tr>
            <tr>
              <td style="padding:10px;border:1px solid #cdd9e8;font-weight:bold;">${targetName}</td>
              <td style="padding:10px;border:1px solid #cdd9e8;">will now serve on <strong>${targetAssignment.date}</strong> — ${targetAssignment.location_name}</td>
            </tr>
          </table>
          ${scheduleAttachment ? '<p style="color:#555;font-size:13px;">The updated schedule is attached as an Excel file.</p>' : ''}
          <p style="color:#7f8c8d;font-size:13px;">This is an automated notice from the Sunday Duty Deacon Rotation Scheduler.</p>
        </div>
      </div>
    `
  };

  if (scheduleAttachment) {
    mailOptions.attachments = [{
      filename: scheduleAttachment.filename,
      content: scheduleAttachment.buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }];
  }

  await transport.sendMail(mailOptions);
}

/**
 * Send a password reset link to an admin.
 */
async function sendAdminPasswordReset(email, name, token) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const link = `${appUrl}/admin/reset-password?token=${token}`;
  const transport = getTransporter();

  await transport.sendMail({
    from: `"Sunday Duty Scheduler" <${process.env.SMTP_USER || 'noreply@localhost'}>`,
    to: email,
    subject: 'Admin Password Reset — Sunday Duty Deacon Rotation Scheduler',
    text: [
      `Hello ${name},`,
      '',
      'We received a request to reset your admin password for the Sunday Duty Deacon Rotation Scheduler.',
      '',
      'Click the link below to choose a new password:',
      link,
      '',
      'This link will expire in 1 hour.',
      '',
      'If you did not request a password reset, you can safely ignore this email.',
      '',
      '— Sunday Duty Deacon Rotation Scheduler'
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1B3A5C;padding:20px 24px;border-radius:6px 6px 0 0;">
          <h2 style="color:#fff;margin:0;font-size:20px;">Admin Password Reset</h2>
        </div>
        <div style="padding:24px;border:1px solid #dee2e6;border-top:none;border-radius:0 0 6px 6px;">
          <p>Hello <strong>${name}</strong>,</p>
          <p>We received a request to reset your admin password for the Sunday Duty Deacon Rotation Scheduler.</p>
          <p style="margin:28px 0;">
            <a href="${link}"
               style="background:#1B3A5C;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">
              Reset My Password
            </a>
          </p>
          <p style="color:#7f8c8d;font-size:13px;">This link expires in 1 hour and can only be used once.</p>
          <p style="color:#7f8c8d;font-size:13px;">If you did not request a password reset, you can safely ignore this email.</p>
        </div>
      </div>
    `
  });

  return link;
}

/**
 * Notify a deacon that the availability window is now open for a new period.
 */
async function sendAvailabilityOpenNotification(email, name, magicLinkUrl, startDate, endDate, deadline, customMessage) {
  const appUrl    = process.env.APP_URL || 'http://localhost:3000';
  const loginUrl  = `${appUrl}/candidate/login`;
  const linkUrl   = magicLinkUrl || loginUrl;
  const transport = getTransporter();

  const fmt = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const startFmt   = fmt(startDate);
  const endFmt     = fmt(endDate);
  const deadlineFmt = deadline ? new Date(deadline).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : null;

  const customBlock     = customMessage ? `\n\n${customMessage}` : '';
  const customHtmlBlock = customMessage
    ? `<div style="background:#f0f4f8;border-left:4px solid #1B3A5C;padding:12px 16px;margin:16px 0;border-radius:0 6px 6px 0;font-style:italic;">${escapeHtml(customMessage).replace(/\n/g, '<br>')}</div>`
    : '';

  await transport.sendMail({
    from: `"Sunday Duty Scheduler" <${process.env.SMTP_USER || 'noreply@localhost'}>`,
    to: email,
    subject: `Action Required — Submit Your Availability for Sunday Duty (${startFmt} – ${endFmt})`,
    text: [
      `Dear ${name},`,
      '',
      `The availability window is now open for the next Sunday Duty Deacon scheduling period.`,
      '',
      `Scheduling period: ${startFmt} – ${endFmt}`,
      deadlineFmt ? `Availability deadline: ${deadlineFmt}` : '',
      customBlock,
      '',
      `Please log in to your portal and mark any Sundays you are NOT available to serve.`,
      `If you have no conflicts, simply save with nothing selected — we will assume you are available for all Sundays.`,
      '',
      `Log in here: ${linkUrl}`,
      '',
      'Thank you for your service.',
      '',
      '— Sunday Duty Deacon Rotation Scheduler'
    ].filter(l => l !== null).join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1B3A5C;padding:20px 24px;border-radius:6px 6px 0 0;">
          <h2 style="color:#fff;margin:0;font-size:20px;">Availability Window Now Open</h2>
        </div>
        <div style="padding:24px;border:1px solid #dee2e6;border-top:none;border-radius:0 0 6px 6px;">
          <p>Dear <strong>${escapeHtml(name)}</strong>,</p>
          <p>The availability window is now open for the next Sunday Duty Deacon scheduling period.</p>
          <div style="background:#fff8e1;border-left:4px solid #C5963A;padding:14px 18px;margin:20px 0;border-radius:0 6px 6px 0;">
            <strong>Scheduling period:</strong> ${escapeHtml(startFmt)} &ndash; ${escapeHtml(endFmt)}<br>
            ${deadlineFmt ? `<strong>Submission deadline:</strong> ${escapeHtml(deadlineFmt)}` : ''}
          </div>
          ${customHtmlBlock}
          <p>
            Please log in to your portal and mark any Sundays you are <strong>not</strong> available to serve.
            If you have no conflicts, simply save with nothing selected — we will assume you are available for all Sundays.
          </p>
          <p style="margin:28px 0;">
            <a href="${linkUrl}"
               style="background:#1B3A5C;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">
              Log In &amp; Submit Availability
            </a>
          </p>
          <p style="color:#7f8c8d;font-size:13px;">Thank you for your service to McLean Presbyterian Church.</p>
        </div>
      </div>
    `
  });
}

module.exports = { sendMagicLink, sendPasswordReset, sendAdminPasswordReset, sendSwapRequest, sendSwapResolved, sendSwapApprovedNotification, sendAvailabilityReminder, sendLoginFollowup, sendAdminInvite, sendDutyReminder, sendSundayDutyReminder, sendAvailabilityOpenNotification };
