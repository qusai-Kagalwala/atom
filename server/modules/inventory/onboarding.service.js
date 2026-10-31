// Onboarding / offboarding (Phase 10, decided 31 Oct 2026). Everything is inside the active company:
// its Admin sees and changes only that company's assets. People are shared by all companies.
//   - Onboarding: assign in-store assets to a person one at a time (POST /inventory/assets/:tag/assign).
//   - Offboarding: tick the person's assets and mark them received in one transaction.
//   - To recover: a person deactivated while holding assets (sync or Super Admin) → their assets are
//     flagged (to_recover_since) and each company's Admins are told. Receiving / reassigning clears it;
//     so does the person becoming active again.
const pool = require('../../db/pool');
const { HttpError, notFound } = require('../../utils/httpError');
const notifRepo = require('../notifications/notifications.repo');
const email = require('../notifications/email');
const { ASSET_SELECT, inTransaction, addEvent, markEdited, toSummary } = require('./inventory.service');

const bad = (message, code) => new HttpError(400, message, code);
const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const isId = (v) => /^\d{1,18}$/.test(String(v ?? ''));
const MAX_RECEIVE = 200;

const NAME = `COALESCE(u.name, 'Employee ' || u.employee_id)`;
const toPerson = (u) => ({
  id: String(u.id),
  name: u.name,
  itsNumber: u.its_number || null,
  employeeId: u.employee_id || null,
  isActive: u.is_active,
  department: u.department || null,
});

// ---------- people ----------
// Search everyone (active and inactive) by name, ITS number or employee ID, with how many of this
// company's assets each one holds.
async function searchPeople(user, q) {
  const term = clean(q);
  if (term.length < 2) return [];
  const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const { rows } = await pool.query(
    `SELECT u.id, ${NAME} AS name, u.its_number, u.employee_id, u.is_active,
            (SELECT count(*)::int FROM assets a WHERE a.holder_user_id = u.id AND a.service_unit_id = $2::bigint AND a.status <> 'RETIRED') AS held,
            (SELECT count(*)::int FROM assets a WHERE a.holder_user_id = u.id AND a.service_unit_id = $2::bigint AND a.to_recover_since IS NOT NULL) AS to_recover
       FROM users u
      WHERE u.name ILIKE $1 OR u.its_number ILIKE $1 OR u.employee_id ILIKE $1
      ORDER BY u.is_active DESC, ${NAME}
      LIMIT 20`,
    [like, user.companyId]
  );
  return rows.map((u) => ({ ...toPerson(u), held: u.held, toRecover: u.to_recover }));
}

async function personRow(db, id) {
  if (!isId(id)) return null;
  const { rows } = await db.query(
    `SELECT u.id, ${NAME} AS name, u.its_number, u.employee_id, u.is_active,
            (SELECT d.name FROM user_posts p JOIN departments d ON d.id = p.department_id
              WHERE p.user_id = u.id AND p.is_active ORDER BY p.id LIMIT 1) AS department
       FROM users u WHERE u.id = $1::bigint`,
    [id]
  );
  return rows[0] || null;
}

// One person and this company's assets they hold (newest first).
async function personEquipment(user, id) {
  const person = await personRow(pool, id);
  if (!person) throw notFound();
  const { rows } = await pool.query(
    `${ASSET_SELECT}
      WHERE a.holder_user_id = $1::bigint AND a.service_unit_id = $2::bigint AND a.status <> 'RETIRED'
      ORDER BY c.name, a.asset_tag`,
    [person.id, user.companyId]
  );
  return { person: toPerson(person), assets: rows.map(toSummary) };
}

// ---------- offboarding: receive many at once ----------
// body: { tags: [..], placeId?, note? } — every tag must be held by this person in this company.
async function receive(user, id, body = {}) {
  const tags = [...new Set((Array.isArray(body.tags) ? body.tags : []).map(clean).filter(Boolean))];
  if (!tags.length) throw bad('Choose the assets received.', 'no_assets');
  if (tags.length > MAX_RECEIVE) throw bad(`Up to ${MAX_RECEIVE} assets at a time.`, 'too_many');
  const note = clean(body.note);
  if (note.length > 1000) throw bad('Keep the note under 1000 characters.', 'note_too_long');

  const result = await inTransaction(async (db) => {
    const person = await personRow(db, id);
    if (!person) throw notFound();
    let place = null;
    if (body.placeId) {
      const { rows } = await db.query('SELECT id, name FROM places WHERE id = $1::bigint AND is_active', [isId(body.placeId) ? body.placeId : null]);
      place = rows[0];
      if (!place) throw bad('Choose a place.', 'bad_place');
    }
    const { rows: assets } = await db.query(
      `SELECT id, asset_tag, holder_user_id, source, to_recover_since FROM assets
        WHERE upper(asset_tag) = ANY($1::text[]) AND service_unit_id = $2::bigint
        ORDER BY asset_tag FOR UPDATE`,
      [tags.map((t) => t.toUpperCase()), user.companyId]
    );
    const found = new Set(assets.map((a) => a.asset_tag.toUpperCase()));
    const missing = tags.filter((t) => !found.has(t.toUpperCase()));
    if (missing.length) throw bad(`Not found: ${missing.slice(0, 5).join(', ')}.`, 'bad_asset');
    const notHis = assets.filter((a) => String(a.holder_user_id) !== String(person.id));
    if (notHis.length) throw new HttpError(409, `${notHis.slice(0, 5).map((a) => a.asset_tag).join(', ')} not held by ${person.name}.`, 'not_holder');

    for (const a of assets) {
      await db.query(
        `UPDATE assets SET holder_user_id = NULL, holder_unknown = FALSE, status = 'IN_STORE', to_recover_since = NULL,
                place_id = COALESCE($2::bigint, place_id) WHERE id = $1::bigint`,
        [a.id, place ? place.id : null]
      );
      await markEdited(db, a);
      await addEvent(db, a.id, 'returned', user.id, {
        note: note || null,
        data: {
          from: { id: String(person.id), name: person.name },
          to: place ? { id: String(place.id), name: place.name } : null,
          offboarding: true,
          ...(a.to_recover_since ? { recovered: true } : {}),
        },
      });
    }
    return { received: assets.map((a) => a.asset_tag) };
  });
  return { ...result, ...(await personEquipment(user, id)) };
}

