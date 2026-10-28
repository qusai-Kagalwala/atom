// Tickets (Phase 6). Every change: one transaction, ticket row locked, scope + lifecycle checked,
// one timeline event written. Out of scope = 404 (assertRecordInScope).
// Phase 13: notifications are written in the same transaction and pushed after COMMIT.
const pool = require('../../db/pool');
const repo = require('./requests.repo');
const itemsRepo = require('./requestItems.repo');
const lifecycle = require('./lifecycle');
const files = require('./attachments');
const notifications = require('../notifications/notifications.service');
const invoices = require('../invoices/invoices.service');
const assistant = require('../assistant/assistant.service');
const { locationLabel } = require('../sync/hrPlan');
const { assertRecordInScope, recordScopeSql } = require('../../middleware/scope');
const { HttpError, notFound } = require('../../utils/httpError');

const REQUESTER_PRIORITIES = new Set(['LOW', 'NORMAL', 'URGENT']); // "How urgent?"
const ALL_PRIORITIES = new Set(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

const bad = (message, code) => new HttpError(400, message, code);
const displayNumber = (r) => `${r.type === 'SERVICE_REQUEST' ? 'R' : 'T'}-${r.number}`;
const clean = (v) => (v == null ? '' : String(v).trim());

// fn(db, afterCommit): afterCommit(cb) queues cb to run only once the COMMIT has succeeded
// (live pushes must never announce a change that was rolled back).
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
    // Invoices: Super Admins and the assigned engineer only (requesters never see them).
    invoices: seeInternal ? await invoices.forRequest(db, r.id) : undefined,
    // Service requests (Phase 9): the items and their decisions / deliveries.
    items: r.type === 'SERVICE_REQUEST' ? (await itemsRepo.listItems(db, r.id)).map(itemsRepo.toItem) : undefined,
    // What happened in the AI assistant before this ticket (Phase 12).
    assistant: await assistant.forRequest(db, r.id),
    permissions: {
      canLinkInvoices: seeInternal && (user.activeRole === 'SUPER_ADMIN' || user.activeRole === 'ENGINEER'),
      canUnlinkInvoices: user.activeRole === 'SUPER_ADMIN',
      actions: lifecycle.allowedActions(user, r),
      canComment: lifecycle.canComment(user, r),
      canAddInternalNote: seeInternal && lifecycle.canComment(user, r),
      canEditTriage: lifecycle.canEditTriage(user, r),
      canDecideItems: lifecycle.canDecideItems(user, r),
      canDeliverItems: lifecycle.canDeliverItems(user, r),
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

// "Where?" prefill: the requester's department location (Phase 3.1). Only a Super Admin may ask
// for someone else (raise-for-someone); anyone else asking for another person gets 404.
async function defaultLocation(user, forUserId) {
  const target = forUserId ? String(forUserId) : String(user.id);
  if (target !== String(user.id) && user.activeRole !== 'SUPER_ADMIN') throw notFound();
  const d = await repo.departmentLocation(pool, target);
  return { location: d ? locationLabel({ building: d.building, floor: d.floor, roomNo: d.room_no }) : null };
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
    created = await inTransaction(async (db, afterCommit) => {
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
      // Raised from the AI assistant: link the chat (only the requester's own open chat).
      if (input.assistantSessionId && String(requesterId) === String(user.id)) {
        await assistant.linkTicket(db, user, input.assistantSessionId, row.id);
      }

      const ticket = { ...row, type: 'TICKET', title, requester_id: requesterId, raised_by_id: user.id, assigned_engineer_id: null };
      const sent = await notifications.recordTicketEvent(db, ticket, {
        kind: 'created',
        actorId: user.id,
        raisedFor: requesterId !== String(user.id),
      });
      afterCommit(() => notifications.publish(sent, ticket));
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
  return inTransaction(async (db, afterCommit) => {
    const r = await loadInScope(db, { user }, numberParam, { forUpdate: true });
    const rule = lifecycle.assertAllowed(user, r, action);
    let event = { kind: action, actorId: user.id, note };
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
      event = {
        ...event,
        engineerId,
        engineerName: engineer.name,
        previousEngineerId: r.assigned_engineer_id ? String(r.assigned_engineer_id) : null,
      };
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
    const sent = await notifications.recordTicketEvent(db, r, event);
    afterCommit(() => notifications.publish(sent, r, event.engineerId ? [event.engineerId] : []));
    const fresh = await repo.getByNumber(db, r.number);
    return toDetail(db, user, fresh);
  });
}

// Super Admin triage: priority / category.
async function triage(user, numberParam, { priority, categoryId }) {
  return inTransaction(async (db, afterCommit) => {
    const r = await loadInScope(db, { user }, numberParam, { forUpdate: true });
    afterCommit(() => notifications.publish([], r)); // no one is notified; open lists refresh
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
    return await inTransaction(async (db, afterCommit) => {
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
      const requesterReplied = r.status === 'WAITING_FOR_USER' && isRequesterSide && !internal;
      if (requesterReplied) {
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
      const sent = await notifications.recordTicketEvent(db, r, {
        kind: 'comment',
        actorId: user.id,
        note: text,
        internal,
        hasPhotos: written.files.length > 0,
        requesterReplied,
      });
      afterCommit(() => notifications.publish(sent, r));
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

// ---------- queues & "All tickets" (Phase 7) ----------
const STATUS_GROUPS = {
  approval: ['PENDING_APPROVAL'],
  open: ['PENDING_APPROVAL', 'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_EQUIPMENT', 'RESOLVED'],
  unassigned: ['OPEN'],
  active: ['ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_EQUIPMENT'],
  to_start: ['ASSIGNED'],
  in_progress: ['IN_PROGRESS'],
  waiting: ['WAITING_FOR_USER', 'WAITING_FOR_EQUIPMENT'],
  resolved: ['RESOLVED'],
  closed: ['CLOSED'],
  rejected: ['REJECTED'],
  all: null,
};

const WORK_GROUPS = ['active', 'to_start', 'in_progress', 'waiting', 'resolved'];

function toQueueItem(r) {
  return { ...toSummary(r), location: r.location || null, statusSince: r.status_since };
}

const requireRoles = (user, roles) => {
  if (!roles.includes(user.activeRole)) throw notFound();
};

// Engineer (or a Super Admin who is assigned work): tickets assigned to ME.
async function listWorkQueue(user, { group = 'active', limit, offset }) {
  requireRoles(user, ['ENGINEER', 'SUPER_ADMIN']);
  if (!WORK_GROUPS.includes(group)) throw bad('Unknown queue.', 'bad_group');
  const scope = recordScopeSql(user, 'r', 1);
  const { rows, total } = await repo.listRequests(pool, scope, {
    statuses: STATUS_GROUPS[group],
    assignedTo: user.id,
    sort: group === 'resolved' ? 'updated' : 'priority',
    limit,
    offset,
  });
  return { requests: rows.map(toQueueItem), total };
}

// Super Admin: waiting for an engineer (urgent first, then oldest) / resolved, waiting to be closed.
async function listAssignQueue(user, { view = 'unassigned', limit, offset }) {
  requireRoles(user, ['SUPER_ADMIN']);
  if (!['unassigned', 'to_close'].includes(view)) throw bad('Unknown queue.', 'bad_group');
  const { rows, total } = await repo.listRequests(pool, recordScopeSql(user, 'r', 1), {
    statuses: view === 'unassigned' ? ['OPEN'] : ['RESOLVED'],
    sort: view === 'unassigned' ? 'priority' : 'oldest',
    limit,
    offset,
  });
  return { requests: rows.map(toQueueItem), total };
}

// Super Admin: everything, with filters.
async function listAll(user, f) {
  requireRoles(user, ['SUPER_ADMIN']);
  if (f.status && !(f.status in STATUS_GROUPS)) throw bad('Unknown status filter.', 'bad_group');
  if (f.priority && !ALL_PRIORITIES.has(f.priority)) throw bad('Unknown priority.', 'bad_priority');
  if (f.categoryId && !/^\d{1,18}$/.test(f.categoryId)) throw bad('Unknown category.', 'bad_category');
  if (f.engineerId && f.engineerId !== 'none' && !/^\d{1,18}$/.test(f.engineerId)) throw bad('Unknown engineer.', 'bad_engineer');
  if (f.sort && !['updated', 'priority', 'oldest'].includes(f.sort)) throw bad('Unknown sort.', 'bad_sort');
  if (f.type && !['TICKET', 'SERVICE_REQUEST'].includes(f.type)) throw bad('Unknown type.', 'bad_type');

  const { rows, total } = await repo.listRequests(pool, recordScopeSql(user, 'r', 1), {
    statuses: STATUS_GROUPS[f.status || 'open'],
    priority: f.priority || null,
    categoryId: f.categoryId || null,
    engineerId: f.engineerId || null,
    type: f.type || null,
    q: f.q ? String(f.q).trim().slice(0, 100) : null,
    sort: f.sort || 'updated',
    limit: f.limit,
    offset: f.offset,
  });
  return { requests: rows.map(toQueueItem), total };
}

// Sidebar badges: only the numbers this role can act on.
async function queueCounts(user) {
  if (!['ENGINEER', 'SUPER_ADMIN'].includes(user.activeRole)) return {};
  const c = await repo.queueCounts(pool, user.id);
  return user.activeRole === 'SUPER_ADMIN'
    ? { workQueue: c.work, assignQueue: c.unassigned, toClose: c.to_close, approvals: c.approvals }
    : { workQueue: c.work };
}

// Super Admin: engineers who can take AVIT tickets (for quick-assign in the queue).
async function listEngineers(user) {
  requireRoles(user, ['SUPER_ADMIN']);
  const unitId = await repo.defaultServiceUnitId(pool);
  return unitId ? repo.eligibleEngineers(pool, unitId) : [];
}

async function eligibleEngineers(user, numberParam) {
  if (user.activeRole !== 'SUPER_ADMIN') throw notFound();
  const r = await loadInScope(pool, { user }, numberParam);
  return repo.eligibleEngineers(pool, r.service_unit_id);
}

module.exports = {
  inTransaction,
  loadInScope,
  toDetail,
  ALL_PRIORITIES,
  REQUESTER_PRIORITIES,
  getTicket,
  listMine,
  listCategories,
  createTicket,
  act,
  triage,
  comment,
  getAttachmentFile,
  defaultLocation,
  eligibleEngineers,
  listWorkQueue,
  listAssignQueue,
  listAll,
  queueCounts,
  listEngineers,
  parseNumber,
  displayNumber,
};
