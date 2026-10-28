// SQL for Super Admin user management. Every function takes `db` (the pool or a transaction client).
// Never selects legacy_password.
const ROLE_ORDER = ['EMPLOYEE', 'ENGINEER', 'ADMIN', 'SUPER_ADMIN'];

const USER_COLUMNS = `u.id, u.login_type, u.its_number, u.employee_id, u.name, u.name_arabic,
  u.email, u.mobile, u.source, u.is_active, u.must_change_password, u.created_at`;

// Active departments of user u: from Idarah posts and from the HR list (Phase 3.1).
const USER_DEPT_IDS = `(SELECT p.department_id FROM user_posts p WHERE p.user_id = u.id AND p.is_active
                        UNION SELECT h.department_id FROM user_departments h WHERE h.user_id = u.id AND h.is_active)`;

// LIKE pattern from user input: escape the wildcards, match anywhere.
const likePattern = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

async function listUsers(db, { q, role, active, source, companyId, limit, offset }) {
  const pattern = q ? likePattern(q) : null;
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS},
            COALESCE((SELECT array_agg(r.role::text ORDER BY r.role) FROM user_roles r WHERE r.user_id = u.id), '{}') AS roles,
            sc.code AS company_code, sc.name AS company_name, o.name AS occupation_name,
            COALESCE((SELECT array_agg(DISTINCT d.name ORDER BY d.name)
                        FROM departments d
                       WHERE d.id IN ${USER_DEPT_IDS} AND d.name IS NOT NULL), '{}') AS departments,
            count(*) OVER () AS total
       FROM users u
       LEFT JOIN user_company uc ON uc.user_id = u.id
       LEFT JOIN service_units sc ON sc.id = uc.service_unit_id
       LEFT JOIN occupations o ON o.id = uc.occupation_id
      WHERE ($1::text IS NULL
             OR u.name ILIKE $1 OR u.name_arabic ILIKE $1
             OR u.its_number LIKE $1 OR u.employee_id LIKE $1
             OR ('Employee ' || u.employee_id) ILIKE $1
             OR EXISTS (SELECT 1 FROM departments d
                         WHERE d.id IN ${USER_DEPT_IDS}
                           AND (d.name ILIKE $1 OR d.name_arabic ILIKE $1)))
        AND ($2::app_role IS NULL OR EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = $2::app_role))
        AND ($3::boolean IS NULL OR u.is_active = $3::boolean)
        AND ($4::user_source IS NULL OR u.source = $4::user_source)
        AND ($7::bigint IS NULL OR uc.service_unit_id = $7::bigint)
      ORDER BY u.name IS NULL, lower(u.name), length(u.employee_id), u.employee_id, u.its_number, u.id
      LIMIT $5::int OFFSET $6::int`,
    [pattern, role || null, active ?? null, source || null, limit, offset, companyId || null]
  );
  return { rows, total: rows.length ? Number(rows[0].total) : 0 };
}

async function getUser(db, id) {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1::bigint`, [id]);
  return rows[0] || null;
}

async function getRoles(db, id) {
  const { rows } = await db.query('SELECT role::text AS role FROM user_roles WHERE user_id = $1::bigint', [id]);
  const have = new Set(rows.map((r) => r.role));
  return ROLE_ORDER.filter((r) => have.has(r));
}

// The one company the user works for as Admin / Staff, with their occupation (or null).
async function getUserCompany(db, id) {
  const { rows } = await db.query(
    `SELECT uc.service_unit_id AS company_id, s.code AS company_code, s.name AS company_name,
            uc.occupation_id, o.name AS occupation_name
       FROM user_company uc JOIN service_units s ON s.id = uc.service_unit_id
       LEFT JOIN occupations o ON o.id = uc.occupation_id
      WHERE uc.user_id = $1::bigint`,
    [id]
  );
  return rows[0] || null;
}

async function setUserCompany(db, id, companyId, occupationId, by) {
  await db.query(
    `INSERT INTO user_company (user_id, service_unit_id, occupation_id, granted_by)
     VALUES ($1::bigint, $2::bigint, $3::bigint, $4::bigint)
     ON CONFLICT (user_id) DO UPDATE SET service_unit_id = EXCLUDED.service_unit_id, occupation_id = EXCLUDED.occupation_id`,
    [id, companyId, occupationId ?? null, by]
  );
}

async function setOccupation(db, id, occupationId) {
  await db.query('UPDATE user_company SET occupation_id = $2::bigint WHERE user_id = $1::bigint', [id, occupationId ?? null]);
}

// Leaves the company (no Admin / Staff role left). The change log keeps the history.
async function clearUserCompany(db, id) {
  await db.query('DELETE FROM user_company WHERE user_id = $1::bigint', [id]);
}

async function getCompany(db, id) {
  if (!/^\d{1,18}$/.test(String(id ?? ''))) return null;
  const { rows } = await db.query('SELECT id, code, name, is_active FROM service_units WHERE id = $1::bigint', [id]);
  return rows[0] || null;
}

async function getOccupation(db, id) {
  if (!/^\d{1,18}$/.test(String(id ?? ''))) return null;
  const { rows } = await db.query('SELECT id, service_unit_id, name, is_active FROM occupations WHERE id = $1::bigint', [id]);
  return rows[0] || null;
}