// ---------- to recover ----------
// This company's flagged assets, grouped by person (longest waiting first).
async function toRecover(user) {
  const { rows } = await pool.query(
    `${ASSET_SELECT}
      WHERE a.service_unit_id = $1::bigint AND a.to_recover_since IS NOT NULL
      ORDER BY a.to_recover_since, a.holder_user_id, a.asset_tag`,
    [user.companyId]
  );
  const by = new Map();
  for (const a of rows) {
    const key = String(a.holder_user_id);
    if (!by.has(key)) by.set(key, { person: a.holder, since: a.to_recover_since, assets: [] });
    by.get(key).assets.push(toSummary(a));
  }
  return { people: [...by.values()], total: rows.length };
}

const toRecoverCount = async (user) =>
  (await pool.query('SELECT count(*)::int AS n FROM assets WHERE service_unit_id = $1::bigint AND to_recover_since IS NOT NULL', [user.companyId])).rows[0].n;

// Called inside a deactivation (sync or Super Admin): flag what these people still hold, log it in each
// asset's history, and tell each company's Admins (in-app + email if switched on). → notification rows.
async function flagToRecover(db, userIds, reason) {
  const ids = [...new Set((userIds || []).map(String))].filter(isId);
  if (!ids.length) return [];
  const { rows } = await db.query(
    `UPDATE assets a SET to_recover_since = now()
       FROM users u
      WHERE u.id = a.holder_user_id AND a.holder_user_id = ANY($1::bigint[]) AND a.to_recover_since IS NULL AND a.status <> 'RETIRED'
      RETURNING a.id, a.asset_tag, a.service_unit_id, a.holder_user_id, ${NAME} AS holder_name`,
    [ids]
  );
  if (!rows.length) return [];
  for (const a of rows) await addEvent(db, a.id, 'to_recover', null, { note: reason || null, data: { holder: { id: String(a.holder_user_id), name: a.holder_name } } });

  const groups = new Map(); // company:person → tags
  for (const a of rows) {
    const k = `${a.service_unit_id}:${a.holder_user_id}`;
    if (!groups.has(k)) groups.set(k, { companyId: a.service_unit_id, userId: a.holder_user_id, name: a.holder_name, tags: [] });
    groups.get(k).tags.push(a.asset_tag);
  }
  const out = [];
  for (const g of groups.values()) {
    const n = g.tags.length;
    const list = g.tags.slice(0, 6).join(', ') + (n > 6 ? ', …' : '');
    out.push(
      ...(await notifRepo.insertForRole(db, {
        role: 'ADMIN',
        type: 'asset.to_recover',
        title: `Recover ${n} ${n === 1 ? 'asset' : 'assets'} from ${g.name}`.slice(0, 200),
        body: `${g.name} is no longer active. ${list}`.slice(0, 300),
        link: `/onboarding?person=${g.userId}`,
        companyId: g.companyId,
      }))
    );
  }
  await email.queueForRows(db, out, null);
  return out;
}

// The person is active again (rejoined): nothing to recover from them any more.
async function clearToRecover(db, userIds) {
  const ids = [...new Set((userIds || []).map(String))].filter(isId);
  if (!ids.length) return 0;
  const { rows } = await db.query(
    `UPDATE assets SET to_recover_since = NULL WHERE holder_user_id = ANY($1::bigint[]) AND to_recover_since IS NOT NULL RETURNING id`,
    [ids]
  );
  for (const a of rows) await addEvent(db, a.id, 'recover_cleared', null, { note: 'The holder is active again.' });
  return rows.length;
}

module.exports = { searchPeople, personEquipment, receive, toRecover, toRecoverCount, flagToRecover, clearToRecover };
