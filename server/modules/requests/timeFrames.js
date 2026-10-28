// Time frames by priority and overdue checks (decided 28 Oct 2026).
//   High 30 min – 2 h · Normal 2 – 4 h · Low 4 – 48 h (Super Admin can change them), 24/7 clock,
//   counted from when the ticket / request was raised until it is done (resolved / delivered).
//   Past the end of the window = overdue: Super Admins and the assigned engineer are told once.
const defaultPool = require('../../db/pool');
const { HttpError } = require('../../utils/httpError');
const notifications = require('../notifications/notifications.service');

const PRIORITIES = ['HIGH', 'NORMAL', 'LOW'];
const bad = (message, code) => new HttpError(400, message, code);

const DEFAULTS = "('HIGH', 30, 120), ('NORMAL', 120, 240), ('LOW', 240, 2880)";

async function listTargets(db = defaultPool) {
  await db.query(`INSERT INTO priority_targets (priority, min_minutes, max_minutes) VALUES ${DEFAULTS} ON CONFLICT (priority) DO NOTHING`);
  const { rows } = await db.query(
    `SELECT priority::text AS priority, min_minutes, max_minutes, updated_at FROM priority_targets
      WHERE priority::text = ANY($1::text[])
      ORDER BY array_position($1::text[], priority::text)`,
    [PRIORITIES]
  );
  return rows.map((r) => ({ priority: r.priority, minMinutes: r.min_minutes, maxMinutes: r.max_minutes, updatedAt: r.updated_at }));
}

// body: { targets: [{ priority, minMinutes, maxMinutes }] } — Super Admin. Open requests keep the
// window they got; new ones and priority changes use the new numbers.
async function updateTargets(user, body = {}, db = defaultPool) {
  const list = Array.isArray(body.targets) ? body.targets : [];
  if (!list.length) throw bad('Nothing to change.', 'empty');
  for (const t of list) {
    if (!PRIORITIES.includes(t?.priority)) throw bad('Unknown priority.', 'bad_priority');
    const min = Number(t.minMinutes);
    const max = Number(t.maxMinutes);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1 || max < min || max > 525600) {
      throw bad('Times must be whole minutes, and “up to” must not be less than “from”.', 'bad_range');
    }
  }
  for (const t of list) {
    await db.query(
      `UPDATE priority_targets SET min_minutes = $2::int, max_minutes = $3::int, updated_by = $4::bigint, updated_at = now()
        WHERE priority = $1::request_priority`,
      [t.priority, Number(t.minMinutes), Number(t.maxMinutes), user.id]
    );
  }
  return listTargets(db);
}

// Inside a transaction, after insert or a priority change: window counted from when it was raised.
// A window that moves later clears the "overdue already told" mark.
async function setDue(db, requestId) {
  await db.query(`INSERT INTO priority_targets (priority, min_minutes, max_minutes) VALUES ${DEFAULTS} ON CONFLICT (priority) DO NOTHING`);
  const { rows } = await db.query(
    `UPDATE requests r
        SET due_from = r.created_at + make_interval(mins => t.min_minutes),
            due_by   = r.created_at + make_interval(mins => t.max_minutes),
            overdue_notified_at = CASE WHEN r.created_at + make_interval(mins => t.max_minutes) > now() THEN NULL
                                       ELSE r.overdue_notified_at END
       FROM priority_targets t
      WHERE r.id = $1::bigint AND t.priority = r.priority
      RETURNING r.due_from, r.due_by`,
    [requestId]
  );
  return rows[0] || null;
}

// Background job (every minute): mark newly overdue requests and tell Super Admins + the engineer.
// The UPDATE … RETURNING claims each row once, so several server processes never double-notify.
async function checkOverdue({ pool = defaultPool, publish = notifications.publish } = {}) {
  const client = await pool.connect();
  const sent = [];
  let claimed = [];
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE requests SET overdue_notified_at = now()
        WHERE due_by < now() AND overdue_notified_at IS NULL
          AND status::text NOT IN ('RESOLVED', 'CLOSED', 'REJECTED')
        RETURNING id, number, type, title, requester_id, raised_by_id, assigned_engineer_id, due_by`
    );
    claimed = rows;
    for (const r of rows) {
      sent.push({ r, rows: await notifications.recordTicketEvent(client, r, { kind: 'overdue', actorId: null }) });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  for (const s of sent) publish(s.rows, s.r);
  return claimed.length;
}

module.exports = { listTargets, updateTargets, setDue, checkOverdue, PRIORITIES };
