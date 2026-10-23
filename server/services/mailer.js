// Outgoing email over the client's SMTP (nodemailer). Transport is created on first use.
// SECURITY: never log message bodies (they can contain reset links).
const nodemailer = require('nodemailer');
const { config } = require('../config/env');

let transport = null;

function getTransport() {
  const { host, port, secure, user, password } = config.smtp;
  if (!host) throw new Error('SMTP_HOST is not set');
  if (!transport) {
    transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass: password } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transport;
}

async function sendMail({ to, subject, text, html }) {
  return getTransport().sendMail({ from: config.smtp.from, to, subject, text, html });
}

module.exports = { sendMail };
