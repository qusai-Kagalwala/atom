// Password + reset-token queries (employee-ID users only).
// This file and users.repo.findEmployeeForLogin are the ONLY places that read legacy_password.
const pool = require('../../db/pool');

async function getEmployeePassword(userId) {
  const { rows } = await pool.query(
    `SELECT legacy_password
       FROM users
      WHERE id = $1::bigint AND login_type = 'EMPLOYEE_ID'`,
    [userId]
  );
  return rows[0]?.legacy_password ?? null;
}

// Also bumps session_version, which signs the user out on every device (tokens carry the old one).
// → the new session_version, or null if no such employee-ID user.
async function setEmployeePassword(userId, newPassword, db = pool) {
  const { rows } = await db.query(
    `UPDATE users SET legacy_password = $2::text, session_version = session_version + 1
      WHERE id = $1::bigint AND login_type = 'EMPLOYEE_ID'
      RETURNING session_version`,
    [userId, newPassword]
  );
  return rows[0] ? rows[0].session_version : null;
}

async function findEmployeeForReset(employeeId) {
  const { rows } = await pool.query(
    `SELECT id, is_active, email
       FROM users
      WHERE login_type = 'EMPLOYEE_ID' AND employee_id = $1::text`,
    [employeeId]
  );
  return rows[0] || null;
}

// Makes every earlier unused link for this user invalid, then stores the new token hash.
async function replaceResetToken(userId, tokenHash, minutes) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expireResetTokens(userId, client);
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1::bigint, $2::text, now() + make_interval(mins => $3::int))`,
      [userId, tokenHash, minutes]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function expireResetTokens(userId, db = pool) {
  await db.query(
    `UPDATE password_reset_tokens SET used_at = now()
      WHERE user_id = $1::bigint AND used_at IS NULL`,
    [userId]
  );
}

// Locks a valid (unused, unexpired) token for an active employee-ID user. Use inside a transaction.
async function lockValidResetToken(tokenHash, client) {
  const { rows } = await client.query(
    `SELECT t.id, t.user_id, u.legacy_password, u.is_active
       FROM password_reset_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1::text
        AND t.used_at IS NULL
        AND t.expires_at > now()
        AND u.login_type = 'EMPLOYEE_ID'
        FOR UPDATE OF t`,
    [tokenHash]
  );
  return rows[0] || null;
}

module.exports = {
  getEmployeePassword,
  setEmployeePassword,
  findEmployeeForReset,
  replaceResetToken,
  expireResetTokens,
  lockValidResetToken,
};
