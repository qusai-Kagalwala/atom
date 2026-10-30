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

// Session view of a user: profile fields, granted roles (enum order: EMPLOYEE, ENGINEER, ADMIN,
// SUPER_ADMIN), the one company they work for as Admin / Staff (+ occupation), and — when
// companyId is given — that company if it exists and is active (else company = null).
async function loadSessionUser(userId, companyId = null) {
  const { rows } = await pool.query(
    `SELECT u.id, u.login_type, u.its_number, u.employee_id, u.name, u.name_arabic, u.name_language,
            u.email, u.is_active, u.session_version, u.must_change_password,
            COALESCE(array_agg(r.role::text ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles,
            uc.service_unit_id AS staff_company_id, sc.code AS staff_company_code, sc.name AS staff_company_name,
            uc.occupation_id, o.name AS occupation_name,
            (SELECT json_build_object('id', s.id::text, 'code', s.code, 'name', s.name, 'assistant', s.assistant_enabled)
               FROM service_units s WHERE s.id = $2::bigint AND s.is_active) AS company
       FROM users u
       LEFT JOIN user_roles r ON r.user_id = u.id
       LEFT JOIN user_company uc ON uc.user_id = u.id
       LEFT JOIN service_units sc ON sc.id = uc.service_unit_id
       LEFT JOIN occupations o ON o.id = uc.occupation_id
      WHERE u.id = $1::bigint
      GROUP BY u.id, uc.user_id, sc.id, o.id`,
    [userId, companyId]
  );
  return rows[0] || null;
}

// Companies people can choose after login (active ones, in picker order).
async function listCompanies() {
  const { rows } = await pool.query(
    `SELECT id::text AS id, code, name, tagline FROM service_units WHERE is_active ORDER BY sort_order, id`
  );
  return rows;
}

// 'en' | 'ar'. Arabic only when the user has an Arabic name (checked here, not just in the UI).
async function setNameLanguage(userId, language) {
  const { rowCount } = await pool.query(
    `UPDATE users SET name_language = $2::text
      WHERE id = $1::bigint AND ($2::text = 'en' OR name_arabic IS NOT NULL)`,
    [userId, language]
  );
  return rowCount === 1;
}

module.exports = { findEmployeeForLogin, findItsUser, loadSessionUser, listCompanies, setNameLanguage };
