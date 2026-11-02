// Analytics (Phase 15, decided 2 Nov 2026). Everything for ONE company (the active one) over a period;
// the Super Admin overview runs the headline numbers for every company side by side.
//   Period: from / to as YYYY-MM-DD, inclusive, in the app time zone (India). Default: the last 30 days.
//   Tickets counted = tickets RAISED in the period (type TICKET). Service requests separately.
//   Success rate = (resolved + closed) ÷ (resolved + closed + rejected).
//   First response = raised → first "Start work". Resolution = raised → resolved.
//   Within time frame = done (resolved) by the end of its "expected" window (due_by).
const defaultPool = require('../../db/pool');
const { config } = require('../../config/env');
const { HttpError } = require('../../utils/httpError');

const bad = (message, code) => new HttpError(400, message, code);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 731;
let pool = defaultPool;
const setPool = (p) => {
  pool = p;
};

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// → { from, to, days } (strings YYYY-MM-DD). Bad input → 400.
function period(q = {}) {
  const to = q.to ? String(q.to) : today();
  const from = q.from ? String(q.from) : addDays(to, -29);
  if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    throw bad('Choose the dates as YYYY-MM-DD.', 'bad_period');
  }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days < 1) throw bad('The start date is after the end date.', 'bad_period');
  if (days > MAX_DAYS) throw bad('Choose at most two years.', 'bad_period');
  return { from, to, days };
}

// SQL pieces: $1 company, $2 from, $3 to, $4 time zone. Range = [from 00:00, to + 1 day 00:00) local.
const START = `($2::date::timestamp AT TIME ZONE $4::text)`;
const END = `(($3::date + 1)::timestamp AT TIME ZONE $4::text)`;
const IN_PERIOD = (col) => `${col} >= ${START} AND ${col} < ${END}`;
const FINAL = `('RESOLVED','CLOSED','REJECTED')`;
const DONE = `('RESOLVED','CLOSED')`;
const DEPT = (userCol) => `COALESCE(
    (SELECT d.name FROM user_posts p JOIN departments d ON d.id = p.department_id WHERE p.user_id = ${userCol} AND p.is_active ORDER BY p.id LIMIT 1),
    (SELECT d.name FROM user_departments ud JOIN departments d ON d.id = ud.department_id WHERE ud.user_id = ${userCol} AND ud.is_active ORDER BY ud.id LIMIT 1),
    'No department')`;
const FIRST_START = `(SELECT min(e.created_at) FROM request_events e WHERE e.request_id = r.id AND e.type = 'status' AND e.data->>'action' = 'start')`;
const minutes = (v) => (v == null ? null : Math.round(Number(v)));
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

// Headline numbers for one company (also used by the overview and the PDFs).
async function headline(companyId, p, db = pool) {
  const args = [companyId, p.from, p.to, config.timeZone];
  const { rows } = await db.query(
    `SELECT count(*)::int AS raised,
            count(*) FILTER (WHERE r.status NOT IN ${FINAL})::int AS still_open,
            count(*) FILTER (WHERE r.status IN ${DONE})::int AS done,
            count(*) FILTER (WHERE r.status = 'REJECTED')::int AS rejected,
            avg(EXTRACT(EPOCH FROM (${FIRST_START} - r.created_at)) / 60) AS avg_response,
            avg(EXTRACT(EPOCH FROM (r.resolved_at - r.created_at)) / 60) FILTER (WHERE r.resolved_at IS NOT NULL) AS avg_resolution,
            count(*) FILTER (WHERE r.resolved_at IS NOT NULL AND r.due_by IS NOT NULL)::int AS timed,
            count(*) FILTER (WHERE r.resolved_at IS NOT NULL AND r.due_by IS NOT NULL AND r.resolved_at <= r.due_by)::int AS on_time
       FROM requests r
      WHERE r.service_unit_id = $1::bigint AND r.type = 'TICKET' AND ${IN_PERIOD('r.created_at')}`,
    args
  );
  const { rows: od } = await db.query(
    `SELECT count(*)::int AS n FROM requests WHERE service_unit_id = $1::bigint AND status NOT IN ${FINAL} AND due_by < now()`,
    [companyId]
  );
  const h = rows[0];
  return {
    raised: h.raised,
    stillOpen: h.still_open,
    done: h.done,
    rejected: h.rejected,
    successRate: pct(h.done, h.done + h.rejected),
    avgResponseMinutes: minutes(h.avg_response),
    avgResolutionMinutes: minutes(h.avg_resolution),
    withinTimeFrame: pct(h.on_time, h.timed),
    overdueNow: od[0].n,
  };
}

