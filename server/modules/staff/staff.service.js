// Staff and occupations of one company (decided 28 Oct 2026). The company's Admin (or the Super
// Admin inside the company) manages them; everything is limited to req.user.companyId.
//   - Each company keeps its own occupations (AVIT: Engineer · Siyanaat: Carpenter, Electrician, … ·
//     Tanzeem: Peon). Never deleted: switched off, and only once nobody active holds it.
//   - Staff = people holding the ENGINEER role here, each with one occupation. Someone who works for
//     another company can't be added (they must be removed there first). Admins are appointed by the
//     Super Admin only — not here.
//   - Same rules, lock and change log as Users & roles (users.service.js).
const pool = require('../../db/pool');
const users = require('../users/users.service');
const realtime = require('../../realtime');
const { HttpError, notFound } = require('../../utils/httpError');

const bad = (message, code) => new HttpError(400, message, code);
const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const isId = (v) => /^\d{1,18}$/.test(String(v ?? ''));
const OPEN = "('ASSIGNED','IN_PROGRESS','WAITING_FOR_USER','WAITING_FOR_EQUIPMENT')";

// ---------- occupations ----------
const toOccupation = (o) => ({ id: String(o.id), name: o.name, sortOrder: o.sort_order, isActive: o.is_active, staff: o.staff });

