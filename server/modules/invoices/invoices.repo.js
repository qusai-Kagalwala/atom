// Invoice queries (Phase 11).
// Scope: Super Admin sees every invoice; an Engineer sees invoices they uploaded plus invoices
// linked (actively) to a ticket assigned to them. Anyone else sees none.

const PERSON = (alias) => `json_build_object(
    'id', ${alias}.id::text, 'name', COALESCE(${alias}.name, 'Employee ' || ${alias}.employee_id))`;
const REQ_NO = (alias) => `(CASE ${alias}.type WHEN 'SERVICE_REQUEST' THEN 'R-' ELSE 'T-' END || ${alias}.number)`;

const INVOICE_SELECT = `
  SELECT i.id, i.number, i.mime_type, i.size_bytes, i.original_name, i.supplier, i.reference,
         to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, i.note, i.stored_name,
         i.uploaded_by_id, ${PERSON('ub')} AS uploaded_by, i.created_at, i.updated_at,
         (SELECT count(*)::int FROM invoice_links l WHERE l.invoice_id = i.id AND l.unlinked_at IS NULL) AS link_count
    FROM invoices i
    JOIN users ub ON ub.id = i.uploaded_by_id`;

// SQL scope filter for invoice alias "i". Placeholder $<n> = the user's id.
function scopeClause(user, n) {
  if (user?.activeRole === 'SUPER_ADMIN') return { clause: 'TRUE', params: [] };
  if (user?.activeRole === 'ENGINEER') {
    return {
      clause: `(i.uploaded_by_id = $${n}::bigint OR EXISTS (
                 SELECT 1 FROM invoice_links sl JOIN requests sr ON sr.id = sl.request_id
                  WHERE sl.invoice_id = i.id AND sl.unlinked_at IS NULL AND sr.assigned_engineer_id = $${n}::bigint))`,
      params: [user.id],
    };
  }
  return { clause: 'FALSE', params: [] };
}

async function getByNumber(db, number, { forUpdate = false } = {}) {
  if (!/^\d{1,9}$/.test(String(number))) return null;
  if (forUpdate) {
    const { rows } = await db.query('SELECT id FROM invoices WHERE number = $1::int FOR UPDATE', [number]);
    if (!rows[0]) return null;
  }
  const { rows } = await db.query(`${INVOICE_SELECT} WHERE i.number = $1::int`, [number]);
  return rows[0] || null;
}

async function isVisible(db, user, invoiceId) {
  const { clause, params } = scopeClause(user, 2);
  const { rows } = await db.query(`SELECT 1 FROM invoices i WHERE i.id = $1::bigint AND ${clause}`, [invoiceId, ...params]);
  return rows.length === 1;
}

async function findBySha(db, sha) {
  const { rows } = await db.query(`${INVOICE_SELECT} WHERE i.file_sha256 = $1::text`, [sha]);
  return rows[0] || null;
}

async function insertInvoice(db, inv) {
  const { rows } = await db.query(
    `INSERT INTO invoices (service_unit_id, file_sha256, stored_name, mime_type, size_bytes, original_name,
                           supplier, reference, invoice_date, note, uploaded_by_id)
     VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::int, $6::text, $7::text, $8::text, $9::date, $10::text, $11::bigint)
     RETURNING id, number`,
    [inv.serviceUnitId, inv.sha256, inv.storedName, inv.mimeType, inv.sizeBytes, inv.originalName,
      inv.supplier, inv.reference, inv.invoiceDate, inv.note, inv.uploadedById]
  );
  return rows[0];
}

async function updateLabels(db, id, l) {
  await db.query(
    `UPDATE invoices SET supplier = $2::text, reference = $3::text, invoice_date = $4::date, note = $5::text
      WHERE id = $1::bigint`,
    [id, l.supplier, l.reference, l.invoiceDate, l.note]
  );
}

// → true if a new active link was made, false if it was already linked.
async function addLink(db, invoiceId, requestId, userId) {
  const { rowCount } = await db.query(
    `INSERT INTO invoice_links (invoice_id, request_id, linked_by_id) VALUES ($1::bigint, $2::bigint, $3::bigint)
     ON CONFLICT (invoice_id, request_id) WHERE unlinked_at IS NULL DO NOTHING`,
    [invoiceId, requestId, userId]
  );
  return rowCount === 1;
}

// → true if an active link was ended.
async function endLink(db, invoiceId, requestId, userId, reason) {
  const { rowCount } = await db.query(
    `UPDATE invoice_links SET unlinked_at = now(), unlinked_by_id = $3::bigint, unlink_reason = $4::text
      WHERE invoice_id = $1::bigint AND request_id = $2::bigint AND unlinked_at IS NULL`,
    [invoiceId, requestId, userId, reason]
  );
  return rowCount === 1;
}

