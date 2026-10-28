// SQL for tickets. Functions take `db` (pool or transaction client).
const PERSON = (alias) => `json_build_object(
    'id', ${alias}.id::text, 'name', COALESCE(${alias}.name, 'Employee ' || ${alias}.employee_id),
    'loginType', ${alias}.login_type, 'itsNumber', ${alias}.its_number, 'employeeId', ${alias}.employee_id)`;

const REQUEST_SELECT = `
  SELECT r.id, r.number, r.type, r.status, r.priority, r.title, r.description, r.location,
         r.category_id, c.name AS category_name, r.service_unit_id, s.code AS service_unit_code,
         r.requester_id, r.raised_by_id, r.assigned_engineer_id, r.resolution, r.rejection_note,
         r.created_at, r.updated_at, r.assigned_at, r.resolved_at, r.closed_at, r.rejected_at,
         ${PERSON('req')} AS requester,
         ${PERSON('rb')} AS raised_by,
         CASE WHEN eng.id IS NULL THEN NULL ELSE ${PERSON('eng')} END AS assigned_engineer
    FROM requests r
    JOIN users req ON req.id = r.requester_id
    JOIN users rb ON rb.id = r.raised_by_id
    LEFT JOIN users eng ON eng.id = r.assigned_engineer_id
    LEFT JOIN categories c ON c.id = r.category_id
    JOIN service_units s ON s.id = r.service_unit_id`;

async function getByNumber(db, number, { forUpdate = false } = {}) {
  if (!/^\d{1,9}$/.test(String(number))) return null;
  if (forUpdate) {
    // Lock the row first (FOR UPDATE can't sit on the joined select's outer joins).
    const { rows: lock } = await db.query('SELECT id FROM requests WHERE number = $1::int FOR UPDATE', [number]);
    if (!lock[0]) return null;
  }
  const { rows } = await db.query(`${REQUEST_SELECT} WHERE r.number = $1::int`, [number]);
  return rows[0] || null;
}

