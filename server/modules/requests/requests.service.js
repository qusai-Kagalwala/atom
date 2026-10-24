// Tickets (Phase 6). Every change: one transaction, ticket row locked, scope + lifecycle checked,
// one timeline event written. Out of scope = 404 (assertRecordInScope).
const pool = require('../../db/pool');
const repo = require('./requests.repo');
const lifecycle = require('./lifecycle');
const files = require('./attachments');
const { assertRecordInScope } = require('../../middleware/scope');
const { HttpError, notFound } = require('../../utils/httpError');

const REQUESTER_PRIORITIES = new Set(['LOW', 'NORMAL', 'URGENT']); // "How urgent?"
const ALL_PRIORITIES = new Set(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

const bad = (message, code) => new HttpError(400, message, code);
const displayNumber = (r) => `${r.type === 'SERVICE_REQUEST' ? 'R' : 'T'}-${r.number}`;
const clean = (v) => (v == null ? '' : String(v).trim());

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// "T-1001" or "1001" → 1001
function parseNumber(value) {
  const m = /^(?:[TR]-)?(\d{1,9})$/i.exec(String(value || '').trim());
  return m ? m[1] : null;
}

async function loadInScope(db, req, numberParam, opts) {
  const number = parseNumber(numberParam);
  const record = number && (await repo.getByNumber(db, number, opts));
  if (!record) throw notFound();
  assertRecordInScope(req, record);
  return record;
}

// ---------- shapes ----------
function toSummary(r) {
  return {
    id: String(r.id),
    number: displayNumber(r),
    type: r.type,
    status: r.status,
    priority: r.priority,
    title: r.title,
    category: r.category_name || null,
    requester: r.requester,
    assignedEngineer: r.assigned_engineer || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function toDetail(db, user, r) {
  const seeInternal = lifecycle.canSeeInternal(user, r);
  const [events, attachments] = await Promise.all([repo.listEvents(db, r.id), repo.listAttachments(db, r.id)]);
  const visibleAttachments = attachments.filter((a) => seeInternal || !a.is_internal);

  return {
    ...toSummary(r),
    description: r.description,
    location: r.location,
    categoryId: r.category_id ? String(r.category_id) : null,
    raisedBy: r.raised_by,
    raisedForSomeoneElse: String(r.raised_by_id) !== String(r.requester_id),
    resolution: r.resolution,
    rejectionNote: r.rejection_note,
    assignedAt: r.assigned_at,
    resolvedAt: r.resolved_at,
    closedAt: r.closed_at,
    rejectedAt: r.rejected_at,
    attachments: visibleAttachments.map((a) => ({
      id: a.id,
      eventId: a.event_id,
      width: a.width,
      height: a.height,
      sizeBytes: a.size_bytes,
      originalName: a.original_name,
      isInternal: a.is_internal,
      url: `/requests/${r.number}/attachments/${a.id}`,
    })),
    events: events
      .filter((e) => seeInternal || !e.is_internal)
      .map((e) => ({
        id: e.id,
        type: e.type,
        fromStatus: e.from_status,
        toStatus: e.to_status,
        note: e.note,
        isInternal: e.is_internal,
        data: e.data,
        actor: e.actor,
        at: e.created_at,
      })),
    permissions: {
      actions: lifecycle.allowedActions(user, r),
      canComment: lifecycle.canComment(user, r),
      canAddInternalNote: seeInternal && lifecycle.canComment(user, r),
      canEditTriage: lifecycle.canEditTriage(user, r),
      canAddPhotos: lifecycle.canComment(user, r) && attachments.length < files.MAX_FILES_PER_TICKET,
      photosLeft: Math.max(0, files.MAX_FILES_PER_TICKET - attachments.length),
    },
  };
}

// ---------- read ----------
async function getTicket(user, numberParam) {
  const r = await loadInScope(pool, { user }, numberParam);
  return toDetail(pool, user, r);
}

async function listMine(user, { open, limit, offset }) {
  const { rows, total } = await repo.listMine(pool, user.id, { open, limit, offset });
  return { requests: rows.map(toSummary), total };
}

async function listCategories() {
  const unitId = await repo.defaultServiceUnitId(pool);
  if (!unitId) return [];
  return (await repo.listCategories(pool, unitId)).map((c) => ({ id: String(c.id), name: c.name }));
}

// ---------- photos (shared by create + comment) ----------
async function savePhotos(db, request, uploads, uploaderId, eventId) {
  if (!uploads?.length) return [];
  const already = await repo.countAttachments(db, request.id);
  if (already + uploads.length > files.MAX_FILES_PER_TICKET) {
    const left = Math.max(0, files.MAX_FILES_PER_TICKET - already);
    throw bad(left ? `You can add ${left} more photo${left === 1 ? '' : 's'} to this ticket.` : 'This ticket already has 5 photos.', 'too_many_files');
  }
  const stored = await files.storeImages(request.id, uploads);
  try {
    for (const s of stored) {
      // eslint-disable-next-line no-await-in-loop
      await repo.insertAttachment(db, { requestId: request.id, eventId, uploadedBy: uploaderId, ...s });
    }
  } catch (err) {
    await files.removeStored(request.id, stored);
    throw err;
  }
  return stored;
}

// ---------- create ----------
async function createTicket(user, input, uploads) {
  const title = clean(input.title);
  const description = clean(input.description);
  const location = clean(input.location) || null;
  const isAdmin = user.activeRole === 'SUPER_ADMIN';
  const priority = clean(input.priority).toUpperCase() || 'NORMAL';

  if (title.length < 3 || title.length > 120) throw bad('Give the ticket a short title (3–120 characters).', 'bad_title');
  if (!description || description.length > 5000) throw bad('Describe the problem (up to 5000 characters).', 'bad_description');
  if (location && location.length > 200) throw bad('Keep the location under 200 characters.', 'bad_location');
  if (!(isAdmin ? ALL_PRIORITIES : REQUESTER_PRIORITIES).has(priority)) throw bad('Choose how urgent it is.', 'bad_priority');

  // Files are written inside the transaction; if anything after that fails, delete them again.
  const written = { requestId: null, files: [] };
  let created;
  try {
    created = await inTransaction(async (db) => {
      const serviceUnitId = await repo.defaultServiceUnitId(db);
      if (!serviceUnitId) throw new HttpError(503, 'Ticketing is not available right now.', 'no_service_unit');

      const category = await repo.getCategory(db, input.categoryId);
      if (!category || !category.is_active || String(category.service_unit_id) !== String(serviceUnitId)) {
        throw bad('Choose a category.', 'bad_category');
      }

      // Raise for someone else: Super Admin only (Decisions §9).
      let requesterId = user.id;
      if (input.requesterId && String(input.requesterId) !== String(user.id)) {
        if (!isAdmin) throw notFound();
        const person = await repo.getActiveUser(db, input.requesterId);
        if (!person) throw bad('Choose an active person to raise this for.', 'bad_requester');
        requesterId = String(person.id);
      }

      const row = await repo.insertRequest(db, {
        priority,
        title,
        description,
        location,
        categoryId: category.id,
        serviceUnitId,
        requesterId,
        raisedById: user.id,
      });
      await repo.insertEvent(db, {
        requestId: row.id,
        type: 'created',
        actorId: user.id,
        toStatus: 'OPEN',
        data: requesterId !== String(user.id) ? { raisedFor: requesterId } : null,
      });
      written.requestId = row.id;
      written.files = await savePhotos(db, row, uploads, user.id, null);
      return row;
    });
  } catch (err) {
    if (written.files.length) await files.removeStored(written.requestId, written.files);
    throw err;
  }
  return getTicket(user, created.number);
}

// ---------- lifecycle actions ----------
async function act(user, numberParam, action, body = {}) {
  const note = clean(body.note);
  return inTransaction(async (db) => {
    const r = await loadInScope(db, { user }, numberParam, { forUpdate: true });
    const rule = lifecycle.assertAllowed(user, r, action);
    if (rule.noteRequired && note.length < 3) throw bad(rule.noteRequired, 'note_required');
    if (note.length > 5000) throw bad('Keep the note under 5000 characters.', 'note_too_long');

    if (action === 'assign') {
      const engineerId = clean(body.engineerId);
      const engineer = await repo.eligibleEngineer(db, engineerId, r.service_unit_id);
      if (!engineer) throw bad('Choose an active engineer tagged to this service unit.', 'bad_engineer');
      if (String(r.assigned_engineer_id) === engineerId) throw bad('Already assigned to this engineer.', 'no_change');
      const to = lifecycle.nextStatus('assign', r.status);
      await repo.assignEngineer(db, r.id, engineerId, to);
      await repo.insertEvent(db, {
        requestId: r.id,
        type: 'assigned',
        actorId: user.id,
        fromStatus: r.status,
        toStatus: to,
        note: note || null,
        data: {
          engineerId,
          engineerName: engineer.name,
          previousEngineerId: r.assigned_engineer_id ? String(r.assigned_engineer_id) : null,
          previousEngineerName: r.assigned_engineer?.name || null,
        },
      });
    } else {
      const to = lifecycle.nextStatus(action, r.status);
      await repo.updateStatus(db, r.id, {
        status: to,
        resolution: action === 'resolve' ? note : null,
        rejectionNote: action === 'reject' ? note : null,
      });
      await repo.insertEvent(db, {
        requestId: r.id,
        type: 'status',
        actorId: user.id,
        fromStatus: r.status,
        toStatus: to,
        note: note || null,
        data: { action },
      });
    }
    const fresh = await repo.getByNumber(db, r.number);
    return toDetail(db, user, fresh);
  });
}

// Super Admin triage: priority / category.
async function triage(user, numberParam, { priority, categoryId }) {
  return inTransaction(async (db) => {
    const r = await loadInScope(db, { user }, numberParam, { forUpdate: true });
    if (!lifecycle.canEditTriage(user, r)) {
      if (user.activeRole === 'SUPER_ADMIN') throw new HttpError(409, 'This ticket is closed.', 'wrong_status');
      throw notFound();
    }
    if (priority !== undefined) {
      const p = clean(priority).toUpperCase();
      if (!ALL_PRIORITIES.has(p)) throw bad('Choose a priority.', 'bad_priority');
      if (p !== r.priority) {
        await repo.setPriority(db, r.id, p);
        await repo.insertEvent(db, { requestId: r.id, type: 'priority', actorId: user.id, data: { from: r.priority, to: p } });
      }
    }
    if (categoryId !== undefined) {
      const c = await repo.getCategory(db, categoryId);
      if (!c || !c.is_active || String(c.service_unit_id) !== String(r.service_unit_id)) throw bad('Choose a category.', 'bad_category');
      if (String(c.id) !== String(r.category_id)) {
        await repo.setCategory(db, r.id, c.id);
        await repo.insertEvent(db, {
          requestId: r.id,
          type: 'category',
          actorId: user.id,
          data: { from: r.category_name, to: c.name },
        });
      }
    }
    return toDetail(db, user, await repo.getByNumber(db, r.number));
  });
}

// ---------- comments (+ photos) ----------
async function comment(user, numberParam, body, uploads) {
  const text = clean(body.note);
  const internal = body.internal === true || body.internal === 'true';
  if (!text && !uploads?.length) throw bad('Write a comment or add a photo.', 'empty_comment');
  if (text.length > 5000) throw bad('Keep the comment under 5000 characters.', 'note_too_long');

  const written = { requestId: null, files: [] };
  try {
    return await inTransaction(async (db) => {
      const r = await loadInScope(db, { user }, numberParam, { forUpdate: true });
      if (!lifecycle.canComment(user, r)) {
        throw new HttpError(409, 'This ticket is closed — comments are no longer possible.', 'wrong_status');
      }
      if (internal && !lifecycle.canSeeInternal(user, r)) throw bad('You can\'t add internal notes here.', 'no_internal');

      const ev = await repo.insertEvent(db, {
        requestId: r.id,
        type: 'comment',
        actorId: user.id,
        note: text || null,
        internal,
      });
      written.requestId = r.id;
      written.files = await savePhotos(db, r, uploads, user.id, ev.id);

      // The requester answered "Waiting for you" → back to In progress (decision 5).
      const isRequesterSide = String(user.id) === String(r.requester_id) || String(user.id) === String(r.raised_by_id);
      if (r.status === 'WAITING_FOR_USER' && isRequesterSide && !internal) {
        await repo.updateStatus(db, r.id, { status: 'IN_PROGRESS' });
        await repo.insertEvent(db, {
          requestId: r.id,
          type: 'status',
          actorId: user.id,
          fromStatus: 'WAITING_FOR_USER',
          toStatus: 'IN_PROGRESS',
          data: { action: 'requester_replied' },
        });
      } else {
        await repo.touch(db, r.id);
      }
      return toDetail(db, user, await repo.getByNumber(db, r.number));
    });
  } catch (err) {
    if (written.files.length) await files.removeStored(written.requestId, written.files);
    throw err;
  }
}

// ---------- attachments ----------
async function getAttachmentFile(user, numberParam, attachmentId) {
  const r = await loadInScope(pool, { user }, numberParam);
  const a = await repo.getAttachment(pool, r.id, attachmentId);
  if (!a || (a.is_internal && !lifecycle.canSeeInternal(user, r))) throw notFound();
  return { path: files.filePath(r.id, a.stored_name), mimeType: a.mime_type };
}

async function eligibleEngineers(user, numberParam) {
  if (user.activeRole !== 'SUPER_ADMIN') throw notFound();
  const r = await loadInScope(pool, { user }, numberParam);
  return repo.eligibleEngineers(pool, r.service_unit_id);
}

module.exports = {
  getTicket,
  listMine,
  listCategories,
  createTicket,
  act,
  triage,
  comment,
  getAttachmentFile,
  eligibleEngineers,
  parseNumber,
  displayNumber,
};
