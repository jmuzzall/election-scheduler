const nodemailer = require('nodemailer');

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
async function sendAvailabilityReminder(email, name, deadlineFormatted, reminderType) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const link = `${appUrl}/candidate/login`;
  const transport = getTransporter();

  const timeLabel = reminderType === '24h' ? '24 hours' : '48 hours';
  const urgency   = reminderType === '24h' ? 'FINAL REMINDER: ' : '';

  await transport.sendMail({
    from: `"Sunday Duty Scheduler" <${process.env.SMTP_USER || 'noreply@localhost'}>`,
    to: email,
    subject: `${urgency}Please Submit Your Blackout Dates — ${timeLabel} Remaining`,
    text: [
      `Dear ${name},`,
      '',
      `You have not yet entered your blackout dates for Sunday duty deacon service.`,
      '',
      `Please do so before the deadline of ${deadlineFormatted}, before the window closes (approximately ${timeLabel} from now).`,
      '',
      `If you do not have any blackout dates, please log in and confirm your availability ` +
      `anyway — otherwise we will assume you are available for all Sundays in the scheduling period.`,
      '',
      `Log in here: ${link}`,
      '',
      'Thank you for your service.',
      '',
      '— Sunday Duty Scheduler'
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
          <p>You have not yet entered your blackout dates for Sunday duty deacon service.</p>
          <div style="background:#fff8e1;border-left:4px solid #C5963A;padding:14px 18px;margin:20px 0;border-radius:0 6px 6px 0;">
            <strong>Deadline:</strong> ${deadlineFormatted}<br>
            <strong>Time remaining:</strong> approximately ${timeLabel}
          </div>
          <p>
            If you do not have any blackout dates, please log in and confirm your availability
            anyway — otherwise we will assume you are available for <em>all</em> Sundays in
            the scheduling period.
          </p>
          <p style="margin:28px 0;">
            <a href="${link}"
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

module.exports = { sendMagicLink, sendPasswordReset, sendSwapRequest, sendSwapResolved, sendAvailabilityReminder };
