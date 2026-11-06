// Notification queries (Phase 13). A user sees rows about their own tickets (role NULL) from every
// company, plus work rows (role = their active role) of the active company only.
//   $1 user id · $2 active role · $3 active company
const pool = require('../../db/pool');

const COLUMNS = `id, user_id, role, type, title, body, link, request_id, service_unit_id, read_at, created_at,
  (SELECT s.code FROM service_units s WHERE s.id = notifications.service_unit_id) AS company_code,
  (SELECT s.name FROM service_units s WHERE s.id = notifications.service_unit_id) AS company_name`;
// "In app" off (031): the notification is kept as history but arrives already read — no count, pop-up or push.
const READ_AT = 'CASE WHEN u.notify_in_app THEN NULL ELSE now() END';
const VISIBLE = `user_id = $1::bigint
  AND (role IS NULL OR (role = $2::app_role AND service_unit_id IS NOT DISTINCT FROM $3::bigint))`;
const visibleParams = (user) => [user.id, user.activeRole, user.companyId ?? null];

// One recipient. Skipped (no row) if the user is inactive or — for a role notification — no longer
// holds that role in that company.
async function insertForUser(db, n) {
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, role, type, title, body, link, request_id, actor_id, service_unit_id, read_at)
     SELECT u.id, $2::app_role, $3::text, $4::text, $5::text, $6::text, $7::bigint, $8::bigint, $9::bigint, ${READ_AT}
       FROM users u
      WHERE u.id = $1::bigint AND u.is_active
        AND ($2::app_role IS NULL
             OR (EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = $2::app_role)
                 AND EXISTS (SELECT 1 FROM user_company c WHERE c.user_id = u.id AND c.service_unit_id = $9::bigint)))
     RETURNING ${COLUMNS}`,
    [n.userId, n.role ?? null, n.type, n.title, n.body ?? null, n.link ?? null, n.requestId ?? null, n.actorId ?? null, n.companyId ?? null]
  );
  return rows[0] || null;
}

// Everyone active who holds `role` in the company (the company's Admins), except the person who caused it.
// n.features (Delegate access, 6 Nov 2026): also people given one of these features in the company — as
// their own notification (role NULL), so they see it whatever role they are using.
async function insertForRole(db, n) {
  const delegates = n.features && n.features.length ? await insertForDelegates(db, n) : [];
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, role, type, title, body, link, request_id, actor_id, service_unit_id, read_at)
     SELECT u.id, $1::app_role, $2::text, $3::text, $4::text, $5::text, $6::bigint, $7::bigint, $8::bigint, ${READ_AT}
       FROM users u
       JOIN user_roles r ON r.user_id = u.id AND r.role = $1::app_role
       JOIN user_company c ON c.user_id = u.id AND c.service_unit_id = $8::bigint
      WHERE u.is_active AND u.id IS DISTINCT FROM $7::bigint
     RETURNING ${COLUMNS}`,
    [n.role, n.type, n.title, n.body ?? null, n.link ?? null, n.requestId ?? null, n.actorId ?? null, n.companyId ?? null]
  );
  return [...rows, ...delegates];
}

async function insertForDelegates(db, n) {
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, role, type, title, body, link, request_id, actor_id, service_unit_id, read_at)
     SELECT DISTINCT u.id, NULL::app_role, $2::text, $3::text, $4::text, $5::text, $6::bigint, $7::bigint, $8::bigint, ${READ_AT}
       FROM users u
       JOIN user_features f ON f.user_id = u.id AND f.service_unit_id = $8::bigint AND f.revoked_at IS NULL AND f.feature = ANY($1::text[])
       JOIN user_company c ON c.user_id = u.id AND c.service_unit_id = $8::bigint
      WHERE u.is_active AND u.id IS DISTINCT FROM $7::bigint
        AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role IN ('ADMIN', 'SUPER_ADMIN'))
     RETURNING ${COLUMNS}`,
    [n.features, n.type, n.title, n.body ?? null, n.link ?? null, n.requestId ?? null, n.actorId ?? null, n.companyId ?? null]
  );
  return rows;
}

async function list(user, { unreadOnly = false, limit = 20, offset = 0 } = {}, db = pool) {
  const filter = `${VISIBLE}${unreadOnly ? ' AND read_at IS NULL' : ''}`;
  const params = visibleParams(user);
  const [items, totals] = await Promise.all([
    db.query(
      `SELECT ${COLUMNS} FROM notifications WHERE ${filter}
        ORDER BY created_at DESC, id DESC LIMIT $4::int OFFSET $5::int`,
      [...params, limit, offset]
    ),
    db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE read_at IS NULL)::int AS unread
         FROM notifications WHERE ${VISIBLE}`,
      params
    ),
  ]);
  const { total, unread } = totals.rows[0];
  return { rows: items.rows, total: unreadOnly ? unread : total, unread };
}

async function unreadCount(user, db = pool) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS unread FROM notifications WHERE ${VISIBLE} AND read_at IS NULL`,
    visibleParams(user)
  );
  return rows[0].unread;
}

// → true if the row exists for this user + role (already read counts), false otherwise.
async function markRead(user, id, db = pool) {
  if (!/^\d{1,18}$/.test(String(id))) return false;
  const { rows } = await db.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, now())
      WHERE id = $4::bigint AND ${VISIBLE}
      RETURNING id`,
    [...visibleParams(user), id]
  );
  return rows.length === 1;
}

// A push tapped on the phone (Phase 14): the person's own notification, whatever role / company it
// is for, so the app can switch there. Marked read. → row or null.
async function openOwn(user, id, db = pool) {
  if (!/^\d{1,18}$/.test(String(id))) return null;
  const { rows } = await db.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $2::bigint AND user_id = $1::bigint RETURNING ${COLUMNS}`,
    [user.id, id]
  );
  return rows[0] || null;
}

async function markAllRead(user, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE notifications SET read_at = now() WHERE ${VISIBLE} AND read_at IS NULL`,
    visibleParams(user)
  );
  return rowCount;
}

module.exports = { insertForUser, insertForRole, list, unreadCount, markRead, markAllRead, openOwn };
