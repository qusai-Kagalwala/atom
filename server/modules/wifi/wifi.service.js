// Jamea Internet Access (shown as such everywhere; called "Wi-Fi passes" in code) — AVIT, decided 5 Nov 2026.
//   AVIT Admin: upload batches (Cisco ISE accounts: CSV Username, Password) with SSID + expiry, allocate
//   them to departments in buckets, give them out directly (one or in bulk), end a batch now (Reset).
//   HOD (Masool of a department, from the Idarah view's post): sees the department's passes, gives them
//   to people (by ITS — details from ATOM or eJamaat — or typed in), asks for more.
//   At expiry / Reset the batch's passes are DELETED; the batch keeps counts only (summary).
//   SECURITY: passwords are returned only to the Admin and the department's HOD, never logged, never put
//   in notifications or the email queue (emails go straight to SMTP).
const defaultPool = require('../../db/pool');
const { HttpError, notFound } = require('../../utils/httpError');
const notifRepo = require('../notifications/notifications.repo');
const notifications = require('../notifications/notifications.service');
const mailer = require('../../services/mailer');
const emailLayout = require('../../services/emailLayout');
const emailDesign = require('../../services/emailDesign');
const emailTemplates = require('../../services/emailTemplates');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const ejamaat = require('../../services/ejamaatClient');
const { config } = require('../../config/env');

let deps = { pool: defaultPool, mailer, ejamaat };
const setDeps = (next) => { deps = { ...deps, ...next }; };

const bad = (message, code) => new HttpError(400, message, code);
const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const isId = (v) => /^\d{1,18}$/.test(String(v ?? ''));
const isAdmin = (user) => user.activeRole === 'ADMIN' || user.activeRole === 'SUPER_ADMIN';
const MAX_ROWS = 10000;
const MAX_PER_PERSON = 500;
const MAX_PEOPLE = 2000;
const MAX_EMAIL_PASSES_PER_CALL = 500; // passes per call; one email per address

async function inTx(fn) {
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
const log = (db, e) =>
  db.query(
    `INSERT INTO wifi_log (batch_id, kind, actor_id, department_id, count, note) VALUES ($1::bigint, $2::text, $3::bigint, $4::bigint, $5::int, $6::text)`,
    [e.batchId ?? null, e.kind, e.actorId ?? null, e.departmentId ?? null, e.count ?? null, e.note ?? null]
  );

// ---------- HOD ----------
async function hodPosts(db = deps.pool) {
  const { rows } = await db.query('SELECT hod_posts FROM wifi_settings WHERE id = 1');
  return (rows[0]?.hod_posts || ['Masool']).map((p) => p.toLowerCase());
}
const HOD_MATCH = `(lower(btrim(p.post)) = ANY($POSTS::text[]) OR lower(btrim(p.post_category)) = ANY($POSTS::text[]))`;
// Who is HOD of which department (035, 7 Nov 2026): an active Idarah post that matches (Masool), or a
// Super Admin grant — minus any Super Admin revoke. → rows (user_id, department_id). $POSTS = the posts param.
const HODS = (postsParam) => `(
  (SELECT p.user_id, p.department_id FROM user_posts p WHERE p.is_active AND ${HOD_MATCH.replace(/\$POSTS/g, postsParam)}
   UNION
   SELECT a.user_id, a.department_id FROM wifi_hod_access a WHERE a.kind = 'grant')
  EXCEPT
  SELECT r.user_id, r.department_id FROM wifi_hod_access r WHERE r.kind = 'revoke')`;

// Departments where this person is HOD (active department).
async function hodDepartments(user, db = deps.pool) {
  const posts = await hodPosts(db);
  const { rows } = await db.query(
    `SELECT DISTINCT d.id::text AS id, d.name FROM ${HODS('$2')} h JOIN departments d ON d.id = h.department_id
      WHERE h.user_id = $1::bigint AND d.is_active
      ORDER BY d.name`,
    [user.id, posts]
  );
  return rows;
}

async function assertHod(user, departmentId, db = deps.pool) {
  if (!isId(departmentId)) throw notFound();
  const mine = await hodDepartments(user, db);
  if (!mine.some((d) => d.id === String(departmentId))) throw notFound();
}

// What this person may do here (drives the menu).
async function me(user) {
  const departments = await hodDepartments(user);
  return { isAdmin: isAdmin(user), hodDepartments: departments };
}

// ---------- settings (Super Admin) ----------
// Every department with its HODs (and where each comes from) and the people whose access was revoked.
async function getSettings() {
  const posts = await hodPosts();
  const { rows } = await deps.pool.query('SELECT hod_posts FROM wifi_settings WHERE id = 1');
  const { rows: depts } = await deps.pool.query('SELECT id::text AS id, name FROM departments WHERE is_active ORDER BY lower(name)');
  const { rows: people } = await deps.pool.query(
    `WITH post AS (SELECT DISTINCT p.user_id, p.department_id FROM user_posts p WHERE p.is_active AND ${HOD_MATCH.replace(/\$POSTS/g, '$1')}),
          acc AS (SELECT user_id, department_id, kind FROM wifi_hod_access)
     SELECT x.department_id::text AS department_id, u.id::text AS user_id, COALESCE(u.name, 'Employee ' || u.employee_id) AS name,
            u.its_number, u.employee_id, (post.user_id IS NOT NULL) AS by_post, acc.kind
       FROM (SELECT user_id, department_id FROM post UNION SELECT user_id, department_id FROM acc) x
       JOIN users u ON u.id = x.user_id
       LEFT JOIN post ON post.user_id = x.user_id AND post.department_id = x.department_id
       LEFT JOIN acc ON acc.user_id = x.user_id AND acc.department_id = x.department_id
      WHERE u.is_active
      ORDER BY lower(COALESCE(u.name, ''))`,
    [posts]
  );
  const byDept = new Map(depts.map((d) => [d.id, { id: d.id, name: d.name, hodList: [], revoked: [] }]));
  for (const r of people) {
    const d = byDept.get(r.department_id);
    if (!d) continue;
    const person = { userId: r.user_id, name: r.name, its: r.its_number || null, employeeId: r.employee_id || null };
    if (r.kind === 'revoke') d.revoked.push({ ...person, byPost: r.by_post });
    else d.hodList.push({ ...person, source: r.by_post ? 'post' : 'granted' });
  }
  const departments = [...byDept.values()].map((d) => ({ ...d, hods: d.hodList.map((h) => h.name).join(', ') || null }));
  return { hodPosts: rows[0]?.hod_posts || ['Masool'], departments, matching: posts };
}

// Super Admin: make someone HOD of one or more departments, or take HOD access away (even from a Masool).
//   body: { person: ITS number | Employee ID, departmentIds: [], kind: 'grant' | 'revoke' }
async function setHodAccess(user, body = {}) {
  const ref = clean(body.person);
  const kind = body.kind;
  if (!['grant', 'revoke'].includes(kind)) throw bad('Grant or revoke?', 'invalid');
  const deptIds = [...new Set((Array.isArray(body.departmentIds) ? body.departmentIds : []).map(String))];
  if (!deptIds.length || deptIds.length > 200 || !deptIds.every(isId)) throw bad('Choose at least one department.', 'no_department');
  if (!ref) throw bad('Enter an ITS number or Employee ID.', 'no_person');
  const { rows: u } = await deps.pool.query(
    `SELECT id::text AS id, COALESCE(name, 'Employee ' || employee_id) AS name FROM users
      WHERE is_active AND (its_number = $1::text OR upper(employee_id) = upper($1::text)) LIMIT 2`,
    [ref]
  );
  if (u.length !== 1) throw bad('No active ATOM user with that ITS number or Employee ID.', 'no_user');
  const { rows: d } = await deps.pool.query('SELECT id::text AS id, name FROM departments WHERE is_active AND id = ANY($1::bigint[])', [deptIds]);
  if (d.length !== deptIds.length) throw bad('Unknown department.', 'bad_department');
  await inTx(async (db) => {
    for (const dep of d) {
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        `INSERT INTO wifi_hod_access (user_id, department_id, kind, set_by) VALUES ($1::bigint, $2::bigint, $3::text, $4::bigint)
         ON CONFLICT (user_id, department_id) DO UPDATE SET kind = EXCLUDED.kind, set_by = EXCLUDED.set_by, set_at = now()`,
        [u[0].id, dep.id, kind, user.id]
      );
      // eslint-disable-next-line no-await-in-loop
      await log(db, { kind: 'settings', actorId: user.id, departmentId: dep.id, note: `HOD ${kind}: user ${u[0].id}` });
    }
  });
  return getSettings();
}

