// Change / forgot / reset password — EMPLOYEE-ID users only (ITS passwords live on eJamaat).
// Passwords are stored in plain text by client decision (ATOM_Decisions.md §2).
// Reset tokens: 32 random bytes, emailed once, stored only as SHA-256, single use, 30 minutes.
// SECURITY: never log passwords, tokens or reset links.
const crypto = require('crypto');
const pool = require('../../db/pool');
const { config } = require('../../config/env');
const { sendMail } = require('../../services/mailer');
const safeCompare = require('../../utils/safeCompare');
const repo = require('./passwords.repo');
const { signSession } = require('./tokens');
const realtime = require('../../realtime');

const MIN_LENGTH = 8;
const MAX_LENGTH = 256;

const MSG = {
  itsUser: 'ITS passwords are changed on eJamaat, not in ATOM.',
  itsNumber: 'Using your ITS number? Reset your password on eJamaat.',
  wrongCurrent: 'Your current password is incorrect.',
  tooShort: `Your new password must be at least ${MIN_LENGTH} characters.`,
  tooLong: `Your new password must be at most ${MAX_LENGTH} characters.`,
  sameAsCurrent: 'Your new password must be different from your current one.',
  changed: 'Your password has been changed.',
  sent: (masked) => `A reset link has been sent to ${masked}. It expires in ${config.passwordResetMinutes} minutes.`,
  noEmail: 'No email is on file for this Employee ID. Please contact a Super Admin to reset your password.',
  sendFailed: 'Could not send the reset email. Please try again later.',
  badLink: 'This reset link is invalid or has expired. Please request a new one.',
  reset: 'Your password has been reset. You can now sign in.',
};

class PasswordError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const hashToken = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

// a.b@x.edu → a***@x.edu
function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!domain) return 'your email';
  return `${local.slice(0, 1)}***@${domain}`;
}

function checkNewPassword(newPassword, currentPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < MIN_LENGTH) {
    throw new PasswordError(400, MSG.tooShort, 'too_short');
  }
  if (newPassword.length > MAX_LENGTH) throw new PasswordError(400, MSG.tooLong, 'too_long');
  if (currentPassword != null && safeCompare(newPassword, currentPassword)) {
    throw new PasswordError(400, MSG.sameAsCurrent, 'same_as_current');
  }
}

// Logged-in employee-ID user, from the profile page.
// keepSocketId: this device's Socket.IO id (X-Socket-Id header), so only OTHER devices are dropped.
async function changePassword(user, currentPassword, newPassword, { keepSocketId } = {}) {
  if (user.loginType !== 'EMPLOYEE_ID') throw new PasswordError(400, MSG.itsUser, 'its_user');

  const stored = await repo.getEmployeePassword(user.id);
  if (stored == null) throw new PasswordError(400, MSG.itsUser, 'its_user');
  if (!safeCompare(String(currentPassword ?? ''), stored)) {
    throw new PasswordError(400, MSG.wrongCurrent, 'wrong_current');
  }
  checkNewPassword(newPassword, stored);

  const version = await repo.setEmployeePassword(user.id, newPassword);
  await repo.expireResetTokens(user.id); // any outstanding reset link is now useless
  const except = /^[A-Za-z0-9_-]{1,64}$/.test(String(keepSocketId || '')) ? keepSocketId : undefined;
  realtime.disconnectUser(user.id, { except }); // other devices' live connections drop now; their next request gets 401
  // Other devices are signed out (session_version went up). This device gets a fresh token and stays in.
  return { message: MSG.changed, token: signSession(user.id, user.activeRole, version) };
}

function resetEmail(link) {
  const minutes = config.passwordResetMinutes;
  return {
    subject: 'Reset your ATOM password',
    text: [
      'We received a request to reset your ATOM password.',
      `Open this link within ${minutes} minutes to choose a new one:`,
      link,
      '',
      'If you did not ask for this, you can ignore this email — your password will not change.',
      '',
      'ATOM · AVIT Ticketing & Operations Manager · Aljamea-tus-Saifiyah',
    ].join('\n'),
    html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#1A1A1A;max-width:520px">
  <p>We received a request to reset your ATOM password. Open the link below within ${minutes} minutes to choose a new one.</p>
  <p><a href="${link}" style="display:inline-block;background:#0F5B5A;color:#FFFFFF;padding:10px 18px;border-radius:8px;text-decoration:none">Reset password</a></p>
  <p style="color:#4B5563;font-size:13px">If you did not ask for this, you can ignore this email — your password will not change.</p>
  <p style="color:#8C7B6B;font-size:12px">ATOM · AVIT Ticketing &amp; Operations Manager · Aljamea-tus-Saifiyah</p>
</div>`,
  };
}

// Public. Unknown, inactive and no-email IDs all get the same "contact a Super Admin" answer.
async function requestReset(employeeId) {
  if (/^\d{8}$/.test(employeeId)) throw new PasswordError(400, MSG.itsNumber, 'its_number');

  const employee = await repo.findEmployeeForReset(employeeId);
  if (!employee || !employee.is_active || !employee.email) {
    return { sent: false, message: MSG.noEmail };
  }

  const token = crypto.randomBytes(32).toString('base64url');
  await repo.replaceResetToken(employee.id, hashToken(token), config.passwordResetMinutes);

  const link = `${config.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    await sendMail({ to: employee.email, ...resetEmail(link) });
  } catch (err) {
    console.error(`Reset email failed for user ${employee.id}: ${err.message}`);
    await repo.expireResetTokens(employee.id);
    throw new PasswordError(502, MSG.sendFailed, 'send_failed');
  }
  return { sent: true, message: MSG.sent(maskEmail(employee.email)) };
}

// Public. Single use: the token is locked, checked and burned in one transaction.
async function resetPassword(token, newPassword) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    throw new PasswordError(400, MSG.badLink, 'bad_link');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await repo.lockValidResetToken(hashToken(token), client);
    if (!row || !row.is_active) {
      await client.query('ROLLBACK');
      throw new PasswordError(400, MSG.badLink, 'bad_link');
    }
    try {
      checkNewPassword(newPassword, row.legacy_password);
    } catch (err) {
      await client.query('ROLLBACK'); // link stays valid so the user can try another password
      throw err;
    }
    await repo.setEmployeePassword(row.user_id, newPassword, client);
    await repo.expireResetTokens(row.user_id, client);
    await client.query('COMMIT');
    realtime.disconnectUser(row.user_id); // signed out everywhere (session_version went up)
    return { message: MSG.reset };
  } catch (err) {
    if (!(err instanceof PasswordError)) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { changePassword, requestReset, resetPassword, PasswordError, MSG, maskEmail, hashToken };
