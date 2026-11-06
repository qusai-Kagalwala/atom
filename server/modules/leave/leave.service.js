// Staff leave (decided 6 Nov 2026). A company's staff apply for leave with dates; the company's Admin
// (or someone given "Staff leave" in Delegate access) approves or rejects it. Only approved leave counts:
// on those days the person shows "On leave", can't be assigned, and auto-assign skips them.
// Dates are calendar days in the app's time zone. Nothing is deleted: cancelled / rejected stay as history.
const pool = require('../../db/pool');
const { config } = require('../../config/env');
const { HttpError, notFound } = require('../../utils/httpError');
const { canUse } = require('../../middleware/features');
const notifRepo = require('../notifications/notifications.repo');
const notifications = require('../notifications/notifications.service');
const { onLeaveUntil } = require('./leave.sql');

const TYPES = { LEAVE: 'Leave', SICK: 'Sick leave', TRAINING: 'Training', OTHER: 'Other' };
const MAX_DAYS = 91; // a single leave covers at most 91 calendar days
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OPEN_WORK = "('ASSIGNED','IN_PROGRESS','WAITING_FOR_USER','WAITING_FOR_EQUIPMENT')";

const bad = (message, code = 'invalid') => new HttpError(400, message, code);
const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const isId = (v) => /^\d{1,18}$/.test(String(v ?? ''));