// Super Admin: undo a grant or a revoke (back to what the Idarah post says).
async function clearHodAccess(user, userId, departmentId) {
  if (!isId(userId) || !isId(departmentId)) throw notFound();
  const { rowCount } = await deps.pool.query('DELETE FROM wifi_hod_access WHERE user_id = $1::bigint AND department_id = $2::bigint', [userId, departmentId]);
  if (!rowCount) throw notFound();
  await log(deps.pool, { kind: 'settings', actorId: user.id, departmentId, note: `HOD access cleared: user ${userId}` });
  return getSettings();
}
async function setHodPosts(user, list) {
  if (!Array.isArray(list)) throw bad('Give a list of post names.', 'invalid');
  const posts = [...new Set(list.map(clean).filter(Boolean))];
  if (!posts.length || posts.length > 10 || posts.some((p) => p.length > 60)) throw bad('Give 1–10 post names (up to 60 characters each).', 'invalid');
  await deps.pool.query(
    `INSERT INTO wifi_settings (id, hod_posts, updated_by) VALUES (1, $1::text[], $2::bigint)
     ON CONFLICT (id) DO UPDATE SET hod_posts = EXCLUDED.hod_posts, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [posts, user.id]
  );
  await log(deps.pool, { kind: 'settings', actorId: user.id, note: `HOD posts: ${posts.join(', ')}` });
  return getSettings();
}

// Departments (Idarah) with their HODs; with a batch: allocated / given / left per department.
async function departmentList(batchId, db = deps.pool) {
  const posts = await hodPosts(db);
  const { rows } = await db.query(
    `SELECT d.id::text AS id, d.name,
            COALESCE((SELECT string_agg(DISTINCT COALESCE(u.name, 'Employee ' || u.employee_id), ', ')
                        FROM ${HODS('$1')} h JOIN users u ON u.id = h.user_id
                       WHERE h.department_id = d.id AND u.is_active), '') AS hods,
            COALESCE(x.allocated, 0)::int AS allocated, COALESCE(x.given, 0)::int AS given
       FROM departments d
       LEFT JOIN (SELECT department_id, count(*) AS allocated, count(*) FILTER (WHERE assigned_at IS NOT NULL) AS given
                    FROM wifi_passes WHERE batch_id = $2::bigint GROUP BY department_id) x ON x.department_id = d.id
      WHERE d.is_active
      ORDER BY lower(d.name)`,
    [posts, batchId]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, hods: r.hods || null, allocated: r.allocated, given: r.given, left: r.allocated - r.given }));
}

// ---------- batches ----------
const COUNTS = `
  count(p.id)::int AS total_now,
  count(p.id) FILTER (WHERE p.department_id IS NULL AND p.assigned_at IS NULL)::int AS free,
  count(p.id) FILTER (WHERE p.department_id IS NOT NULL)::int AS allocated,
  count(p.id) FILTER (WHERE p.department_id IS NOT NULL AND p.assigned_at IS NOT NULL)::int AS dept_given,
  count(p.id) FILTER (WHERE p.assigned_via = 'admin')::int AS admin_given`;

function toBatch(b) {
  const ended = Boolean(b.ended_at);
  return {
    id: String(b.id),
    name: b.name,
    ssid: b.ssid,
    expiresAt: b.expires_at,
    createdAt: b.created_at,
    createdBy: b.created_by_name || null,
    total: b.total,
    ended,
    endedAt: b.ended_at,
    endedReason: b.ended_reason,
    counts: ended
      ? b.summary || {}
      : { free: b.free, allocated: b.allocated, deptGiven: b.dept_given, adminGiven: b.admin_given, given: b.dept_given + b.admin_given },
  };
}

async function listBatches(user) {
  const { rows } = await deps.pool.query(
    `SELECT b.*, COALESCE(u.name, 'Employee ' || u.employee_id) AS created_by_name, ${COUNTS}
       FROM wifi_batches b LEFT JOIN wifi_passes p ON p.batch_id = b.id LEFT JOIN users u ON u.id = b.created_by
      WHERE b.service_unit_id = $1::bigint AND (b.ended_at IS NULL OR b.ended_at > now() - interval '60 days')
      GROUP BY b.id, u.name, u.employee_id
      ORDER BY (b.ended_at IS NOT NULL), b.expires_at`,
    [user.companyId]
  );
  return rows.map(toBatch);
}

async function liveBatch(db, user, batchId, { lock = false } = {}) {
  if (!isId(batchId)) throw notFound();
  const { rows } = await db.query(
    `SELECT * FROM wifi_batches WHERE id = $1::bigint AND service_unit_id = $2::bigint ${lock ? 'FOR UPDATE' : ''}`,
    [batchId, user.companyId]
  );
  const b = rows[0];
  if (!b) throw notFound();
  if (b.ended_at) throw new HttpError(409, 'This batch has ended — its passes were deleted.', 'batch_ended');
  if (new Date(b.expires_at) <= new Date()) throw new HttpError(409, 'This batch has expired.', 'batch_ended');
  return b;
}

async function getBatch(user, batchId) {
  const b = await liveBatch(deps.pool, user, batchId);
  const { rows } = await deps.pool.query(
    `SELECT b.*, COALESCE(u.name, 'Employee ' || u.employee_id) AS created_by_name, ${COUNTS}
       FROM wifi_batches b LEFT JOIN wifi_passes p ON p.batch_id = b.id LEFT JOIN users u ON u.id = b.created_by
      WHERE b.id = $1::bigint GROUP BY b.id, u.name, u.employee_id`,
    [b.id]
  );
  return { batch: toBatch(rows[0]), departments: await departmentList(b.id) };
}

// ---------- CSV ----------
// Small RFC 4180 reader: commas, quotes, CRLF / LF, UTF-8 with or without BOM.
function parseCsvText(text) {
  const out = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); out.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out.filter((r) => r.some((v) => String(v).trim() !== ''));
}

const USER_HEADERS = ['username', 'user name', 'user', 'login', 'user id', 'userid'];
const PASS_HEADERS = ['password', 'pass', 'pwd'];
// Cisco ISE exports may put a word before the column name ("<type> username"): a header ending in one of the names counts.
const headerIs = (h, names) => names.some((n) => h === n || h.endsWith(` ${n}`));

function readPassesCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const table = parseCsvText(text);
  if (!table.length) throw bad('The file is empty.', 'empty_file');
  const head = table[0].map((h) => clean(h).toLowerCase());
  const u = head.findIndex((h) => headerIs(h, USER_HEADERS));
  const p = head.findIndex((h) => headerIs(h, PASS_HEADERS));
  if (u === -1 || p === -1) throw bad('The first row must be the header: Username,Password', 'bad_columns');
  const rows = [];
  const errors = [];
  const seen = new Set();
  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    const username = String(r[u] ?? '').trim();
    const password = String(r[p] ?? '').trim();
    if (!username && !password) return;
    if (!username || !password) return errors.push({ row: line, message: 'Username or password is empty.' });
    if (username.length > 128 || password.length > 128) return errors.push({ row: line, message: 'Longer than 128 characters.' });
    const key = username.toLowerCase();
    if (seen.has(key)) return errors.push({ row: line, message: `Username "${username}" appears twice.` });
    seen.add(key);
    rows.push({ username, password });
    return undefined;
  });
  if (rows.length + errors.length > MAX_ROWS) throw bad(`More than ${MAX_ROWS} rows.`, 'too_many');
  return { rows, errors };
}

// Upload: preview (commit false) or save. body: { name, ssid, expiresAt, commit, skipErrors }
async function uploadBatch(user, buffer, body = {}, fileName = null) {
  const name = clean(body.name).slice(0, 80);
  const ssid = clean(body.ssid).slice(0, 64);
  const expiresAt = new Date(body.expiresAt);
  if (!name) throw bad('Give the batch a name.', 'bad_name');
  if (!ssid) throw bad('Enter the Wi-Fi network name (SSID).', 'bad_ssid');
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date(Date.now() + 60_000)) throw bad('Choose an expiry in the future.', 'bad_expiry');
  if (expiresAt > new Date(Date.now() + 366 * 86400_000)) throw bad('The expiry must be within a year.', 'bad_expiry');
  const { rows, errors } = readPassesCsv(buffer);
  if (!rows.length) throw bad('No passes in the file.', 'empty_file');
  const preview = { rows: rows.length, errors, sample: rows.slice(0, 5).map((r) => r.username), committed: false };
  const commit = body.commit === true || body.commit === 'true';
  if (!commit) return preview;
  if (errors.length && !(body.skipErrors === true || body.skipErrors === 'true')) {
    throw bad(`${errors.length} row(s) have errors. Fix them, or tick "Skip rows with errors".`, 'row_errors');
  }
  const batchId = await inTx(async (db) => {
    const { rows: b } = await db.query(
      `INSERT INTO wifi_batches (service_unit_id, name, ssid, expires_at, total, file_name, created_by)
       VALUES ($1::bigint, $2::text, $3::text, $4::timestamptz, $5::int, $6::text, $7::bigint) RETURNING id`,
      [user.companyId, name, ssid, expiresAt.toISOString(), rows.length, fileName, user.id]
    );
    const id = b[0].id;
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        `INSERT INTO wifi_passes (batch_id, username, password) SELECT $1::bigint, u, p FROM unnest($2::text[], $3::text[]) AS t(u, p)`,
        [id, chunk.map((r) => r.username), chunk.map((r) => r.password)]
      );
    }
    await log(db, { batchId: id, kind: 'upload', actorId: user.id, count: rows.length, note: fileName });
    return String(id);
  });
  return { ...preview, committed: true, batchId };
}

// End a batch now (Reset) or at expiry: counts kept, passes deleted.
async function endBatchTx(db, b, reason, actorId) {
  const { rows } = await db.query(
    `SELECT ${COUNTS} FROM wifi_passes p WHERE p.batch_id = $1::bigint`,
    [b.id]
  );
  const c = rows[0];
  const summary = { total: b.total, allocated: c.allocated, given: c.dept_given + c.admin_given, deptGiven: c.dept_given, adminGiven: c.admin_given };
  await db.query('DELETE FROM wifi_passes WHERE batch_id = $1::bigint', [b.id]);
  await db.query(
    `UPDATE wifi_batches SET ended_at = now(), ended_reason = $2::text, ended_by = $3::bigint, summary = $4::jsonb WHERE id = $1::bigint`,
    [b.id, reason, actorId, JSON.stringify(summary)]
  );
  await log(db, { batchId: b.id, kind: reason, actorId, count: c.total_now });
  return summary;
}

async function resetBatch(user, batchId) {
  return inTx(async (db) => {
    if (!isId(batchId)) throw notFound();
    const { rows } = await db.query('SELECT * FROM wifi_batches WHERE id = $1::bigint AND service_unit_id = $2::bigint FOR UPDATE', [batchId, user.companyId]);
    const b = rows[0];
    if (!b) throw notFound();
    if (b.ended_at) throw new HttpError(409, 'This batch has already ended.', 'batch_ended');
    return { summary: await endBatchTx(db, b, 'reset', user.id) };
  });
}

// Background job (every minute in the server, every 5 minutes from Task Scheduler): delete expired batches.
async function expireDue() {
  const { rows } = await deps.pool.query('SELECT id FROM wifi_batches WHERE ended_at IS NULL AND expires_at <= now() ORDER BY id');
  let n = 0;
  for (const { id } of rows) {
    // eslint-disable-next-line no-await-in-loop
    const done = await inTx(async (db) => {
      const { rows: b } = await db.query('SELECT * FROM wifi_batches WHERE id = $1::bigint AND ended_at IS NULL FOR UPDATE SKIP LOCKED', [id]);
      if (!b[0]) return false;
      await endBatchTx(db, b[0], 'expired', null);
      return true;
    });
    if (done) n += 1;
  }
  return n;
}

// ---------- allocation (buckets) ----------
// items: [{ departmentId, count }] — count = how many this department should have from this batch.
async function allocate(user, batchId, items = []) {
  if (!Array.isArray(items) || !items.length || items.length > 500) throw bad('Nothing to allocate.', 'invalid');
  const changes = await inTx(async (db) => {
    const b = await liveBatch(db, user, batchId, { lock: true });
    const { rows: depts } = await db.query('SELECT id::text AS id, name FROM departments WHERE is_active');
    const deptName = new Map(depts.map((d) => [d.id, d.name]));
    const out = [];
    for (const it of items) {
      const dep = String(it?.departmentId ?? '');
      const target = Number(it?.count);
      if (!deptName.has(dep)) throw bad('Unknown department.', 'bad_department');
      if (!Number.isInteger(target) || target < 0 || target > MAX_ROWS) throw bad('Counts must be whole numbers.', 'bad_count');
      // eslint-disable-next-line no-await-in-loop
      const { rows: cur } = await db.query(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE assigned_at IS NOT NULL)::int AS given
           FROM wifi_passes WHERE batch_id = $1::bigint AND department_id = $2::bigint`,
        [b.id, dep]
      );
      const { n, given } = cur[0];
      if (target === n) continue;
      if (target > n) {
        // eslint-disable-next-line no-await-in-loop
        const { rowCount, rows: moved } = await db.query(
          `UPDATE wifi_passes SET department_id = $2::bigint, allocated_at = now()
            WHERE id IN (SELECT id FROM wifi_passes WHERE batch_id = $1::bigint AND department_id IS NULL AND assigned_at IS NULL
                          ORDER BY id LIMIT $3::int)
            RETURNING id`,
          [b.id, dep, target - n]
        );
        if (rowCount < target - n) throw bad(`Not enough passes left in this batch for ${deptName.get(dep)}.`, 'not_enough');
        // eslint-disable-next-line no-await-in-loop
        await log(db, { batchId: b.id, kind: 'allocate', actorId: user.id, departmentId: dep, count: target - n });
        out.push({ departmentId: dep, name: deptName.get(dep), added: target - n, batch: b, passIds: moved.map((m) => m.id) });
      } else {
        if (target < given) throw bad(`${deptName.get(dep)} has already given out ${given} — it can't go below that.`, 'below_given');
        // eslint-disable-next-line no-await-in-loop
        await db.query(
          `UPDATE wifi_passes SET department_id = NULL, allocated_at = NULL
            WHERE id IN (SELECT id FROM wifi_passes WHERE batch_id = $1::bigint AND department_id = $2::bigint AND assigned_at IS NULL
                          ORDER BY id DESC LIMIT $3::int)`,
          [b.id, dep, n - target]
        );
        // eslint-disable-next-line no-await-in-loop
        await log(db, { batchId: b.id, kind: 'take_back', actorId: user.id, departmentId: dep, count: n - target });
      }
    }
    // Tell the HODs who received passes (no credentials in the notification).
    const rows = [];
    for (const c of out) {
      // eslint-disable-next-line no-await-in-loop
      const hods = await hodUsers(db, c.departmentId);
      for (const uid of hods) {
        // eslint-disable-next-line no-await-in-loop
        const r = await notifRepo.insertForUser(db, {
          userId: uid, type: 'wifi', title: `${c.added} Jamea Internet Access passes for ${c.name}`,
          body: `Batch "${c.batch.name}" · valid until ${fmtDate(c.batch.expires_at)}`, link: '/wifi', actorId: user.id, companyId: user.companyId,
        });
        if (r) rows.push(r);
      }
    }
    return { rows, out };
  });
  notifications.publish(changes.rows, null);
  // One email per HOD with the department's new passes in an Excel file (7 Nov 2026). Best effort,
  // after the change is saved: a mail problem never undoes the allocation.
  await emailHodsAllocation(user, changes.out).catch((err) => console.error('[ATOM] Wi-Fi HOD email failed:', err.message));
  return getBatch(user, batchId);
}

