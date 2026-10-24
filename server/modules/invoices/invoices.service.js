// Invoices (Phase 11, ATOM_Decisions.md §11 + decisions 24 Oct 2026).
//   - Engineers and Super Admins upload (route guard). No amounts; labels are optional.
//   - Duplicate (same SHA-256) → { duplicate } (route answers 409). Sending the same file again with
//     linkExisting=true links the existing invoice to the chosen tickets instead.
//   - Link: Super Admin → any ticket; Engineer → only tickets assigned to them. Any status.
//   - Unlink: Super Admin only, reason required. The link row is kept (history).
//   - Requesters never see invoices: ticket timeline events for invoices are internal.
//   - Out of scope = 404.
const pool = require('../../db/pool');
const repo = require('./invoices.repo');
const files = require('./invoiceFiles');
const requestsRepo = require('../requests/requests.repo');
const notifications = require('../notifications/notifications.service');
const { HttpError, notFound } = require('../../utils/httpError');

const MAX_LINKS_PER_CALL = 20;
const bad = (message, code) => new HttpError(400, message, code);
const isAdmin = (user) => user?.activeRole === 'SUPER_ADMIN';
const isEngineer = (user) => user?.activeRole === 'ENGINEER';
const same = (a, b) => a != null && b != null && String(a) === String(b);
const clean = (v) => (v == null ? '' : String(v).trim());

const displayNumber = (inv) => `INV-${inv.number}`;
const requestNumber = (r) => `${r.type === 'SERVICE_REQUEST' ? 'R' : 'T'}-${r.number}`;

function parseInvoiceNumber(value) {
  const m = /^(?:INV-?)?(\d{1,9})$/i.exec(clean(value));
  return m ? m[1] : null;
}

function parseRequestNumber(value) {
  const m = /^(?:[TR]-)?(\d{1,9})$/i.exec(clean(value));
  return m ? m[1] : null;
}

async function inTransaction(fn) {
  const after = [];
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await fn(client, (cb) => after.push(cb));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  for (const cb of after) {
    try {
      cb();
    } catch (err) {
      console.error('After-commit step failed:', err.message);
    }
  }
  return result;
}

// ---------- input ----------
function parseLabels(input) {
  const supplier = clean(input.supplier) || null;
  const reference = clean(input.reference) || null;
  const note = clean(input.note) || null;
  const dateText = clean(input.invoiceDate);
  if (supplier && supplier.length > 120) throw bad('Keep the supplier under 120 characters.', 'bad_supplier');
  if (reference && reference.length > 80) throw bad('Keep the invoice number under 80 characters.', 'bad_reference');
  if (note && note.length > 1000) throw bad('Keep the note under 1000 characters.', 'bad_note');

  let invoiceDate = null;
  if (dateText) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
    const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const valid = d && d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
    const latest = Date.now() + 31 * 86_400_000;
    if (!valid || +m[1] < 2000 || d.getTime() > latest) throw bad('Enter a valid invoice date.', 'bad_date');
    invoiceDate = dateText;
  }
  return { supplier, reference, note, invoiceDate };
}

// "T-1001, 1002" | ["T-1001", "1002"] → ['1001', '1002'] (deduped, validated)
function parseRequestList(value) {
  let list = value;
  if (typeof list === 'string') {
    const s = list.trim();
    if (s.startsWith('[')) {
      try {
        list = JSON.parse(s);
      } catch {
        throw bad('Choose the tickets to link.', 'bad_requests');
      }
    } else list = s ? s.split(/[\s,]+/) : [];
  }
  if (list == null) list = [];
  if (!Array.isArray(list)) throw bad('Choose the tickets to link.', 'bad_requests');
  const numbers = [];
  for (const item of list) {
    const n = parseRequestNumber(item);
    if (!n) throw bad(`"${String(item).slice(0, 20)}" is not a ticket number.`, 'bad_requests');
    if (!numbers.includes(n)) numbers.push(n);
  }
  if (numbers.length > MAX_LINKS_PER_CALL) throw bad(`Link up to ${MAX_LINKS_PER_CALL} tickets at a time.`, 'too_many_requests');
  return numbers;
}

const canLinkTo = (user, r) => isAdmin(user) || (isEngineer(user) && same(r.assigned_engineer_id, user.id));
const canEdit = (user, inv) => isAdmin(user) || (isEngineer(user) && same(inv.uploaded_by_id, user.id));

// Locks and checks every ticket. A ticket you can't link to looks missing (404).
async function loadLinkTargets(db, user, numbers) {
  const targets = [];
  for (const n of numbers) {
    // eslint-disable-next-line no-await-in-loop
    const r = await requestsRepo.getByNumber(db, n, { forUpdate: true });
    if (!r || !canLinkTo(user, r)) {
      const err = notFound();
      err.message = `Ticket T-${n} was not found, or you can't link invoices to it.`;
      throw err;
    }
    targets.push(r);
  }
  return targets;
}

