// Problem list of one company (companies step B, decided 28–30 Oct 2026):
//   Category (categories) > Item (ticket_items) > Problem (ticket_problems).
// Filled by the Support Log items sync; the company's Admin adds, renames and switches off rows,
// links each category to an occupation and switches auto-assign on or off. Never deleted.
// A row from the Support Log that an Admin changes is marked "changed in ATOM", so the next sync
// keeps the change (unless the Super Admin overwrites).
const pool = require('../../db/pool');
const { HttpError, notFound } = require('../../utils/httpError');

const bad = (message, code) => new HttpError(400, message, code);
const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const isId = (v) => /^\d{1,18}$/.test(String(v ?? ''));
const duplicate = (err, what) => (err.code === '23505' ? new HttpError(409, `This ${what} already exists here.`, 'duplicate') : err);

function readName(body, current, max = 80) {
  const name = 'name' in body ? clean(body.name) : current?.name;
  if (!name || name.length < 2 || name.length > max) throw bad(`Give it a name (2–${max} characters).`, 'bad_name');
  return name;
}
function readActive(body, current) {
  if ('isActive' in body && typeof body.isActive !== 'boolean') throw bad('Bad status value.', 'invalid');
  return 'isActive' in body ? body.isActive : current?.is_active ?? true;
}
function readOrder(body, current) {
  const n = 'sortOrder' in body ? Number(body.sortOrder) : current?.sort_order ?? 100;
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw bad('Order must be a whole number.', 'bad_order');
  return n;
}

// ---------- read ----------
// Everyone in the company: active rows (for raising a ticket). Admin: includeInactive.
async function tree(user, { includeInactive = false } = {}) {
  const co = user.companyId;
  const act = (a) => (includeInactive ? 'TRUE' : `${a}.is_active`);
  const [unit, cats, items, problems] = await Promise.all([
    pool.query('SELECT auto_assign FROM service_units WHERE id = $1::bigint', [co]),
    pool.query(
      `SELECT c.id::text, c.name, c.is_active, c.sort_order, c.source, c.occupation_id::text, o.name AS occupation
         FROM categories c LEFT JOIN occupations o ON o.id = c.occupation_id
        WHERE c.service_unit_id = $1::bigint AND ${act('c')}
        ORDER BY c.sort_order, lower(c.name)`,
      [co]
    ),
    pool.query(
      `SELECT i.id::text, i.category_id::text, i.name, i.is_active, i.source FROM ticket_items i
        WHERE i.service_unit_id = $1::bigint AND ${act('i')} ORDER BY i.sort_order, lower(i.name)`,
      [co]
    ),
    pool.query(
      `SELECT p.id::text, p.item_id::text, p.name, p.is_active, p.source FROM ticket_problems p
        WHERE p.service_unit_id = $1::bigint AND ${act('p')} ORDER BY p.sort_order, lower(p.name)`,
      [co]
    ),
  ]);
  const byItem = new Map();
  for (const p of problems.rows) {
    if (!byItem.has(p.item_id)) byItem.set(p.item_id, []);
    byItem.get(p.item_id).push({ id: p.id, name: p.name, isActive: p.is_active, source: p.source });
  }
  const byCat = new Map();
  for (const i of items.rows) {
    if (!byCat.has(i.category_id)) byCat.set(i.category_id, []);
    byCat.get(i.category_id).push({ id: i.id, name: i.name, isActive: i.is_active, source: i.source, problems: byItem.get(i.id) || [] });
  }
  return {
    autoAssign: Boolean(unit.rows[0]?.auto_assign),
    categories: cats.rows.map((c) => ({
      id: c.id,
      name: c.name,
      isActive: c.is_active,
      sortOrder: c.sort_order,
      source: c.source,
      occupation: c.occupation_id ? { id: c.occupation_id, name: c.occupation } : null,
      items: byCat.get(c.id) || [],
    })),
  };
}

// ---------- settings ----------
async function setAutoAssign(user, body = {}) {
  if (typeof body.autoAssign !== 'boolean') throw bad('Bad value.', 'invalid');
  await pool.query('UPDATE service_units SET auto_assign = $2::boolean, auto_assign_set = TRUE WHERE id = $1::bigint', [user.companyId, body.autoAssign]);
  return { autoAssign: body.autoAssign };
}

