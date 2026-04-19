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

module.exports = { sendMagicLink };