const group = async (db, sql, args) => (await db.query(sql, args)).rows.map((r) => ({ key: r.key, label: r.label, count: r.n }));

// Everything on the Analytics page for the active company.
async function companyAnalytics(user, q = {}) {
  const p = period(q);
  const co = user.companyId;
  const args = [co, p.from, p.to, config.timeZone];
  const T = `FROM requests r WHERE r.service_unit_id = $1::bigint AND r.type = 'TICKET' AND ${IN_PERIOD('r.created_at')}`;
  const [head, perDay, byStatus, byCategory, byPriority, byDepartment, staff, service, assets, assistant] = await Promise.all([
    headline(co, p),
    pool.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day, count(r.id)::int AS n
         FROM generate_series($2::date, $3::date, '1 day') d
         LEFT JOIN requests r ON r.service_unit_id = $1::bigint AND r.type = 'TICKET' AND (r.created_at AT TIME ZONE $4::text)::date = d
        GROUP BY d ORDER BY d`,
      args
    ),
    group(pool, `SELECT r.status::text AS key, r.status::text AS label, count(*)::int AS n ${T} GROUP BY r.status ORDER BY n DESC`, args),
    group(pool, `SELECT COALESCE(r.category_id::text, 'none') AS key, COALESCE(c.name, 'No category') AS label, count(*)::int AS n
                   FROM requests r LEFT JOIN categories c ON c.id = r.category_id
                  WHERE r.service_unit_id = $1::bigint AND r.type = 'TICKET' AND ${IN_PERIOD('r.created_at')}
                  GROUP BY 1, 2 ORDER BY n DESC, label`, args),
    group(pool, `SELECT r.priority::text AS key, r.priority::text AS label, count(*)::int AS n ${T} GROUP BY r.priority ORDER BY n DESC`, args),
    group(pool, `SELECT ${DEPT('r.requester_id')} AS key, ${DEPT('r.requester_id')} AS label, count(*)::int AS n ${T} GROUP BY 1, 2 ORDER BY n DESC, label LIMIT 10`, args),
    staffWorkload(co, p),
    pool.query(
      `SELECT count(DISTINCT r.id)::int AS requests,
              count(i.id) FILTER (WHERE i.status IN ('APPROVED','DELIVERED'))::int AS approved,
              count(i.id) FILTER (WHERE i.status = 'REJECTED')::int AS rejected,
              count(i.id) FILTER (WHERE i.status = 'DELIVERED')::int AS delivered,
              count(i.id) FILTER (WHERE i.status = 'PENDING')::int AS pending,
              COALESCE((SELECT sum(-m.change) FROM stock_movements m JOIN catalogue_items ci ON ci.id = m.catalogue_item_id
                         WHERE ci.service_unit_id = $1::bigint AND m.kind = 'delivery' AND ${IN_PERIOD('m.created_at')}), 0)::int AS stock_delivered
         FROM requests r LEFT JOIN request_items i ON i.request_id = r.id
        WHERE r.service_unit_id = $1::bigint AND r.type = 'SERVICE_REQUEST' AND ${IN_PERIOD('r.created_at')}`,
      args
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE status = 'IN_STORE')::int AS in_store, count(*) FILTER (WHERE status = 'IN_USE')::int AS in_use,
              count(*) FILTER (WHERE status = 'IN_REPAIR')::int AS in_repair, count(*) FILTER (WHERE status = 'RETIRED')::int AS retired,
              count(*) FILTER (WHERE to_recover_since IS NOT NULL)::int AS to_recover
         FROM assets WHERE service_unit_id = $1::bigint`,
      [co]
    ),
    pool.query(
      `SELECT count(*)::int AS chats, count(*) FILTER (WHERE status = 'SOLVED')::int AS solved,
              count(*) FILTER (WHERE status = 'TICKET')::int AS tickets
         FROM assistant_sessions WHERE service_unit_id = $1::bigint AND ${IN_PERIOD('created_at')}`,
      args
    ),
  ]);
  const s = service.rows[0];
  const a = assets.rows[0];
  const ai = assistant.rows[0];
  return {
    period: p,
    company: user.company ? { code: user.company.code, name: user.company.name } : null,
    headline: head,
    perDay: perDay.rows.map((r) => ({ day: r.day, count: r.n })),
    byStatus,
    byCategory,
    byPriority,
    byDepartment,
    staff,
    serviceRequests: { requests: s.requests, approved: s.approved, rejected: s.rejected, delivered: s.delivered, pending: s.pending, stockDelivered: s.stock_delivered },
    assets: { inStore: a.in_store, inUse: a.in_use, inRepair: a.in_repair, retired: a.retired, toRecover: a.to_recover, total: a.in_store + a.in_use + a.in_repair },
    assistant: { chats: ai.chats, solved: ai.solved, tickets: ai.tickets, solvedRate: pct(ai.solved, ai.chats) },
  };
}

