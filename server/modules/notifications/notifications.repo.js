// Notification queries (Phase 13). A user sees rows where role IS NULL OR role = their active role.
const pool = require('../../db/pool');

const COLUMNS = 'id, user_id, role, type, title, body, link, request_id, read_at, created_at';
const VISIBLE = 'user_id = $1::bigint AND (role IS NULL OR role = $2::app_role)';

// One recipient. Skipped (no row) if the user is inactive or — for a role notification — no longer
// holds that role.
async function insertForUser(db, n) {
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, role, type, title, body, link, request_id, actor_id)
     SELECT u.id, $2::app_role, $3::text, $4::text, $5::text, $6::text, $7::bigint, $8::bigint
       FROM users u
      WHERE u.id = $1::bigint AND u.is_active
        AND ($2::app_role IS NULL
             OR EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = $2::app_role))
     RETURNING ${COLUMNS}`,
    [n.userId, n.role ?? null, n.type, n.title, n.body ?? null, n.link ?? null, n.requestId ?? null, n.actorId ?? null]
  );
  return rows[0] || null;
}

// Everyone active who holds `role`, except the person who caused it.
async function insertForRole(db, n) {
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, role, type, title, body, link, request_id, actor_id)
     SELECT u.id, $1::app_role, $2::text, $3::text, $4::text, $5::text, $6::bigint, $7::bigint
       FROM users u
       JOIN user_roles r ON r.user_id = u.id AND r.role = $1::app_role
      WHERE u.is_active AND u.id IS DISTINCT FROM $7::bigint
     RETURNING ${COLUMNS}`,
    [n.role, n.type, n.title, n.body ?? null, n.link ?? null, n.requestId ?? null, n.actorId ?? null]
  );
  return rows;
}

async function list(user, { unreadOnly = false, limit = 20, offset = 0 } = {}, db = pool) {
  const filter = `${VISIBLE}${unreadOnly ? ' AND read_at IS NULL' : ''}`;
  const params = [user.id, user.activeRole];
  const [items, totals] = await Promise.all([
    db.query(
      `SELECT ${COLUMNS} FROM notifications WHERE ${filter}
        ORDER BY created_at DESC, id DESC LIMIT $3::int OFFSET $4::int`,
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
    [user.id, user.activeRole]
  );
  return rows[0].unread;
}

// → true if the row exists for this user + role (already read counts), false otherwise.
async function markRead(user, id, db = pool) {
  if (!/^\d{1,18}$/.test(String(id))) return false;
  const { rows } = await db.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, now())
      WHERE id = $3::bigint AND ${VISIBLE}
      RETURNING id`,
    [user.id, user.activeRole, id]
  );
  return rows.length === 1;
}

async function markAllRead(user, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE notifications SET read_at = now() WHERE ${VISIBLE} AND read_at IS NULL`,
    [user.id, user.activeRole]
  );
  return rowCount;
}

module.exports = { insertForUser, insertForRole, list, unreadCount, markRead, markAllRead };