// Move unused passes from one department to another, or back to the unallocated pool (toDepartmentId null).
// Only passes not yet given to anyone move. Both HODs are told (no credentials).
async function movePasses(user, batchId, body = {}) {
  const from = String(body.fromDepartmentId ?? '');
  const to = body.toDepartmentId == null || body.toDepartmentId === '' ? null : String(body.toDepartmentId);
  const count = Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_ROWS) throw bad('Choose how many passes to move.', 'bad_count');
  if (from === to) throw bad('Choose a different department to move them to.', 'same_department');
  const rows = await inTx(async (db) => {
    const b = await liveBatch(db, user, batchId, { lock: true });
    const { rows: depts } = await db.query('SELECT id::text AS id, name FROM departments WHERE is_active AND id = ANY($1::bigint[])', [[from, to].filter(Boolean)]);
    const name = new Map(depts.map((d) => [d.id, d.name]));
    if (!name.has(from) || (to && !name.has(to))) throw bad('Unknown department.', 'bad_department');
    const { rowCount } = await db.query(
      `UPDATE wifi_passes SET department_id = $3::bigint, allocated_at = CASE WHEN $3::bigint IS NULL THEN NULL ELSE now() END
        WHERE id IN (SELECT id FROM wifi_passes WHERE batch_id = $1::bigint AND department_id = $2::bigint AND assigned_at IS NULL
                      ORDER BY id DESC LIMIT $4::int FOR UPDATE)`,
      [b.id, from, to, count]
    );
    if (rowCount < count) throw bad(`${name.get(from)} has only ${rowCount} unused ${rowCount === 1 ? 'pass' : 'passes'}.`, 'not_enough');
    const toName = to ? name.get(to) : 'the unallocated pool';
    await log(db, { batchId: b.id, kind: 'take_back', actorId: user.id, departmentId: from, count, note: `moved to ${toName}` });
    if (to) await log(db, { batchId: b.id, kind: 'allocate', actorId: user.id, departmentId: to, count, note: `moved from ${name.get(from)}` });
    const out = [];
    const tell = async (dep, title) => {
      for (const uid of await hodUsers(db, dep)) {
        // eslint-disable-next-line no-await-in-loop
        const r = await notifRepo.insertForUser(db, {
          userId: uid, type: 'wifi', title, body: `Batch "${b.name}" · valid until ${fmtDate(b.expires_at)}`, link: '/wifi', actorId: user.id, companyId: user.companyId,
        });
        if (r) out.push(r);
      }
    };
    const n = `${count} Jamea Internet Access ${count === 1 ? 'pass' : 'passes'}`;
    await tell(from, `${n} taken back from ${name.get(from)}`);
    if (to) await tell(to, `${n} for ${name.get(to)}`);
    return out;
  });
  notifications.publish(rows, null);
  return getBatch(user, batchId);
}