async function getPosts(db, id) {
  const { rows } = await db.query(
    `SELECT d.name AS department, d.name_arabic AS department_arabic, p.post, p.post_tbq, p.is_active
       FROM user_posts p JOIN departments d ON d.id = p.department_id
      WHERE p.user_id = $1::bigint
      ORDER BY p.is_active DESC, d.name, p.post`,
    [id]
  );
  return rows;
}

// Departments from the HR list (Phase 3.1), with location.
async function getHrDepartments(db, id) {
  const { rows } = await db.query(
    `SELECT d.name AS department, d.name_arabic AS department_arabic, d.building, d.floor, d.room_no, h.is_active
       FROM user_departments h JOIN departments d ON d.id = h.department_id
      WHERE h.user_id = $1::bigint
      ORDER BY h.is_active DESC, d.name`,
    [id]
  );
  return rows;
}

// Status changes and other changes, newest first, with the Super Admin's name.
async function getHistory(db, id, limit = 50) {
  const { rows } = await db.query(
    `SELECT h.kind, h.action, h.detail, h.reason, h.source, h.created_at, b.name AS by_name,
            b.its_number AS by_its, b.employee_id AS by_employee_id
       FROM (
         SELECT 'status' AS kind, CASE WHEN is_active THEN 'activated' ELSE 'deactivated' END AS action,
                NULL::jsonb AS detail, reason, source, changed_by, created_at, id
           FROM user_status_log WHERE user_id = $1::bigint
         UNION ALL
         SELECT 'change', action, detail, NULL, 'super_admin', changed_by, created_at, id
           FROM user_change_log WHERE user_id = $1::bigint
       ) h
       LEFT JOIN users b ON b.id = h.changed_by
      ORDER BY h.created_at DESC, h.kind, h.id DESC
      LIMIT $2::int`,
    [id, limit]
  );
  return rows;
}

async function idTaken(db, { itsNumber, employeeId }) {
  const { rows } = await db.query(
    `SELECT 1 FROM users WHERE ($1::text IS NOT NULL AND its_number = $1::text)
                            OR ($2::text IS NOT NULL AND employee_id = $2::text) LIMIT 1`,
    [itsNumber ?? null, employeeId ?? null]
  );
  return rows.length > 0;
}

async function insertUser(db, u) {
  const { rows } = await db.query(
    `INSERT INTO users (login_type, its_number, employee_id, legacy_password, name, email, mobile, source)
     VALUES ($1::login_type, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, 'manual')
     RETURNING id`,
    [u.loginType, u.itsNumber ?? null, u.employeeId ?? null, u.password ?? null, u.name ?? null, u.email ?? null, u.mobile ?? null]
  );
  return String(rows[0].id);
}

async function updateProfile(db, id, fields) {
  const sets = [];
  const params = [id];
  for (const [key, col] of [['name', 'name'], ['email', 'email'], ['mobile', 'mobile']]) {
    if (key in fields) {
      params.push(fields[key]);
      sets.push(`${col} = $${params.length}::text`);
    }
  }
  if (!sets.length) return;
  await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1::bigint`, params);
}

async function addRole(db, id, role, by) {
  const { rowCount } = await db.query(
    `INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1::bigint, $2::app_role, $3::bigint)
     ON CONFLICT (user_id, role) DO NOTHING`,
    [id, role, by]
  );
  return rowCount === 1;
}

async function removeRole(db, id, role) {
  const { rowCount } = await db.query(
    'DELETE FROM user_roles WHERE user_id = $1::bigint AND role = $2::app_role',
    [id, role]
  );
  return rowCount === 1;
}

async function countActiveSuperAdmins(db) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM user_roles r JOIN users u ON u.id = r.user_id
      WHERE r.role = 'SUPER_ADMIN' AND u.is_active`
  );
  return rows[0].n;
}

async function setActive(db, id, isActive) {
  await db.query('UPDATE users SET is_active = $2::boolean WHERE id = $1::bigint', [id, isActive]);
}

async function logStatus(db, id, isActive, reason, by) {
  await db.query(
    `INSERT INTO user_status_log (user_id, is_active, source, reason, changed_by)
     VALUES ($1::bigint, $2::boolean, 'super_admin', $3::text, $4::bigint)`,
    [id, isActive, reason, by]
  );
}

async function logChange(db, id, action, detail, by) {
  await db.query(
    `INSERT INTO user_change_log (user_id, action, detail, changed_by)
     VALUES ($1::bigint, $2::text, $3::jsonb, $4::bigint)`,
    [id, action, detail ? JSON.stringify(detail) : null, by]
  );
}

module.exports = {
  listUsers,
  getUser,
  getRoles,
  getUserCompany,
  setUserCompany,
  setOccupation,
  clearUserCompany,
  getCompany,
  getOccupation,
  getPosts,
  getHrDepartments,
  getHistory,
  idTaken,
  insertUser,
  updateProfile,
  addRole,
  removeRole,
  countActiveSuperAdmins,
  setActive,
  logStatus,
  logChange,
};