// Today in the app's time zone, as YYYY-MM-DD.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone }).format(new Date());
const validDate = (s) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const fmt = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const span = (a, b) => (a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`);

async function inTx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Is this person on the active company's staff? (Staff & occupations)
async function isStaffHere(db, user) {
  if (!user?.companyId) return false;
  const { rows } = await db.query('SELECT 1 FROM user_company WHERE user_id = $1::bigint AND service_unit_id = $2::bigint', [user.id, user.companyId]);
  return rows.length > 0;
}
const isManager = (user) => canUse(user, 'leave');

const SELECT = `
  SELECT l.id::text AS id, l.user_id::text AS user_id, l.type, to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
         to_char(l.end_date, 'YYYY-MM-DD') AS end_date, l.note, l.status, l.requested_at, l.decided_at, l.decision_note,
         l.cancelled_at, u.name AS user_name, u.its_number, u.employee_id, o.name AS occupation,
         d.name AS decided_by_name, c.name AS cancelled_by_name,
         (SELECT count(*)::int FROM requests w WHERE w.assigned_engineer_id = l.user_id AND w.service_unit_id = l.service_unit_id
             AND w.status IN ${OPEN_WORK}) AS open_work
    FROM staff_leave l
    JOIN users u ON u.id = l.user_id
    LEFT JOIN user_company uc ON uc.user_id = l.user_id AND uc.service_unit_id = l.service_unit_id
    LEFT JOIN occupations o ON o.id = uc.occupation_id
    LEFT JOIN users d ON d.id = l.decided_by
    LEFT JOIN users c ON c.id = l.cancelled_by`;

function toLeave(r, now = today()) {
  return {
    id: r.id,
    type: r.type,
    typeLabel: TYPES[r.type] || r.type,
    startDate: r.start_date,
    endDate: r.end_date,
    days: daysBetween(r.start_date, r.end_date) + 1,
    note: r.note || null,
    status: r.status,
    // Approved and covering today / still to come.
    current: r.status === 'APPROVED' && r.start_date <= now && r.end_date >= now,
    upcoming: r.status === 'APPROVED' && r.start_date > now,
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by_name || null,
    decisionNote: r.decision_note || null,
    cancelledAt: r.cancelled_at,
    cancelledBy: r.cancelled_by_name || null,
    person: { id: r.user_id, name: r.user_name, itsNumber: r.its_number || null, employeeId: r.employee_id || null, occupation: r.occupation || null },
    openWork: r.open_work,
  };
}

async function loadOne(db, user, id, { lock = false } = {}) {
  if (!isId(id)) throw notFound();
  const { rows } = await db.query(`${SELECT} WHERE l.id = $1::bigint AND l.service_unit_id = $2::bigint${lock ? ' FOR UPDATE OF l' : ''}`, [id, user.companyId]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

const tellManagers = (db, user, n) =>
  notifRepo.insertForRole(db, { role: 'ADMIN', features: ['leave'], type: 'leave', link: '/staff-leave', actorId: user.id, companyId: user.companyId, ...n });
const tellPerson = (db, user, userId, n) =>
  notifRepo.insertForUser(db, { userId, type: 'leave', link: '/my-leave', actorId: user.id, companyId: user.companyId, ...n });

// ---------- staff: my leave ----------

async function mine(user) {
  if (!(await isStaffHere(pool, user))) throw notFound();
  const { rows } = await pool.query(`${SELECT} WHERE l.user_id = $1::bigint AND l.service_unit_id = $2::bigint ORDER BY l.start_date DESC, l.id DESC LIMIT 100`, [
    user.id,
    user.companyId,
  ]);
  const now = today();
  const leaves = rows.map((r) => toLeave(r, now));
  return { types: TYPES, today: now, onLeave: leaves.find((l) => l.current) || null, leaves };
}

async function apply(user, body = {}) {
  const type = clean(body.type).toUpperCase();
  const startDate = clean(body.startDate);
  const endDate = clean(body.endDate) || startDate;
  const note = clean(body.note);
  if (!TYPES[type]) throw bad('Choose a type of leave.', 'bad_type');
  if (!validDate(startDate) || !validDate(endDate)) throw bad('Choose the dates.', 'bad_date');
  if (startDate < today()) throw bad('Leave can\'t start in the past.', 'past');
  if (endDate < startDate) throw bad('The last day is before the first day.', 'bad_range');
  if (daysBetween(startDate, endDate) + 1 > MAX_DAYS) throw bad(`One leave can be at most ${MAX_DAYS} days.`, 'too_long');
  if (note.length > 500) throw bad('Keep the note under 500 characters.', 'note_too_long');

  const { leave, rows } = await inTx(async (db) => {
    if (!(await isStaffHere(db, user))) throw notFound();
    // One at a time per person, so two clicks can't make two overlapping leaves.
    await db.query('SELECT pg_advisory_xact_lock(727401, $1::int)', [Number(user.id) % 2147483647]);
    const { rows: clash } = await db.query(
      `SELECT to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e FROM staff_leave
        WHERE user_id = $1::bigint AND service_unit_id = $2::bigint AND status IN ('PENDING', 'APPROVED')
          AND start_date <= $4::date AND end_date >= $3::date LIMIT 1`,
      [user.id, user.companyId, startDate, endDate]
    );
    if (clash[0]) throw new HttpError(409, `You already have leave on ${span(clash[0].s, clash[0].e)}.`, 'overlap');
    const { rows: ins } = await db.query(
      `INSERT INTO staff_leave (user_id, service_unit_id, type, start_date, end_date, note)
       VALUES ($1::bigint, $2::bigint, $3::text, $4::date, $5::date, $6::text) RETURNING id::text AS id`,
      [user.id, user.companyId, type, startDate, endDate, note || null]
    );
    const l = await loadOne(db, user, ins[0].id);
    const n = await tellManagers(db, user, {
      title: `${user.name} asks for ${TYPES[type].toLowerCase()}: ${span(startDate, endDate)}`.slice(0, 200),
      body: note ? note.slice(0, 280) : null,
    });
    return { leave: toLeave(l), rows: n };
  });
  notifications.publish(rows, null);
  return leave;
}

// ---------- the Admin (or someone given "Staff leave") ----------

async function list(user, { view = 'pending' } = {}) {
  if (!isManager(user)) throw notFound();
  const now = today();
  const where = {
    pending: "l.status = 'PENDING' AND l.end_date >= $2::date",
    current: "l.status = 'APPROVED' AND l.end_date >= $2::date",
    all: 'TRUE',
  }[view];
  if (!where) throw bad('Unknown view.');
  const order = view === 'all' ? 'l.start_date DESC, l.id DESC' : 'l.start_date, l.id';
  const { rows } = await pool.query(`${SELECT} WHERE l.service_unit_id = $1::bigint AND ${where} ORDER BY ${order} LIMIT 300`, [user.companyId, now]);
  return { today: now, types: TYPES, leaves: rows.map((r) => toLeave(r, now)) };
}

// Every staff member: Available / On leave (till), next approved leave, open work.
async function board(user) {
  if (!isManager(user)) throw notFound();
  const { rows } = await pool.query(
    `SELECT u.id::text AS id, COALESCE(u.name, 'Employee ' || u.employee_id) AS name, u.its_number, u.employee_id, o.name AS occupation,
            (SELECT count(*)::int FROM requests w WHERE w.assigned_engineer_id = u.id AND w.service_unit_id = uc.service_unit_id
                AND w.status IN ${OPEN_WORK}) AS open_work,
            to_char(${onLeaveUntil('u.id', 'uc.service_unit_id', '$2::text')}, 'YYYY-MM-DD') AS on_leave_until,
            (SELECT json_build_object('start', to_char(l.start_date, 'YYYY-MM-DD'), 'end', to_char(l.end_date, 'YYYY-MM-DD'))
               FROM staff_leave l
              WHERE l.user_id = u.id AND l.service_unit_id = uc.service_unit_id AND l.status = 'APPROVED'
                AND l.start_date > (now() AT TIME ZONE $2::text)::date
              ORDER BY l.start_date LIMIT 1) AS next_leave,
            (SELECT count(*)::int FROM staff_leave l WHERE l.user_id = u.id AND l.service_unit_id = uc.service_unit_id
                AND l.status = 'PENDING' AND l.end_date >= (now() AT TIME ZONE $2::text)::date) AS pending
       FROM user_company uc
       JOIN users u ON u.id = uc.user_id AND u.is_active
       JOIN user_roles r ON r.user_id = u.id AND r.role = 'ENGINEER'
       LEFT JOIN occupations o ON o.id = uc.occupation_id
      WHERE uc.service_unit_id = $1::bigint
      ORDER BY (${onLeaveUntil('u.id', 'uc.service_unit_id', '$2::text')}) IS NULL, lower(o.name), lower(u.name)`,
    [user.companyId, config.timeZone]
  );
  return {
    today: today(),
    staff: rows.map((r) => ({
      id: r.id,
      name: r.name,
      itsNumber: r.its_number || null,
      employeeId: r.employee_id || null,
      occupation: r.occupation || null,
      onLeaveUntil: r.on_leave_until || null,
      nextLeave: r.next_leave || null,
      pending: r.pending,
      openWork: r.open_work,
    })),
  };
}

async function decide(user, id, body = {}) {
  if (!isManager(user)) throw notFound();
  const decision = clean(body.decision);
  const note = clean(body.note);
  if (!['approve', 'reject'].includes(decision)) throw bad('Approve or reject.', 'bad_decision');
  if (decision === 'reject' && note.length < 3) throw bad('Say why it is rejected.', 'note_required');
  if (note.length > 500) throw bad('Keep the note under 500 characters.', 'note_too_long');
  const { leave, rows } = await inTx(async (db) => {
    const l = await loadOne(db, user, id, { lock: true });
    if (l.status !== 'PENDING') throw new HttpError(409, 'This leave has already been decided.', 'not_pending');
    if (l.end_date < today()) throw new HttpError(409, 'These dates have passed.', 'past');
    if (String(l.user_id) === String(user.id) && user.delegated) throw new HttpError(409, 'Someone else has to decide your own leave.', 'own_leave');
    const status = decision === 'approve' ? 'APPROVED' : 'REJECTED';
    await db.query(
      `UPDATE staff_leave SET status = $2::text, decided_by = $3::bigint, decided_at = now(), decision_note = $4::text WHERE id = $1::bigint`,
      [l.id, status, user.id, note || null]
    );
    const fresh = await loadOne(db, user, l.id);
    const label = TYPES[l.type].toLowerCase();
    const n = [];
    const r = await tellPerson(db, user, l.user_id, {
      title: `Your ${label} ${span(l.start_date, l.end_date)} was ${status === 'APPROVED' ? 'approved' : 'rejected'}`.slice(0, 200),
      body: note ? note.slice(0, 280) : null,
    });
    if (r) n.push(r);
    return { leave: toLeave(fresh), rows: n };
  });
  notifications.publish(rows, null);
  return leave;
}

// The person: their own pending leave, or approved leave that hasn't started. The manager: any pending or
// approved leave that hasn't ended (a reason is required).
async function cancel(user, id, body = {}) {
  const note = clean(body.note);
  if (note.length > 500) throw bad('Keep the note under 500 characters.', 'note_too_long');
  const { leave, rows } = await inTx(async (db) => {
    const l = await loadOne(db, user, id, { lock: true });
    const own = String(l.user_id) === String(user.id);
    const manager = isManager(user);
    if (!own && !manager) throw notFound();
    const now = today();
    if (!['PENDING', 'APPROVED'].includes(l.status) || l.end_date < now) throw new HttpError(409, 'This leave can\'t be cancelled.', 'not_cancellable');
    if (!manager && l.status === 'APPROVED' && l.start_date <= now) throw new HttpError(409, 'This leave has started — ask your Admin.', 'started');
    if (!own && note.length < 3) throw bad('Say why it is cancelled.', 'note_required');
    await db.query(
      `UPDATE staff_leave SET status = 'CANCELLED', cancelled_by = $2::bigint, cancelled_at = now(),
              decision_note = COALESCE(NULLIF($3::text, ''), decision_note) WHERE id = $1::bigint`,
      [l.id, user.id, note]
    );
    const label = `${TYPES[l.type].toLowerCase()} ${span(l.start_date, l.end_date)}`;
    const n = [];
    if (own) {
      if (l.status === 'APPROVED' || !manager) n.push(...(await tellManagers(db, user, { title: `${user.name} cancelled their ${label}`.slice(0, 200) })));
    } else {
      const r = await tellPerson(db, user, l.user_id, { title: `Your ${label} was cancelled`.slice(0, 200), body: note.slice(0, 280) });
      if (r) n.push(r);
    }
    return { leave: toLeave(await loadOne(db, user, l.id)), rows: n };
  });
  notifications.publish(rows, null);
  return leave;
}

module.exports = { mine, apply, list, board, decide, cancel, TYPES, today };