async function listOccupations(user, { includeInactive = false } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT o.id, o.name, o.sort_order, o.is_active,
            (SELECT count(*)::int FROM user_company uc
               JOIN user_roles r ON r.user_id = uc.user_id AND r.role = 'ENGINEER'
               JOIN users u ON u.id = uc.user_id AND u.is_active
              WHERE uc.occupation_id = o.id) AS staff
       FROM occupations o
      WHERE o.service_unit_id = $1::bigint ${includeInactive ? '' : 'AND o.is_active'}
      ORDER BY o.is_active DESC, o.sort_order, lower(o.name)`,
    [user.companyId]
  );
  return rows.map(toOccupation);
}

function readOccupation(body, current = {}) {
  const name = 'name' in body ? clean(body.name) : current.name;
  if (!name || name.length < 2 || name.length > 60) throw bad('Give the occupation a name (2–60 characters).', 'bad_name');
  const sortOrder = 'sortOrder' in body ? Number(body.sortOrder) : current.sort_order ?? 100;
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) throw bad('Order must be a whole number.', 'bad_order');
  if ('isActive' in body && typeof body.isActive !== 'boolean') throw bad('Bad status value.', 'invalid');
  const isActive = 'isActive' in body ? body.isActive : current.is_active ?? true;
  return { name, sortOrder, isActive };
}

const nameTaken = (err) => (err.code === '23505' ? new HttpError(409, 'This company already has an occupation with this name.', 'duplicate') : err);

async function createOccupation(user, body = {}) {
  const f = readOccupation(body);
  try {
    const { rows } = await pool.query(
      `INSERT INTO occupations (service_unit_id, name, sort_order, is_active, created_by)
       VALUES ($1::bigint, $2::text, $3::int, TRUE, $4::bigint) RETURNING id`,
      [user.companyId, f.name, f.sortOrder, user.id]
    );
    return (await listOccupations(user, { includeInactive: true })).find((o) => o.id === String(rows[0].id));
  } catch (err) {
    throw nameTaken(err);
  }
}

async function updateOccupation(user, id, body = {}) {
  if (!isId(id)) throw notFound();
  const { rows } = await pool.query('SELECT * FROM occupations WHERE id = $1::bigint AND service_unit_id = $2::bigint', [id, user.companyId]);
  const cur = rows[0];
  if (!cur) throw notFound();
  const f = readOccupation(body, cur);
  if (!f.isActive && cur.is_active) {
    const o = (await listOccupations(user, { includeInactive: true })).find((x) => x.id === String(id));
    if (o.staff) throw bad(`Move the ${o.staff} staff member(s) to another occupation first.`, 'occupation_in_use');
  }
  try {
    await pool.query(
      'UPDATE occupations SET name = $2::text, sort_order = $3::int, is_active = $4::boolean WHERE id = $1::bigint',
      [id, f.name, f.sortOrder, f.isActive]
    );
  } catch (err) {
    throw nameTaken(err);
  }
  return (await listOccupations(user, { includeInactive: true })).find((o) => o.id === String(id));
}

// ---------- staff ----------
function toStaff(r) {
  return {
    id: String(r.id),
    name: r.name,
    itsNumber: r.its_number || null,
    employeeId: r.employee_id || null,
    isActive: r.is_active,
    isAdmin: r.roles.includes('ADMIN'),
    isStaff: r.roles.includes('ENGINEER'),
    occupation: r.occupation_id ? { id: String(r.occupation_id), name: r.occupation_name } : null,
    openWork: r.open_work,
  };
}

const STAFF_SELECT = `
  SELECT u.id, COALESCE(u.name, 'Employee ' || u.employee_id) AS name, u.its_number, u.employee_id, u.is_active,
         ARRAY(SELECT r.role::text FROM user_roles r WHERE r.user_id = u.id ORDER BY r.role) AS roles,
         uc.occupation_id, o.name AS occupation_name, o.sort_order AS occupation_order,
         (SELECT count(*)::int FROM requests w WHERE w.assigned_engineer_id = u.id
             AND w.service_unit_id = uc.service_unit_id AND w.status IN ${OPEN}) AS open_work
    FROM user_company uc
    JOIN users u ON u.id = uc.user_id
    LEFT JOIN occupations o ON o.id = uc.occupation_id`;

// Staff and Admins of the company (Admins listed so they are visible; only Staff are managed here).
async function listStaff(user, db = pool) {
  const { rows } = await db.query(
    `${STAFF_SELECT}
      WHERE uc.service_unit_id = $1::bigint
        AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role IN ('ENGINEER', 'ADMIN'))
      ORDER BY u.is_active DESC, o.sort_order NULLS FIRST, lower(o.name) NULLS FIRST, lower(u.name)`,
    [user.companyId]
  );
  return rows.map(toStaff);
}

async function staffMember(db, user, userId) {
  if (!isId(userId)) return null;
  const { rows } = await db.query(`${STAFF_SELECT} WHERE uc.service_unit_id = $1::bigint AND u.id = $2::bigint`, [user.companyId, userId]);
  return rows[0] ? toStaff(rows[0]) : null;
}

// People search to add as staff: active people by name / ITS / employee ID. Those working for
// another company are flagged (they can't be added).
async function searchPeople(user, q) {
  const text = clean(q);
  if (text.length < 2) return [];
  const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await pool.query(
    `SELECT u.id, COALESCE(u.name, 'Employee ' || u.employee_id) AS name, u.its_number, u.employee_id,
            CASE WHEN EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role IN ('ENGINEER', 'ADMIN'))
                 THEN uc.service_unit_id END AS company_id,
            s.name AS company_name,
            EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'ENGINEER') AS is_staff
       FROM users u
       LEFT JOIN user_company uc ON uc.user_id = u.id
       LEFT JOIN service_units s ON s.id = uc.service_unit_id
      WHERE u.is_active
        AND (u.name ILIKE $1 OR u.name_arabic ILIKE $1 OR u.its_number LIKE $1 OR u.employee_id LIKE $1)
      ORDER BY lower(u.name) LIMIT 20`,
    [like]
  );
  return rows.map((r) => {
    const here = r.company_id != null && String(r.company_id) === String(user.companyId);
    return {
      id: String(r.id),
      name: r.name,
      itsNumber: r.its_number || null,
      employeeId: r.employee_id || null,
      // Can't add: already staff here, or working for another company.
      alreadyStaff: here && r.is_staff,
      otherCompany: r.company_id != null && !here ? r.company_name : null,
    };
  });
}

// body: { userId, occupationId }
async function addStaff(user, body = {}) {
  if (!isId(body.userId)) throw bad('Choose a person.', 'bad_user');
  const result = await users.inTransaction(async (db) => {
    const person = await users.mustGetUser(db, body.userId).catch(() => null);
    if (!person || !person.is_active) throw bad('Choose an active person.', 'bad_user');
    const already = await staffMember(db, user, body.userId);
    if (already?.isStaff) throw new HttpError(409, `${already.name} is already staff here.`, 'already_staff');
    await users.grantInTx(db, String(body.userId), 'ENGINEER', user, { companyId: user.companyId, occupationId: body.occupationId });
    return staffMember(db, user, body.userId);
  });
  realtime.disconnectUser(body.userId); // their open tabs pick up the new role on reconnect
  return result;
}

// body: { occupationId }
async function changeOccupation(user, userId, body = {}) {
  return users.inTransaction(async (db) => {
    const m = await staffMember(db, user, userId);
    if (!m || !m.isStaff) throw notFound();
    if (m.occupation && m.occupation.id === String(body.occupationId)) return m;
    await users.grantInTx(db, String(userId), 'ENGINEER', user, { companyId: user.companyId, occupationId: body.occupationId });
    return staffMember(db, user, userId);
  });
}

// Removes the Staff role (their assigned tickets stay assigned — reassign them from the queues).
async function removeStaff(user, userId) {
  await users.inTransaction(async (db) => {
    const m = await staffMember(db, user, userId);
    if (!m || !m.isStaff) throw notFound();
    await users.removeInTx(db, String(userId), 'ENGINEER', user);
  });
  realtime.disconnectUser(userId);
  return { removed: true };
}

module.exports = {
  listOccupations,
  createOccupation,
  updateOccupation,
  listStaff,
  searchPeople,
  addStaff,
  changeOccupation,
  removeStaff,
};