async function hodUsers(db, departmentId) {
  const posts = await hodPosts(db);
  const { rows } = await db.query(
    `SELECT DISTINCT u.id FROM ${HODS('$2')} h JOIN users u ON u.id = h.user_id
      WHERE h.department_id = $1::bigint AND u.is_active`,
    [departmentId, posts]
  );
  return rows.map((r) => String(r.id));
}

const fmtDate = (d) =>
  new Date(d).toLocaleString('en-IN', { timeZone: config.timeZone || 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

// ---------- passes ----------
function toPass(p) {
  return {
    id: String(p.id),
    batchId: String(p.batch_id),
    username: p.username,
    password: p.password,
    departmentId: p.department_id ? String(p.department_id) : null,
    department: p.department_name || null,
    assigned: Boolean(p.assigned_at),
    assignedAt: p.assigned_at,
    assignedVia: p.assigned_via,
    assignedBy: p.assigned_by_name || null,
    recipient: p.assigned_at ? { its: p.recipient_its, name: p.recipient_name, mobile: p.recipient_mobile, email: p.recipient_email } : null,
    sharedWhatsappAt: p.shared_whatsapp_at,
    sharedEmailAt: p.shared_email_at,
    ssid: p.ssid,
    expiresAt: p.expires_at,
    validUntil: p.assigned_at ? recipientUntil(p) : null, // what the person is told (10 days)
    batchName: p.batch_name,
    group: p.give_group || null, // given together with others: taken back together only
  };
}
const PASS_SELECT = `
  SELECT p.*, b.ssid, b.expires_at, b.name AS batch_name, d.name AS department_name,
         COALESCE(u.name, 'Employee ' || u.employee_id) AS assigned_by_name
    FROM wifi_passes p JOIN wifi_batches b ON b.id = p.batch_id
    LEFT JOIN departments d ON d.id = p.department_id LEFT JOIN users u ON u.id = p.assigned_by`;

// Admin: passes of a batch. view = given | free | all; q searches username / recipient.
async function listPasses(user, batchId, { view = 'given', q = '', departmentId = null, page = 1, pageSize = 50 } = {}) {
  const b = await liveBatch(deps.pool, user, batchId);
  const where = ['p.batch_id = $1::bigint'];
  const params = [b.id];
  if (view === 'given') where.push('p.assigned_at IS NOT NULL');
  if (view === 'free') where.push('p.assigned_at IS NULL AND p.department_id IS NULL');
  if (view === 'admin') where.push(`p.assigned_via = 'admin'`);
  if (departmentId) {
    if (!isId(departmentId)) throw notFound();
    params.push(departmentId);
    where.push(`p.department_id = $${params.length}::bigint`);
  }
  const term = clean(q).slice(0, 80);
  if (term) {
    params.push(`%${term.toLowerCase()}%`);
    where.push(`(lower(p.username) LIKE $${params.length} OR lower(COALESCE(p.recipient_name, '')) LIKE $${params.length}
                 OR COALESCE(p.recipient_its, '') LIKE $${params.length} OR COALESCE(p.recipient_mobile, '') LIKE $${params.length})`);
  }
  const size = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const pg = Math.max(1, Number(page) || 1);
  const { rows } = await deps.pool.query(
    `${PASS_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.assigned_at DESC NULLS LAST, p.id LIMIT ${size + 1} OFFSET ${(pg - 1) * size}`,
    params
  );
  const { rows: t } = await deps.pool.query(`SELECT count(*)::int AS n FROM wifi_passes p WHERE ${where.join(' AND ')}`, params);
  return { passes: rows.slice(0, size).map(toPass), total: t[0].n, page: pg, pageSize: size };
}

// HOD: one department's passes in every live batch.
async function departmentView(user, departmentId) {
  await assertHod(user, departmentId);
  const { rows: batches } = await deps.pool.query(
    `SELECT b.id::text AS id, b.name, b.ssid, b.expires_at,
            count(p.id)::int AS allocated, count(p.id) FILTER (WHERE p.assigned_at IS NOT NULL)::int AS given
       FROM wifi_batches b JOIN wifi_passes p ON p.batch_id = b.id AND p.department_id = $1::bigint
      WHERE b.ended_at IS NULL AND b.expires_at > now() AND b.service_unit_id = $2::bigint
      GROUP BY b.id ORDER BY b.expires_at`,
    [departmentId, user.companyId]
  );
  const { rows: given } = await deps.pool.query(
    `${PASS_SELECT} WHERE p.department_id = $1::bigint AND p.assigned_at IS NOT NULL AND b.ended_at IS NULL AND b.expires_at > now()
      ORDER BY p.assigned_at DESC, p.id LIMIT 1000`,
    [departmentId]
  );
  const { rows: reqs } = await deps.pool.query(
    `SELECT r.id::text AS id, r.count, r.reason, r.status, r.note, r.created_at, r.decided_at
       FROM wifi_requests r WHERE r.department_id = $1::bigint ORDER BY r.created_at DESC LIMIT 20`,
    [departmentId]
  );
  return {
    batches: batches.map((b) => ({ id: b.id, name: b.name, ssid: b.ssid, expiresAt: b.expires_at, allocated: b.allocated, given: b.given, left: b.allocated - b.given })),
    passes: given.map(toPass),
    requests: reqs.map((r) => ({ id: r.id, count: r.count, reason: r.reason, status: r.status, note: r.note, at: r.created_at, decidedAt: r.decided_at })),
  };
}

// ---------- people ----------
function readPerson(raw, n) {
  const its = clean(raw?.its);
  const name = clean(raw?.name).slice(0, 120);
  const mobile = clean(raw?.mobile).replace(/[\s().-]/g, '');
  const email = clean(raw?.email).toLowerCase();
  const count = raw?.count == null || raw?.count === '' ? 1 : Number(raw.count);
  const where = n != null ? `Row ${n}: ` : '';
  if (its && !/^\d{8}$/.test(its)) throw bad(`${where}ITS number must be 8 digits.`, 'bad_its');
  if (name.length < 2) throw bad(`${where}Enter the person's name.`, 'bad_name');
  if (mobile && !/^\+?\d{7,15}$/.test(mobile)) throw bad(`${where}Mobile number looks wrong.`, 'bad_mobile');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad(`${where}Email looks wrong.`, 'bad_email');
  if (!Number.isInteger(count) || count < 1 || count > MAX_PER_PERSON) throw bad(`${where}Passes per person must be 1–${MAX_PER_PERSON}.`, 'bad_count');
  return { its: its || null, name, mobile: mobile || null, email: email || null, count };
}

// Name, mobile, email for an ITS number: ATOM's own users first, then eJamaat.
async function lookupIts(user, its) {
  const n = clean(its);
  if (!/^\d{8}$/.test(n)) throw bad('ITS number must be 8 digits.', 'bad_its');
  const { rows } = await deps.pool.query('SELECT name, mobile, email FROM users WHERE its_number = $1::text', [n]);
  if (rows[0] && (rows[0].name || rows[0].mobile || rows[0].email)) {
    return { its: n, name: rows[0].name, mobile: rows[0].mobile, email: rows[0].email, source: 'atom' };
  }
  const d = await deps.ejamaat.getMuminDetails(n);
  if (d) return { its: n, name: d.name, mobile: d.mobile, email: d.email, source: 'ejamaat' };
  return { its: n, name: null, mobile: null, email: null, source: null };
}

// Give passes to people. scope: { departmentId } (HOD, from the department's passes) or { admin: true }
// (AVIT Admin, from the batch's unallocated passes). people: [{ its?, name, mobile?, email?, count? }]
async function assign(user, batchId, { departmentId = null, people = [] } = {}) {
  const adminDirect = !departmentId;
  if (adminDirect && !isAdmin(user)) throw notFound();
  if (!adminDirect && !isAdmin(user)) await assertHod(user, departmentId);
  if (!adminDirect && !isId(departmentId)) throw notFound();
  if (!Array.isArray(people) || !people.length) throw bad('Add at least one person.', 'no_people');
  if (people.length > MAX_PEOPLE) throw bad(`Up to ${MAX_PEOPLE} people at a time.`, 'too_many');
  const list = people.map((p, i) => readPerson(p, people.length > 1 ? i + 1 : null));
  const need = list.reduce((s, p) => s + p.count, 0);
  // 2+ passes given in one go form a group, taken back together only (035, 7 Nov 2026).
  const group = need > 1 ? crypto.randomUUID() : null;
  const ids = await inTx(async (db) => {
    const b = await liveBatch(db, user, batchId, { lock: true });
    const pool = adminDirect ? 'department_id IS NULL' : 'department_id = $2::bigint';
    const { rows: free } = await db.query(
      `SELECT id FROM wifi_passes WHERE batch_id = $1::bigint AND assigned_at IS NULL AND ${pool} ORDER BY id LIMIT ${need} FOR UPDATE`,
      adminDirect ? [b.id] : [b.id, departmentId]
    );
    if (free.length < need) {
      throw bad(`Only ${free.length} pass${free.length === 1 ? '' : 'es'} left ${adminDirect ? 'unallocated in this batch' : 'for this department in this batch'} — ${need} needed.`, 'not_enough');
    }
    const out = [];
    let k = 0;
    for (const p of list) {
      const mine = free.slice(k, k + p.count).map((r) => r.id);
      k += p.count;
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        `UPDATE wifi_passes SET assigned_at = now(), assigned_by = $2::bigint, assigned_via = $3::text,
                recipient_its = $4::text, recipient_name = $5::text, recipient_mobile = $6::text, recipient_email = $7::text,
                shared_whatsapp_at = NULL, shared_email_at = NULL, give_group = $8::uuid
          WHERE id = ANY($1::bigint[])`,
        [mine, user.id, adminDirect ? 'admin' : 'department', p.its, p.name, p.mobile, p.email, group]
      );
      out.push(...mine);
    }
    await log(db, { batchId: b.id, kind: 'assign', actorId: user.id, departmentId: adminDirect ? null : departmentId, count: need });
    return out;
  });
  const { rows } = await deps.pool.query(`${PASS_SELECT} WHERE p.id = ANY($1::bigint[]) ORDER BY p.id`, [ids]);
  return { passes: rows.map(toPass) };
}

// Load a pass the person may handle: Admin any; HOD only their department's.
async function ownPass(user, passId, db = deps.pool) {
  if (!isId(passId)) throw notFound();
  const { rows } = await db.query(`${PASS_SELECT} WHERE p.id = $1::bigint AND b.service_unit_id = $2::bigint AND b.ended_at IS NULL`, [passId, user.companyId]);
  const p = rows[0];
  if (!p) throw notFound();
  if (!isAdmin(user)) {
    if (!p.department_id) throw notFound();
    await assertHod(user, p.department_id, db);
  }
  return p;
}

// Take a pass back (wrong person): it returns to the department / unallocated pool.
async function unassign(user, passId) {
  const p = await ownPass(user, passId);
  if (!p.assigned_at) throw bad('This pass is not given to anyone.', 'not_assigned');
  if (p.give_group) throw new HttpError(409, 'This pass was given together with others — take them all back together.', 'in_group');
  await deps.pool.query(`UPDATE wifi_passes SET ${CLEAR_GIVEN} WHERE id = $1::bigint`, [p.id]);
  await log(deps.pool, { batchId: p.batch_id, kind: 'unassign', actorId: user.id, departmentId: p.department_id, count: 1 });
  return { ok: true };
}

const CLEAR_GIVEN = `assigned_at = NULL, assigned_by = NULL, assigned_via = NULL, recipient_its = NULL, recipient_name = NULL,
  recipient_mobile = NULL, recipient_email = NULL, shared_whatsapp_at = NULL, shared_email_at = NULL, give_group = NULL`;

// Take back every pass given together in one go (035). Same rights as for one pass.
async function unassignGroup(user, groupId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(groupId || ''))) throw notFound();
  return inTx(async (db) => {
    const { rows } = await db.query(
      `SELECT p.id, p.batch_id, p.department_id FROM wifi_passes p JOIN wifi_batches b ON b.id = p.batch_id
        WHERE p.give_group = $1::uuid AND b.service_unit_id = $2::bigint AND b.ended_at IS NULL FOR UPDATE OF p`,
      [groupId, user.companyId]
    );
    if (!rows.length) throw notFound();
    const dept = rows[0].department_id;
    if (!isAdmin(user)) {
      if (!dept) throw notFound();
      await assertHod(user, dept, db);
    }
    await db.query(`UPDATE wifi_passes SET ${CLEAR_GIVEN} WHERE give_group = $1::uuid`, [groupId]);
    await log(db, { batchId: rows[0].batch_id, kind: 'unassign', actorId: user.id, departmentId: dept, count: rows.length, note: 'given together' });
    return { ok: true, count: rows.length };
  });
}