// Links + one internal timeline event per new link. → { added: [...], already: [...] }
async function linkAll(db, user, inv, targets, afterCommit) {
  const added = [];
  const already = [];
  for (const r of targets) {
    // eslint-disable-next-line no-await-in-loop
    if (await repo.addLink(db, inv.id, r.id, user.id)) {
      // eslint-disable-next-line no-await-in-loop
      await requestsRepo.insertEvent(db, {
        requestId: r.id,
        type: 'invoice_linked',
        actorId: user.id,
        internal: true,
        data: { invoiceId: String(inv.id), invoiceNumber: displayNumber(inv) },
      });
      // eslint-disable-next-line no-await-in-loop
      await requestsRepo.touch(db, r.id);
      added.push(requestNumber(r));
      afterCommit(() => notifications.publish([], r)); // open ticket pages / lists refresh
    } else already.push(requestNumber(r));
  }
  return { added, already };
}

// ---------- shapes ----------
function fileUrl(inv) {
  return `/invoices/${displayNumber(inv)}/file`;
}

function toSummary(inv, linked = []) {
  return {
    id: String(inv.id),
    number: displayNumber(inv),
    supplier: inv.supplier,
    reference: inv.reference,
    invoiceDate: inv.invoice_date,
    note: inv.note,
    fileType: inv.mime_type === 'application/pdf' ? 'pdf' : 'image',
    sizeBytes: inv.size_bytes,
    originalName: inv.original_name,
    uploadedBy: inv.uploaded_by,
    createdAt: inv.created_at,
    linkCount: inv.link_count,
    linked,
    fileUrl: fileUrl(inv),
  };
}

// Engineers see only the links to their own assigned tickets; other links are only counted.
async function toDetail(db, user, inv) {
  const links = await repo.linksFor(db, inv.id);
  const visible = links.filter((l) => isAdmin(user) || same(l.assigned_engineer_id, user.id));
  const activeHidden = links.filter((l) => !l.unlinked_at && !visible.includes(l)).length;
  return {
    ...toSummary(
      inv,
      visible
        .filter((l) => !l.unlinked_at)
        .sort((a, b) => a.number - b.number)
        .map((l) => l.request_number)
    ),
    links: visible.map((l) => ({
      id: String(l.id),
      request: { number: l.request_number, title: l.title, status: l.status },
      linkedBy: l.linked_by,
      linkedAt: l.linked_at,
      unlinkedBy: l.unlinked_by,
      unlinkedAt: l.unlinked_at,
      unlinkReason: l.unlink_reason,
    })),
    otherLinks: activeHidden,
    permissions: {
      canLink: isAdmin(user) || isEngineer(user),
      canUnlink: isAdmin(user),
      canEdit: canEdit(user, inv),
    },
  };
}

async function loadVisible(db, user, numberParam, opts) {
  const number = parseInvoiceNumber(numberParam);
  const inv = number && (await repo.getByNumber(db, number, opts));
  if (!inv || !(await repo.isVisible(db, user, inv.id))) throw notFound();
  return inv;
}

// ---------- upload ----------
async function upload(user, input, file) {
  const labels = parseLabels(input || {});
  const numbers = parseRequestList(input?.requestNumbers);
  const linkExisting = input?.linkExisting === true || input?.linkExisting === 'true';
  const processed = await files.processInvoiceFile(file);

  const written = { id: null, storedName: null };
  try {
    return await inTransaction(async (db, afterCommit) => {
      // Same file uploaded at the same moment by two people: serialise on the hash.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 727311))', [processed.sha256]);
      const existing = await repo.findBySha(db, processed.sha256);
      if (existing) {
        if (!linkExisting) {
          const visible = await repo.isVisible(db, user, existing.id);
          return {
            duplicate: {
              number: displayNumber(existing),
              createdAt: existing.created_at,
              ...(visible ? { supplier: existing.supplier, reference: existing.reference } : {}),
            },
          };
        }
        // Holding the same file is enough to link it to tickets you may link to.
        if (!numbers.length) throw bad('Choose at least one ticket to link this invoice to.', 'no_requests');
        const targets = await loadLinkTargets(db, user, numbers);
        const result = await linkAll(db, user, existing, targets, afterCommit);
        const fresh = await repo.getByNumber(db, existing.number);
        return { invoice: await toDetail(db, user, fresh), linkedExisting: true, ...result };
      }

      const serviceUnitId = await requestsRepo.defaultServiceUnitId(db);
      if (!serviceUnitId) throw new HttpError(503, 'Invoices are not available right now.', 'no_service_unit');
      const targets = await loadLinkTargets(db, user, numbers);

      const storedName = files.newStoredName(processed.ext);
      const row = await repo.insertInvoice(db, {
        serviceUnitId,
        sha256: processed.sha256,
        storedName,
        mimeType: processed.mimeType,
        sizeBytes: processed.buffer.length,
        originalName: clean(file.originalname).slice(0, 200) || null,
        ...labels,
        uploadedById: user.id,
      });
      await files.writeFile(row.id, storedName, processed.buffer);
      written.id = row.id;
      written.storedName = storedName;

      const result = await linkAll(db, user, row, targets, afterCommit);
      const fresh = await repo.getByNumber(db, row.number);
      return { invoice: await toDetail(db, user, fresh), created: true, ...result };
    });
  } catch (err) {
    if (written.storedName) await files.removeFile(written.id, written.storedName);
    throw err;
  }
}

