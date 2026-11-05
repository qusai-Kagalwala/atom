// Super Admin → Settings → Email design: sample emails for the live preview and the test email.
// The design itself is stored and checked in services/emailDesign.js.
const defaultPool = require('../../db/pool');
const { config } = require('../../config/env');
const { HttpError } = require('../../utils/httpError');
const design = require('../../services/emailDesign');
const mailer = require('../../services/mailer');
const notificationEmail = require('../notifications/email');
const { passEmail } = require('../wifi/wifi.service');
const { resetEmail } = require('../auth/passwords.service');

const SAMPLES = ['ticket', 'request', 'wifi', 'reset'];
const SUBJECTS = {
  ticket: 'ATOM: T-1001 resolved, ready to close',
  request: 'ATOM: R-204 approved',
  wifi: 'Your guest Wi-Fi pass — Aljamea-tus-Saifiyah',
  reset: 'Reset your ATOM password',
};

// Fake data only — nothing here comes from the database.
function sample(kind, company, d) {
  const soon = new Date(Date.now() + 3 * 3600 * 1000);
  switch (kind) {
    case 'request':
      return notificationEmail.render(
        { type: 'ticket.items_decided', title: 'R-204 approved', body: 'Keyboard, Mouse — approved. An engineer will hand them over.', link: '/tickets/R-204' },
        { number: 204, type: 'SERVICE_REQUEST', status: 'APPROVED', due_by: soon },
        d,
        company
      );
    case 'wifi':
      return passEmail(
        { recipient_name: 'Sample Guest', ssid: 'Guest-WiFi', username: 'guest-0001', password: 'Sample#123', expires_at: new Date(Date.now() + 2 * 86400 * 1000) },
        company,
        d
      );
    case 'reset':
      return resetEmail(`${config.appUrl}/reset-password?token=sample-link-only`, d);
    case 'ticket':
    default:
      return notificationEmail.render(
        { type: 'ticket.resolve', title: 'T-1001 resolved, ready to close', body: 'Projector in Room 12 shows no signal', link: '/tickets/T-1001' },
        { number: 1001, type: 'INCIDENT', status: 'IN_PROGRESS', due_by: soon },
        d,
        company
      );
  }
}

const cleanCompany = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 40) : '');

// Draft design → HTML for the preview. Nothing is saved.
function preview(input, { sample: kind = 'ticket', company = '' } = {}) {
  if (!SAMPLES.includes(kind)) throw new HttpError(400, 'Choose a sample email.', 'invalid');
  const d = design.validate(input, { strict: false });
  return { html: sample(kind, kind === 'reset' ? '' : cleanCompany(company), d).html };
}

// Send the draft (or saved) design to the Super Admin's own email address.
async function sendTest(user, input, { sample: kind = 'ticket', company = '' } = {}, { db = defaultPool, send = mailer.sendMail } = {}) {
  if (!SAMPLES.includes(kind)) throw new HttpError(400, 'Choose a sample email.', 'invalid');
  const d = input ? design.validate(input) : await design.current(db);
  if (!config.smtp.host) throw new HttpError(503, 'Email is not set up on the server (SMTP).', 'smtp_missing');
  const { rows } = await db.query('SELECT email FROM users WHERE id = $1::bigint', [user.id]);
  const to = rows[0]?.email?.trim();
  if (!to || !to.includes('@')) throw new HttpError(400, 'Your account has no email address in ATOM.', 'no_email');
  const mail = sample(kind, kind === 'reset' ? '' : cleanCompany(company), d);
  try {
    await send({ to, subject: `[Test] ${SUBJECTS[kind]}`, text: mail.text, html: mail.html });
  } catch (err) {
    console.error('[ATOM] Test email failed:', err.message); // never the body
    throw new HttpError(502, 'Could not send the test email. Check the SMTP settings.', 'send_failed');
  }
  return { sent: true, to };
}

async function overview(db = defaultPool) {
  design.clearCache(); // always show what is stored, not this process's cached copy
  return {
    design: await design.current(db),
    defaults: design.DEFAULTS,
    palettes: design.PALETTES,
    styles: design.STYLES,
    smtpConfigured: Boolean(config.smtp.host),
    history: await design.history(db),
  };
}

module.exports = { preview, sendTest, overview, SAMPLES };