async function markWhatsapp(user, passId) {
  const p = await ownPass(user, passId);
  if (!p.assigned_at) throw bad('Give the pass to someone first.', 'not_assigned');
  await deps.pool.query('UPDATE wifi_passes SET shared_whatsapp_at = now() WHERE id = $1::bigint', [p.id]);
  await log(deps.pool, { batchId: p.batch_id, kind: 'share_whatsapp', actorId: user.id, departmentId: p.department_id, count: 1 });
  return { ok: true };
}

// What the person is told (decided 5 Nov 2026): valid for 10 days from the day it was given, or the batch's
// real expiry if that is sooner. Admin and HOD pages keep showing the real expiry.
const RECIPIENT_DAYS = 10;
function recipientUntil(p) {
  const from = p.assigned_at ? new Date(p.assigned_at) : new Date();
  const shown = new Date(from.getTime() + RECIPIENT_DAYS * 86400_000);
  const real = new Date(p.expires_at);
  return shown < real ? shown : real;
}

function passMessage(p) {
  return [
    `Assalamu Alaikum ${p.recipient_name || ''},`.trim(),
    '',
    'Your Jamea Internet Access at Aljamea-tus-Saifiyah:',
    `Wi-Fi network (SSID): ${p.ssid}`,
    `Username: ${p.username}`,
    `Password: ${p.password}`,
    `Valid until: ${fmtDate(recipientUntil(p))}`,
    '',
    'Connect to the network, then sign in with the username and password above.',
  ].join('\n');
}