// ---------- categories ----------
async function occupationFor(user, body, current) {
  if (!('occupationId' in body)) return current?.occupation_id ?? null;
  if (!body.occupationId) return null;
  if (!isId(body.occupationId)) throw bad('Choose an occupation of this company.', 'bad_occupation');
  const { rows } = await pool.query(
    'SELECT id FROM occupations WHERE id = $1::bigint AND service_unit_id = $2::bigint AND is_active',
    [body.occupationId, user.companyId]
  );
  if (!rows[0]) throw bad('Choose an occupation of this company.', 'bad_occupation');
  return rows[0].id;
}

async function getOwn(table, user, id) {
  if (!isId(id)) throw notFound();
  const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = $1::bigint AND service_unit_id = $2::bigint`, [id, user.companyId]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

async function createCategory(user, body = {}) {
  const name = readName(body, null, 60);
  const occ = await occupationFor(user, body);
  try {
    const { rows } = await pool.query(
      `INSERT INTO categories (service_unit_id, name, sort_order, occupation_id) VALUES ($1::bigint, $2::text, $3::int, $4::bigint) RETURNING id`,
      [user.companyId, name, readOrder(body), occ]
    );
    return { id: String(rows[0].id) };
  } catch (err) {
    throw duplicate(err, 'category');
  }
}

async function updateCategory(user, id, body = {}) {
  const cur = await getOwn('categories', user, id);
  const name = readName(body, cur, 60);
  const occ = await occupationFor(user, body, cur);
  try {
    await pool.query(
      `UPDATE categories SET name = $2::text, is_active = $3::boolean, sort_order = $4::int, occupation_id = $5::bigint,
              edited_in_atom_at = CASE WHEN source = 'supportlog' THEN now() ELSE edited_in_atom_at END
        WHERE id = $1::bigint`,
      [cur.id, name, readActive(body, cur), readOrder(body, cur), occ]
    );
  } catch (err) {
    throw duplicate(err, 'category');
  }
  return { id: String(cur.id) };
}

// ---------- items ----------
async function ownCategory(user, id) {
  if (!isId(id)) throw bad('Choose a category.', 'bad_category');
  const { rows } = await pool.query('SELECT id FROM categories WHERE id = $1::bigint AND service_unit_id = $2::bigint', [id, user.companyId]);
  if (!rows[0]) throw bad('Choose a category.', 'bad_category');
  return rows[0].id;
}

async function createItem(user, body = {}) {
  const categoryId = await ownCategory(user, body.categoryId);
  const { rows } = await pool.query(
    `INSERT INTO ticket_items (service_unit_id, category_id, name, sort_order) VALUES ($1::bigint, $2::bigint, $3::text, $4::int) RETURNING id`,
    [user.companyId, categoryId, readName(body), readOrder(body)]
  );
  return { id: String(rows[0].id) };
}

async function updateItem(user, id, body = {}) {
  const cur = await getOwn('ticket_items', user, id);
  const categoryId = 'categoryId' in body ? await ownCategory(user, body.categoryId) : cur.category_id;
  await pool.query(
    `UPDATE ticket_items SET name = $2::text, is_active = $3::boolean, sort_order = $4::int, category_id = $5::bigint,
            edited_in_atom_at = CASE WHEN source = 'supportlog' THEN now() ELSE edited_in_atom_at END
      WHERE id = $1::bigint`,
    [cur.id, readName(body, cur), readActive(body, cur), readOrder(body, cur), categoryId]
  );
  return { id: String(cur.id) };
}

// ---------- problems ----------
async function createProblem(user, body = {}) {
  if (!isId(body.itemId)) throw bad('Choose an item.', 'bad_item');
  const { rows: it } = await pool.query('SELECT id FROM ticket_items WHERE id = $1::bigint AND service_unit_id = $2::bigint', [body.itemId, user.companyId]);
  if (!it[0]) throw bad('Choose an item.', 'bad_item');
  const { rows } = await pool.query(
    `INSERT INTO ticket_problems (service_unit_id, item_id, name, sort_order) VALUES ($1::bigint, $2::bigint, $3::text, $4::int) RETURNING id`,
    [user.companyId, it[0].id, readName(body), readOrder(body)]
  );
  return { id: String(rows[0].id) };
}

async function updateProblem(user, id, body = {}) {
  const cur = await getOwn('ticket_problems', user, id);
  await pool.query(
    `UPDATE ticket_problems SET name = $2::text, is_active = $3::boolean, sort_order = $4::int,
            edited_in_atom_at = CASE WHEN source = 'supportlog' THEN now() ELSE edited_in_atom_at END
      WHERE id = $1::bigint`,
    [cur.id, readName(body, cur), readActive(body, cur), readOrder(body, cur)]
  );
  return { id: String(cur.id) };
}

// ---------- used when a ticket is raised ----------
// → { item, problem } (rows) after checking they belong together, to the category and are active.
async function resolveChoice(db, companyId, categoryId, { itemId, problemId }) {
  let item = null;
  let problem = null;
  if (itemId) {
    if (!isId(itemId)) throw bad('Choose an item.', 'bad_item');
    const { rows } = await db.query(
      'SELECT id, name, category_id FROM ticket_items WHERE id = $1::bigint AND service_unit_id = $2::bigint AND is_active',
      [itemId, companyId]
    );
    item = rows[0];
    if (!item || String(item.category_id) !== String(categoryId)) throw bad('Choose an item of this category.', 'bad_item');
  }
  if (problemId) {
    if (!item || !isId(problemId)) throw bad('Choose a problem of this item.', 'bad_problem');
    const { rows } = await db.query(
      'SELECT id, name FROM ticket_problems WHERE id = $1::bigint AND item_id = $2::bigint AND is_active',
      [problemId, item.id]
    );
    problem = rows[0];
    if (!problem) throw bad('Choose a problem of this item.', 'bad_problem');
  }
  return { item, problem };
}

const OPEN = "('ASSIGNED','IN_PROGRESS','WAITING_FOR_USER','WAITING_FOR_EQUIPMENT')";

// Auto-assign (when the company has it on and the category has an occupation): the active staff
// member of that occupation with the fewest open jobs, then the one given a job longest ago.
// Serialised per occupation, so two tickets at the same moment are spread out. → staff row or null.
async function pickAutoAssignee(db, companyId, categoryId) {
  const { rows: c } = await db.query(
    `SELECT c.occupation_id, s.auto_assign FROM categories c JOIN service_units s ON s.id = c.service_unit_id
      WHERE c.id = $1::bigint AND c.service_unit_id = $2::bigint`,
    [categoryId, companyId]
  );
  if (!c[0]?.auto_assign || !c[0].occupation_id) return null;
  await db.query('SELECT pg_advisory_xact_lock(727309, $1::int)', [Number(c[0].occupation_id) % 2147483647]);
  const { rows } = await db.query(
    `SELECT u.id::text AS id, COALESCE(u.name, 'Employee ' || u.employee_id) AS name, o.name AS occupation,
            (SELECT count(*) FROM requests w WHERE w.assigned_engineer_id = u.id AND w.status IN ${OPEN}) AS open_work,
            (SELECT max(w.assigned_at) FROM requests w WHERE w.assigned_engineer_id = u.id) AS last_at
       FROM users u
       JOIN user_roles r ON r.user_id = u.id AND r.role = 'ENGINEER'
       JOIN user_company t ON t.user_id = u.id AND t.service_unit_id = $1::bigint AND t.occupation_id = $2::bigint
       JOIN occupations o ON o.id = t.occupation_id AND o.is_active
      WHERE u.is_active
      ORDER BY open_work, last_at NULLS FIRST, lower(u.name), u.id
      LIMIT 1`,
    [companyId, c[0].occupation_id]
  );
  return rows[0] || null;
}

module.exports = {
  tree,
  setAutoAssign,
  createCategory,
  updateCategory,
  createItem,
  updateItem,
  createProblem,
  updateProblem,
  resolveChoice,
  pickAutoAssignee,
};