// Staff of the company (with their occupation): open jobs now, and for tickets raised in the period:
// assigned, done, average resolution, within time frame.
async function staffWorkload(companyId, p, db = pool) {
  const { rows } = await db.query(
    `SELECT u.id::text AS id, COALESCE(u.name, 'Employee ' || u.employee_id) AS name, o.name AS occupation,
            (SELECT count(*)::int FROM requests x WHERE x.assigned_engineer_id = u.id AND x.service_unit_id = $1::bigint AND x.status NOT IN ${FINAL}) AS open_now,
            count(r.id)::int AS assigned,
            count(r.id) FILTER (WHERE r.status IN ${DONE})::int AS done,
            avg(EXTRACT(EPOCH FROM (r.resolved_at - r.created_at)) / 60) FILTER (WHERE r.resolved_at IS NOT NULL) AS avg_resolution,
            count(r.id) FILTER (WHERE r.resolved_at IS NOT NULL AND r.due_by IS NOT NULL)::int AS timed,
            count(r.id) FILTER (WHERE r.resolved_at IS NOT NULL AND r.due_by IS NOT NULL AND r.resolved_at <= r.due_by)::int AS on_time
       FROM user_company uc
       JOIN users u ON u.id = uc.user_id
       JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'ENGINEER'
       LEFT JOIN occupations o ON o.id = uc.occupation_id
       LEFT JOIN requests r ON r.assigned_engineer_id = u.id AND r.service_unit_id = $1::bigint AND r.type = 'TICKET' AND ${IN_PERIOD('r.created_at')}
      WHERE uc.service_unit_id = $1::bigint AND u.is_active
      GROUP BY u.id, o.name
      ORDER BY open_now DESC, assigned DESC, name`,
    [companyId, p.from, p.to, config.timeZone]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    occupation: r.occupation || 'Staff',
    openNow: r.open_now,
    assigned: r.assigned,
    done: r.done,
    avgResolutionMinutes: minutes(r.avg_resolution),
    withinTimeFrame: pct(r.on_time, r.timed),
  }));
}

// Super Admin: headline numbers for every company, side by side.
async function overview(q = {}) {
  const p = period(q);
  const { rows } = await pool.query('SELECT id::text AS id, code, name, is_open FROM service_units WHERE is_active ORDER BY sort_order, id');
  const companies = [];
  for (const c of rows) companies.push({ code: c.code, name: c.name, isOpen: c.is_open, ...(await headline(c.id, p)) });
  return { period: p, companies };
}

module.exports = { period, headline, companyAnalytics, staffWorkload, overview, setPool, today, addDays };