// Styled email for one person: one pass, or several (then the passes are in the attached Excel file).
// The wording comes from Settings → Email design → Jamea Internet Access (7 Nov 2026).
// Passwords appear only in this email / its attachment, never in logs or the queue.
function passEmail(p, company = '', design = emailDesign.DEFAULTS, count = 1) {
  const validUntil = fmtDate(recipientUntil(p));
  const t = emailTemplates.apply(design.templates, 'wifi', { name: p.recipient_name, company, ssid: p.ssid, validUntil, count });
  const many = count > 1;
  const mail = emailLayout.render({
    company,
    tag: 'Jamea Internet Access',
    tone: 'info',
    title: many ? `Your ${count} Jamea Internet Access passes` : 'Your Jamea Internet Access',
    greeting: t.greeting,
    paragraphs: [t.intro, many ? `All ${count} passes — username and password for each — are in the attached Excel file.` : null],
    details: many
      ? [['Wi-Fi network', p.ssid, { mono: true }], ['Passes', String(count)], ['Valid until', validUntil]]
      : [
        ['Wi-Fi network', p.ssid, { mono: true }],
        ['Username', p.username, { mono: true }],
        ['Password', p.password, { mono: true }],
        ['Valid until', validUntil],
      ],
    note: t.closing,
    preheader: `Wi-Fi network ${p.ssid} · valid until ${validUntil}`,
  }, design);
  return { subject: t.subject, ...mail };
}

