// User queries for auth. Never SELECT * on users.
// legacy_password is read ONLY by findEmployeeForLogin (and later by change/reset password).
const pool = require('../../db/pool');

async function findEmployeeForLogin(employeeId) {
  const { rows } = await pool.query(
    `SELECT id, is_active, legacy_password
       FROM users
      WHERE login_type = 'EMPLOYEE_ID' AND employee_id = $1::text`,
    [employeeId]
  );
  return rows[0] || null;
}

async function findItsUser(itsNumber) {
  const { rows } = await pool.query(
    `SELECT id, is_active
       FROM users
      WHERE login_type = 'ITS' AND its_number = $1::text`,
    [itsNumber]
  );
  return rows[0] || null;
}

// Session view of a user: profile fields + granted roles (enum order: EMPLOYEE, ENGINEER, SUPER_ADMIN).
async function loadSessionUser(userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.login_type, u.its_number, u.employee_id, u.name, u.email, u.is_active,
            COALESCE(array_agg(r.role::text ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
       FROM users u
       LEFT JOIN user_roles r ON r.user_id = u.id
      WHERE u.id = $1::bigint
      GROUP BY u.id`,
    [userId]
  );
  return rows[0] || null;
}

module.exports = { findEmployeeForLogin, findItsUser, loadSessionUser };