// The person's department location (Idarah posts or HR list) — the one with a room first.
async function departmentLocation(db, userId) {
  if (!/^\d{1,18}$/.test(String(userId))) return null;
  const { rows } = await db.query(
    `SELECT d.building, d.floor, d.room_no
       FROM departments d
      WHERE d.is_active
        AND d.id IN (SELECT p.department_id FROM user_posts p WHERE p.user_id = $1::bigint AND p.is_active
                     UNION SELECT h.department_id FROM user_departments h WHERE h.user_id = $1::bigint AND h.is_active)
        AND (d.building IS NOT NULL OR d.floor IS NOT NULL OR d.room_no IS NOT NULL)
      ORDER BY (d.room_no IS NULL), (d.floor IS NULL), d.idarah_id
      LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function defaultServiceUnitId(db) {
  const { rows } = await db.query(`SELECT id FROM service_units WHERE code = 'AVIT' AND is_active`);
  return rows[0]?.id ?? null;
}

async function getCategory(db, id) {
  if (!/^\d{1,18}$/.test(String(id))) return null;
  const { rows } = await db.query('SELECT id, name, service_unit_id, is_active FROM categories WHERE id = $1::bigint', [id]);
  return rows[0] || null;
}

async function listCategories(db, serviceUnitId) {
  const { rows } = await db.query(
    `SELECT id, name FROM categories WHERE service_unit_id = $1::bigint AND is_active ORDER BY sort_order, name`,
    [serviceUnitId]
  );
  return rows;
}

async function getActiveUser(db, id) {
  if (!/^\d{1,18}$/.test(String(id))) return null;
  const { rows } = await db.query('SELECT id, is_active FROM users WHERE id = $1::bigint', [id]);
  return rows[0]?.is_active ? rows[0] : null;
}

async function insertRequest(db, r) {
  const { rows } = await db.query(
    `INSERT INTO requests (type, priority, title, description, location, category_id, service_unit_id, requester_id, raised_by_id)
     VALUES ('TICKET', $1::request_priority, $2::text, $3::text, $4::text, $5::bigint, $6::bigint, $7::bigint, $8::bigint)
     RETURNING id, number`,
    [r.priority, r.title, r.description, r.location, r.categoryId, r.serviceUnitId, r.requesterId, r.raisedById]
  );
  return rows[0];
}

async function insertEvent(db, e) {
  const { rows } = await db.query(
    `INSERT INTO request_events (request_id, type, actor_id, from_status, to_status, note, is_internal, data)
     VALUES ($1::bigint, $2::text, $3::bigint, $4::request_status, $5::request_status, $6::text, $7::boolean, $8::jsonb)
     RETURNING id, created_at`,
    [e.requestId, e.type, e.actorId, e.fromStatus ?? null, e.toStatus ?? null, e.note ?? null, Boolean(e.internal), e.data ? JSON.stringify(e.data) : null]
  );
  return rows[0];
}

// Status + the timestamp/columns that go with it.
async function updateStatus(db, id, { status, resolution, rejectionNote }) {
  await db.query(
    `UPDATE requests SET status = $2::request_status,
            resolution     = COALESCE($3::text, resolution),
            rejection_note = COALESCE($4::text, rejection_note),
            resolved_at = CASE WHEN $2::request_status = 'RESOLVED' THEN now() ELSE resolved_at END,
            closed_at   = CASE WHEN $2::request_status = 'CLOSED'   THEN now() ELSE closed_at END,
            rejected_at = CASE WHEN $2::request_status = 'REJECTED' THEN now() ELSE rejected_at END
      WHERE id = $1::bigint`,
    [id, status, resolution ?? null, rejectionNote ?? null]
  );
}

async function assignEngineer(db, id, engineerId, status) {
  await db.query(
    `UPDATE requests SET assigned_engineer_id = $2::bigint, status = $3::request_status, assigned_at = now()
      WHERE id = $1::bigint`,
    [id, engineerId, status]
  );
}

async function setPriority(db, id, priority) {
  await db.query('UPDATE requests SET priority = $2::request_priority WHERE id = $1::bigint', [id, priority]);
}

async function setCategory(db, id, categoryId) {
  await db.query('UPDATE requests SET category_id = $2::bigint WHERE id = $1::bigint', [id, categoryId]);
}

async function touch(db, id) {
  await db.query('UPDATE requests SET updated_at = now() WHERE id = $1::bigint', [id]);
}

// Engineer who may be assigned: active, holds ENGINEER, tagged to the ticket's service unit.
async function eligibleEngineers(db, serviceUnitId) {
  const { rows } = await db.query(
    `SELECT u.id::text AS id, COALESCE(u.name, 'Employee ' || u.employee_id) AS name,
            (SELECT count(*)::int FROM requests w
              WHERE w.assigned_engineer_id = u.id
                AND w.status IN ('ASSIGNED','IN_PROGRESS','WAITING_FOR_USER','WAITING_FOR_EQUIPMENT')) AS open_work
       FROM users u
       JOIN user_roles r ON r.user_id = u.id AND r.role = 'ENGINEER'
       JOIN user_service_units t ON t.user_id = u.id AND t.service_unit_id = $1::bigint
      WHERE u.is_active
      ORDER BY open_work, lower(u.name)`,
    [serviceUnitId]
  );
  return rows;
}

// -> { id, name } when the user may be assigned, else null.
async function eligibleEngineer(db, userId, serviceUnitId) {
  if (!/^\d{1,18}$/.test(String(userId))) return null;
  const { rows } = await db.query(
    `SELECT u.id::text AS id, COALESCE(u.name, 'Employee ' || u.employee_id) AS name FROM users u
       JOIN user_roles r ON r.user_id = u.id AND r.role = 'ENGINEER'
       JOIN user_service_units t ON t.user_id = u.id AND t.service_unit_id = $2::bigint
      WHERE u.id = $1::bigint AND u.is_active`,
    [userId, serviceUnitId]
  );
  return rows[0] || null;
}

async function listEvents(db, requestId) {
  const { rows } = await db.query(
    `SELECT e.id::text AS id, e.type, e.from_status, e.to_status, e.note, e.is_internal, e.data, e.created_at,
            CASE WHEN a.id IS NULL THEN NULL ELSE ${PERSON('a')} END AS actor
       FROM request_events e LEFT JOIN users a ON a.id = e.actor_id
      WHERE e.request_id = $1::bigint
      ORDER BY e.created_at, e.id`,
    [requestId]
  );
  return rows;
}

async function listAttachments(db, requestId) {
  const { rows } = await db.query(
    `SELECT a.id::text AS id, a.event_id::text AS event_id, a.stored_name, a.original_name, a.mime_type,
            a.size_bytes, a.width, a.height, a.created_at, a.uploaded_by::text AS uploaded_by,
            COALESCE(e.is_internal, FALSE) AS is_internal
       FROM request_attachments a LEFT JOIN request_events e ON e.id = a.event_id
      WHERE a.request_id = $1::bigint
      ORDER BY a.created_at, a.id`,
    [requestId]
  );
  return rows;
}

async function countAttachments(db, requestId) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM request_attachments WHERE request_id = $1::bigint', [requestId]);
  return rows[0].n;
}

async function insertAttachment(db, a) {
  await db.query(
    `INSERT INTO request_attachments (request_id, event_id, uploaded_by, stored_name, original_name, mime_type, size_bytes, width, height)
     VALUES ($1::bigint, $2::bigint, $3::bigint, $4::text, $5::text, $6::text, $7::int, $8::int, $9::int)`,
    [a.requestId, a.eventId ?? null, a.uploadedBy, a.storedName, a.originalName, a.mimeType, a.sizeBytes, a.width, a.height]
  );
}

async function getAttachment(db, requestId, attachmentId) {
  if (!/^\d{1,18}$/.test(String(attachmentId))) return null;
  const { rows } = await db.query(
    `SELECT a.id, a.stored_name, a.mime_type, COALESCE(e.is_internal, FALSE) AS is_internal
       FROM request_attachments a LEFT JOIN request_events e ON e.id = a.event_id
      WHERE a.request_id = $1::bigint AND a.id = $2::bigint`,
    [requestId, attachmentId]
  );
  return rows[0] || null;
}

// "My tickets & requests": everything the user is the requester of (or raised for someone).
async function listMine(db, userId, { open, limit, offset }) {
  const { rows } = await db.query(
    `SELECT r.id, r.number, r.type, r.status, r.priority, r.title, r.created_at, r.updated_at,
            c.name AS category_name, ${PERSON('req')} AS requester,
            CASE WHEN eng.id IS NULL THEN NULL ELSE ${PERSON('eng')} END AS assigned_engineer,
            count(*) OVER () AS total
       FROM requests r
       JOIN users req ON req.id = r.requester_id
       LEFT JOIN users eng ON eng.id = r.assigned_engineer_id
       LEFT JOIN categories c ON c.id = r.category_id
      WHERE (r.requester_id = $1::bigint OR r.raised_by_id = $1::bigint)
        AND ($2::boolean IS NULL OR (r.status NOT IN ('CLOSED', 'REJECTED')) = $2::boolean)
      ORDER BY r.updated_at DESC, r.id DESC
      LIMIT $3::int OFFSET $4::int`,
    [userId, open ?? null, limit, offset]
  );
  return { rows, total: rows.length ? Number(rows[0].total) : 0 };
}

// Queues and "All tickets" (Phase 7). The caller passes the scope clause from recordScopeSql(),
// so a list can never contain rows the viewer couldn't open.
//   f.statuses       request_status[] or null
//   f.priority       one priority or null
//   f.categoryId     bigint or null
//   f.engineerId     bigint | 'none' (unassigned) | null
//   f.assignedTo     bigint — only rows assigned to this user (work queue)
//   f.q              number ("T-1001" / "1001"), title, requester name / ITS / employee ID
//   f.sort           'updated' (default) | 'priority' (urgent first, then oldest) | 'oldest'
const SORTS = {
  updated: 'r.updated_at DESC, r.id DESC',
  oldest: 'r.created_at ASC, r.id ASC',
  priority: `CASE r.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, r.created_at ASC, r.id ASC`,
};

async function listRequests(db, scope, f) {
  const params = [...scope.params];
  const where = [scope.clause];
  // Every "?" in `sql` becomes the same new placeholder.
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };

  if (f.statuses?.length) add('r.status = ANY(?::request_status[])', f.statuses);
  if (f.type) add('r.type = ?::request_type', f.type);
  if (f.priority) add('r.priority = ?::request_priority', f.priority);
  if (f.categoryId) add('r.category_id = ?::bigint', f.categoryId);
  if (f.engineerId === 'none') where.push('r.assigned_engineer_id IS NULL');
  else if (f.engineerId) add('r.assigned_engineer_id = ?::bigint', f.engineerId);
  if (f.assignedTo) add('r.assigned_engineer_id = ?::bigint', f.assignedTo);
  if (f.q) {
    const num = /^(?:[TR]-)?(\d{1,9})$/i.exec(f.q);
    if (num) add('r.number = ?::int', num[1]);
    else {
      const pattern = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      add(
        `(r.title ILIKE ?::text OR req.name ILIKE ?::text OR req.its_number LIKE ?::text
          OR req.employee_id LIKE ?::text OR r.location ILIKE ?::text)`,
        pattern
      );
    }
  }

  params.push(f.limit, f.offset);
  const { rows } = await db.query(
    `SELECT r.id, r.number, r.type, r.status, r.priority, r.title, r.location, r.created_at, r.updated_at,
            c.name AS category_name, ${PERSON('req')} AS requester,
            CASE WHEN eng.id IS NULL THEN NULL ELSE ${PERSON('eng')} END AS assigned_engineer,
            (SELECT max(e.created_at) FROM request_events e
              WHERE e.request_id = r.id AND e.type IN ('created', 'status', 'assigned')) AS status_since,
            count(*) OVER () AS total
       FROM requests r
       JOIN users req ON req.id = r.requester_id
       LEFT JOIN users eng ON eng.id = r.assigned_engineer_id
       LEFT JOIN categories c ON c.id = r.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${SORTS[f.sort] || SORTS.updated}
      LIMIT $${params.length - 1}::int OFFSET $${params.length}::int`,
    params
  );
  return { rows, total: rows.length ? Number(rows[0].total) : 0 };
}

// Sidebar badges.
async function queueCounts(db, userId) {
  const { rows } = await db.query(
    `SELECT
       count(*) FILTER (WHERE assigned_engineer_id = $1::bigint
                          AND status IN ('ASSIGNED','IN_PROGRESS','WAITING_FOR_USER','WAITING_FOR_EQUIPMENT'))::int AS work,
       count(*) FILTER (WHERE status = 'OPEN')::int AS unassigned,
       count(*) FILTER (WHERE status = 'RESOLVED')::int AS to_close,
       count(*) FILTER (WHERE status = 'PENDING_APPROVAL')::int AS approvals
       FROM requests`,
    [userId]
  );
  return rows[0];
}

module.exports = {
  listRequests,
  queueCounts,
  getByNumber,
  defaultServiceUnitId,
  getCategory,
  listCategories,
  getActiveUser,
  insertRequest,
  insertEvent,
  updateStatus,
  assignEngineer,
  setPriority,
  setCategory,
  touch,
  eligibleEngineers,
  eligibleEngineer,
  listEvents,
  listAttachments,
  countAttachments,
  insertAttachment,
  getAttachment,
  departmentLocation,
  listMine,
};