// ---------- read ----------
async function list(user, f) {
  const { rows, total } = await repo.list(pool, user, f);
  const numbers = await repo.linkedNumbers(pool, rows.map((r) => r.id));
  return {
    invoices: rows.map((inv) =>
      toSummary(
        inv,
        (numbers.get(String(inv.id)) || [])
          .filter((l) => isAdmin(user) || same(l.assigned_engineer_id, user.id))
          .map((l) => l.request_number)
      )
    ),
    total,
  };
}

async function detail(user, numberParam) {
  const inv = await loadVisible(pool, user, numberParam);
  return toDetail(pool, user, inv);
}

async function getFile(user, numberParam) {
  const inv = await loadVisible(pool, user, numberParam);
  const ext = inv.mime_type === 'application/pdf' ? 'pdf' : 'webp';
  return { path: files.filePath(inv.id, inv.stored_name), mimeType: inv.mime_type, downloadName: `${displayNumber(inv)}.${ext}` };
}

// For the ticket page (only called for users who may see internal content).
async function forRequest(db, requestId) {
  const rows = await repo.forRequest(db, requestId);
  return rows.map((inv) => ({
    id: String(inv.id),
    number: displayNumber(inv),
    supplier: inv.supplier,
    reference: inv.reference,
    invoiceDate: inv.invoice_date,
    fileType: inv.mime_type === 'application/pdf' ? 'pdf' : 'image',
    sizeBytes: inv.size_bytes,
    linkedAt: inv.linked_at,
    linkedBy: inv.linked_by,
    fileUrl: fileUrl(inv),
  }));
}

// ---------- change ----------
async function updateLabels(user, numberParam, input) {
  return inTransaction(async (db) => {
    const inv = await loadVisible(db, user, numberParam, { forUpdate: true });
    if (!canEdit(user, inv)) throw notFound();
    const labels = parseLabels({
      supplier: input.supplier !== undefined ? input.supplier : inv.supplier,
      reference: input.reference !== undefined ? input.reference : inv.reference,
      note: input.note !== undefined ? input.note : inv.note,
      invoiceDate: input.invoiceDate !== undefined ? input.invoiceDate : inv.invoice_date,
    });
    await repo.updateLabels(db, inv.id, labels);
    return toDetail(db, user, await repo.getByNumber(db, inv.number));
  });
}

async function link(user, numberParam, requestNumbers) {
  const numbers = parseRequestList(requestNumbers);
  if (!numbers.length) throw bad('Choose at least one ticket to link.', 'no_requests');
  return inTransaction(async (db, afterCommit) => {
    const inv = await loadVisible(db, user, numberParam, { forUpdate: true });
    const targets = await loadLinkTargets(db, user, numbers);
    const result = await linkAll(db, user, inv, targets, afterCommit);
    return { invoice: await toDetail(db, user, await repo.getByNumber(db, inv.number)), ...result };
  });
}

async function unlink(user, numberParam, requestNumberParam, reason) {
  if (!isAdmin(user)) throw notFound();
  const why = clean(reason);
  if (why.length < 3) throw bad('Enter a reason (at least 3 characters).', 'reason_required');
  if (why.length > 500) throw bad('Keep the reason under 500 characters.', 'reason_too_long');
  const n = parseRequestNumber(requestNumberParam);
  if (!n) throw notFound();

  return inTransaction(async (db, afterCommit) => {
    const inv = await loadVisible(db, user, numberParam, { forUpdate: true });
    const r = await requestsRepo.getByNumber(db, n, { forUpdate: true });
    if (!r || !(await repo.endLink(db, inv.id, r.id, user.id, why))) throw notFound();
    await requestsRepo.insertEvent(db, {
      requestId: r.id,
      type: 'invoice_unlinked',
      actorId: user.id,
      internal: true,
      note: why,
      data: { invoiceId: String(inv.id), invoiceNumber: displayNumber(inv) },
    });
    await requestsRepo.touch(db, r.id);
    afterCommit(() => notifications.publish([], r));
    return { invoice: await toDetail(db, user, await repo.getByNumber(db, inv.number)) };
  });
}

module.exports = {
  upload,
  list,
  detail,
  getFile,
  forRequest,
  updateLabels,
  link,
  unlink,
  parseLabels,
  parseRequestList,
  parseInvoiceNumber,
  MAX_LINKS_PER_CALL,
};