// Excel file of passes (one row each). rows: pass rows from PASS_SELECT.
async function passesWorkbook(rows, { forRecipients = true } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Passes');
  ws.columns = [
    { header: 'No.', key: 'n', width: 6 },
    ...(forRecipients ? [{ header: 'Name', key: 'name', width: 28 }, { header: 'ITS', key: 'its', width: 12 }] : []),
    { header: 'Username', key: 'username', width: 22 },
    { header: 'Password', key: 'password', width: 20 },
    { header: 'Wi-Fi network', key: 'ssid', width: 18 },
    { header: 'Valid until', key: 'until', width: 24 },
  ];
  ws.getRow(1).font = { bold: true };
  rows.forEach((p, i) => {
    ws.addRow({
      n: i + 1,
      name: p.recipient_name || '',
      its: p.recipient_its || '',
      username: p.username,
      password: p.password,
      ssid: p.ssid,
      until: fmtDate(forRecipients ? recipientUntil(p) : p.expires_at),
    });
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const fileDate = () => new Date().toISOString().slice(0, 10);

// Email passes straight through SMTP (never through the email queue, which keeps bodies for 90 days).
// Passes for the same email address go in ONE email; 2+ passes come as an Excel file (7 Nov 2026).
// Different people each get their own email.
async function emailPasses(user, passIds = []) {
  if (!Array.isArray(passIds) || !passIds.length) throw bad('Choose passes to email.', 'invalid');
  if (passIds.length > MAX_EMAIL_PASSES_PER_CALL) throw bad(`Up to ${MAX_EMAIL_PASSES_PER_CALL} passes at a time.`, 'too_many');
  if (!config.smtp.host) throw new HttpError(503, 'Email is not set up on the server (SMTP).', 'smtp_missing');
  const design = await emailDesign.current(deps.pool);
  const company = user.company?.name || '';
  const results = [];
  const groups = new Map(); // email → passes
  for (const id of [...new Set(passIds.map(String))]) {
    let p;
    try {
      // eslint-disable-next-line no-await-in-loop
      p = await ownPass(user, id);
    } catch {
      results.push({ id: String(id), ok: false, error: 'Not found.' });
      continue;
    }
    if (!p.assigned_at || !p.recipient_email) {
      results.push({ id: String(p.id), ok: false, error: 'No email address.' });
      continue;
    }
    const key = p.recipient_email.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  let emails = 0;
  for (const [to, list] of groups) {
    const ids = list.map((p) => String(p.id));
    try {
      const mail = passEmail(list[0], company, design, list.length);
      if (list.length > 1) {
        // eslint-disable-next-line no-await-in-loop
        mail.attachments = [{ filename: `Jamea-Internet-Access-${fileDate()}.xlsx`, content: await passesWorkbook(list), contentType: XLSX }];
      }
      // eslint-disable-next-line no-await-in-loop
      await deps.mailer.sendMail({ to, ...mail });
      // eslint-disable-next-line no-await-in-loop
      await deps.pool.query('UPDATE wifi_passes SET shared_email_at = now() WHERE id = ANY($1::bigint[])', [ids]);
      ids.forEach((id) => results.push({ id, ok: true }));
      emails += 1;
    } catch (err) {
      ids.forEach((id) => results.push({ id, ok: false, error: 'Could not send.' }));
      console.error('[ATOM] Wi-Fi pass email failed:', err.message); // never the body
    }
  }
  const sent = results.filter((r) => r.ok).length;
  if (sent) await log(deps.pool, { kind: 'share_email', actorId: user.id, count: sent, note: `${emails} email${emails === 1 ? '' : 's'}` });
  return { results, sent, emails };
}

// After an allocation: each HOD of the department gets one email with the new passes in an Excel file.
// In ATOM the HOD still sees every pass on its own, to give out by ITS and share by email / WhatsApp.
async function emailHodsAllocation(user, allocated) {
  if (!config.smtp.host || !allocated.length) return 0;
  const design = await emailDesign.current(deps.pool);
  const company = user.company?.name || '';
  let n = 0;
  for (const a of allocated) {
    // eslint-disable-next-line no-await-in-loop
    const hodIds = await hodUsers(deps.pool, a.departmentId);
    if (!hodIds.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const { rows: hods } = await deps.pool.query(
      `SELECT name, email FROM users WHERE id = ANY($1::bigint[]) AND is_active AND email LIKE '%@%'`,
      [hodIds]
    );
    if (!hods.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const { rows: passes } = await deps.pool.query(`${PASS_SELECT} WHERE p.id = ANY($1::bigint[]) ORDER BY p.id`, [a.passIds]);
    if (!passes.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const file = await passesWorkbook(passes, { forRecipients: false });
    const until = fmtDate(a.batch.expires_at);
    for (const h of hods) {
      const t = emailTemplates.apply(design.templates, 'wifi', { name: h.name, company, ssid: a.batch.ssid, validUntil: until, count: passes.length });
      const mail = emailLayout.render({
        company,
        tag: 'Jamea Internet Access',
        tone: 'info',
        title: `${passes.length} Jamea Internet Access passes for ${a.name}`,
        greeting: t.greeting,
        paragraphs: [
          `${passes.length} passes have been allocated to ${a.name}. Their usernames and passwords are in the attached Excel file.`,
          'Give them out from the Jamea Internet Access page in ATOM — by ITS number — and share each one by email or WhatsApp from there.',
        ],
        details: [['Wi-Fi network', a.batch.ssid, { mono: true }], ['Passes', String(passes.length)], ['Batch valid until', until]],
        button: { url: `${config.appUrl}/wifi`, label: 'Open Jamea Internet Access' },
        preheader: `${passes.length} passes for ${a.name}`,
      }, design);
      try {
        // eslint-disable-next-line no-await-in-loop
        await deps.mailer.sendMail({
          to: h.email.trim(),
          subject: `${passes.length} Jamea Internet Access passes for ${a.name}`,
          ...mail,
          attachments: [{ filename: `Jamea-Internet-Access-${a.name.replace(/[^\w-]+/g, '-')}-${fileDate()}.xlsx`, content: file, contentType: XLSX }],
        });
        n += 1;
      } catch (err) {
        console.error('[ATOM] Wi-Fi HOD email failed:', err.message); // never the body
      }
    }
  }
  if (n) await log(deps.pool, { kind: 'share_email', actorId: user.id, count: n, note: 'HOD allocation emails' });
  return n;
}

// ---------- requests ----------
async function requestMore(user, departmentId, body = {}) {
  await assertHod(user, departmentId);
  const count = Number(body.count);
  const reason = clean(body.reason).slice(0, 500);
  if (!Number.isInteger(count) || count < 1 || count > MAX_ROWS) throw bad('How many passes? (a whole number)', 'bad_count');
  if (reason.length < 3) throw bad('Say what they are for.', 'bad_reason');
  const rows = await inTx(async (db) => {
    const { rows: r } = await db.query(
      `INSERT INTO wifi_requests (service_unit_id, department_id, requested_by, count, reason) VALUES ($1::bigint, $2::bigint, $3::bigint, $4::int, $5::text) RETURNING id`,
      [user.companyId, departmentId, user.id, count, reason]
    );
    await log(db, { kind: 'request', actorId: user.id, departmentId, count, note: `request ${r[0].id}` });
    const { rows: d } = await db.query('SELECT name FROM departments WHERE id = $1::bigint', [departmentId]);
    return notifRepo.insertForRole(db, {
      role: 'ADMIN', features: ['wifi'], type: 'wifi', title: `${d[0]?.name || 'A department'} asks for ${count} Jamea Internet Access passes`,
      body: reason, link: '/wifi?tab=requests', actorId: user.id, companyId: user.companyId,
    });
  });
  notifications.publish(rows, null);
  return departmentView(user, departmentId);
}

async function listRequests(user) {
  const { rows } = await deps.pool.query(
    `SELECT r.id::text AS id, r.count, r.reason, r.status, r.note, r.created_at, r.decided_at, d.id::text AS department_id, d.name AS department,
            COALESCE(u.name, 'Employee ' || u.employee_id) AS by
       FROM wifi_requests r JOIN departments d ON d.id = r.department_id JOIN users u ON u.id = r.requested_by
      WHERE r.service_unit_id = $1::bigint AND (r.status = 'open' OR r.decided_at > now() - interval '30 days')
      ORDER BY (r.status <> 'open'), r.created_at DESC LIMIT 200`,
    [user.companyId]
  );
  return rows.map((r) => ({ id: r.id, count: r.count, reason: r.reason, status: r.status, note: r.note, at: r.created_at, decidedAt: r.decided_at,
    department: { id: r.department_id, name: r.department }, by: r.by }));
}

async function decideRequest(user, id, body = {}) {
  if (!isId(id)) throw notFound();
  const status = body.status === 'declined' ? 'declined' : body.status === 'done' ? 'done' : null;
  if (!status) throw bad('Choose done or declined.', 'invalid');
  const note = clean(body.note).slice(0, 500) || null;
  if (status === 'declined' && !note) throw bad('Say why it is declined.', 'note_required');
  const rows = await inTx(async (db) => {
    const { rows: r } = await db.query(
      `UPDATE wifi_requests SET status = $2::text, note = $3::text, decided_by = $4::bigint, decided_at = now()
        WHERE id = $1::bigint AND service_unit_id = $5::bigint AND status = 'open' RETURNING *`,
      [id, status, note, user.id, user.companyId]
    );
    if (!r[0]) throw notFound();
    await log(db, { kind: status === 'done' ? 'request_done' : 'request_declined', actorId: user.id, departmentId: r[0].department_id, count: r[0].count });
    const n = await notifRepo.insertForUser(db, {
      userId: r[0].requested_by, type: 'wifi',
      title: status === 'done' ? 'Your Jamea Internet Access request is done' : 'Your Jamea Internet Access request was declined',
      body: note, link: '/wifi', actorId: user.id, companyId: user.companyId,
    });
    return n ? [n] : [];
  });
  notifications.publish(rows, null);
  return listRequests(user);
}

module.exports = {
  setHodAccess, clearHodAccess, unassignGroup,
  me, getSettings, setHodPosts, listBatches, getBatch, uploadBatch, resetBatch, expireDue, allocate, departmentList,
  listPasses, departmentView, lookupIts, assign, unassign, markWhatsapp, emailPasses, requestMore, listRequests, decideRequest,
  readPassesCsv, parseCsvText, movePasses, passMessage, passEmail, passesWorkbook, recipientUntil, RECIPIENT_DAYS, hodDepartments, setDeps,
};