// Every link ever made (active and ended), oldest first.
async function linksFor(db, invoiceId) {
  const { rows } = await db.query(
    `SELECT l.id, l.linked_at, l.unlinked_at, l.unlink_reason,
            ${PERSON('lb')} AS linked_by,
            CASE WHEN ub.id IS NULL THEN NULL ELSE ${PERSON('ub')} END AS unlinked_by,
            r.id AS request_id, r.number, r.type, r.title, r.status, r.assigned_engineer_id,
            ${REQ_NO('r')} AS request_number
       FROM invoice_links l
       JOIN requests r ON r.id = l.request_id
       JOIN users lb ON lb.id = l.linked_by_id
       LEFT JOIN users ub ON ub.id = l.unlinked_by_id
      WHERE l.invoice_id = $1::bigint
      ORDER BY l.linked_at, l.id`,
    [invoiceId]
  );
  return rows;
}

// Active invoices on one ticket (for the ticket page).
async function forRequest(db, requestId) {
  const { rows } = await db.query(
    `SELECT i.id, i.number, i.mime_type, i.size_bytes, i.original_name, i.supplier, i.reference,
            to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, l.linked_at, ${PERSON('lb')} AS linked_by
       FROM invoice_links l
       JOIN invoices i ON i.id = l.invoice_id
       JOIN users lb ON lb.id = l.linked_by_id
      WHERE l.request_id = $1::bigint AND l.unlinked_at IS NULL
      ORDER BY l.linked_at, l.id`,
    [requestId]
  );
  return rows;
}

// List + search. f = { q, linked: 'linked'|'unlinked'|undefined, limit, offset }
async function list(db, user, f) {
  const params = [];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = [];
  const scope = scopeClause(user, params.length + 1);
  params.push(...scope.params);
  where.push(scope.clause);

  const q = String(f.q || '').trim();
  if (q) {
    const ors = [];
    const inv = /^(?:INV-?)?(\d{1,9})$/i.exec(q);
    if (inv) ors.push(`i.number = ${add(Number(inv[1]))}::int`);
    const req = /^([TR])-?(\d{1,9})$/i.exec(q);
    if (req) {
      ors.push(`EXISTS (SELECT 1 FROM invoice_links ql JOIN requests qr ON qr.id = ql.request_id
                         WHERE ql.invoice_id = i.id AND ql.unlinked_at IS NULL AND qr.number = ${add(Number(req[2]))}::int)`);
    }
    const like = add(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    ors.push(`i.supplier ILIKE ${like}`, `i.reference ILIKE ${like}`, `i.original_name ILIKE ${like}`, `i.note ILIKE ${like}`);
    where.push(`(${ors.join(' OR ')})`);
  }
  const active = '(SELECT count(*) FROM invoice_links l WHERE l.invoice_id = i.id AND l.unlinked_at IS NULL)';
  if (f.linked === 'linked') where.push(`${active} > 0`);
  if (f.linked === 'unlinked') where.push(`${active} = 0`);

  const filter = where.join(' AND ');
  const countParams = [...params];
  const limit = add(f.limit);
  const offset = add(f.offset);
  const [items, count] = await Promise.all([
    db.query(
      `SELECT * FROM (${INVOICE_SELECT} WHERE ${filter}) x ORDER BY x.created_at DESC, x.id DESC LIMIT ${limit}::int OFFSET ${offset}::int`,
      params
    ),
    db.query(`SELECT count(*)::int AS total FROM invoices i WHERE ${filter}`, countParams),
  ]);
  return { rows: items.rows, total: count.rows[0].total };
}

// Ticket numbers each invoice in `ids` is actively linked to (for list rows).
async function linkedNumbers(db, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT l.invoice_id, r.assigned_engineer_id, ${REQ_NO('r')} AS request_number
       FROM invoice_links l JOIN requests r ON r.id = l.request_id
      WHERE l.invoice_id = ANY($1::bigint[]) AND l.unlinked_at IS NULL
      ORDER BY r.number`,
    [ids]
  );
  const map = new Map();
  for (const r of rows) {
    const key = String(r.invoice_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

module.exports = {
  scopeClause,
  getByNumber,
  isVisible,
  findBySha,
  insertInvoice,
  updateLabels,
  addLink,
  endLink,
  linksFor,
  forRequest,
  list,
  linkedNumbers,
};
