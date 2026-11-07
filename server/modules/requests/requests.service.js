// Tickets (Phase 6). Every change: one transaction, ticket row locked, scope + lifecycle checked,
// one timeline event written. Out of scope = 404 (assertRecordInScope).
// Phase 13: notifications are written in the same transaction and pushed after COMMIT.
const pool = require('../../db/pool');
const { config } = require('../../config/env');
const repo = require('./requests.repo');
const itemsRepo = require('./requestItems.repo');
const timeFrames = require('./timeFrames');
const lifecycle = require('./lifecycle');
const files = require('./attachments');
const notifications = require('../notifications/notifications.service');
const invoices = require('../invoices/invoices.service');
const assistant = require('../assistant/assistant.service');
const problems = require('../problems/problems.service');
const { locationLabel } = require('../sync/hrPlan');
const { assertRecordInScope, isRecordInScope, recordScopeSql } = require('../../middleware/scope');
const roles = require('../../utils/roles');
const { HttpError, notFound } = require('../../utils/httpError');

// High / Normal / Low for everyone (Urgent retired 28 Oct 2026). Each has a time frame (timeFrames.js).
const REQUESTER_PRIORITIES = new Set(['LOW', 'NORMAL', 'HIGH']); // "How urgent?"
const ALL_PRIORITIES = REQUESTER_PRIORITIES;

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

const DUE_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: config.timeZone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
});
const dueText = (d) => DUE_FMT.format(new Date(d));

// "T-1001" or "1001" → 1001
function parseNumber(value) {
  const m = /^(?:[TR]-)?(\d{1,9})$/i.exec(String(value || '').trim());
  return m ? m[1] : null;
}

async function loadInScope(db, req, numberParam, opts) {
  const number = parseNumber(numberParam);
  const record = number && (await repo.getByNumber(db, number, opts));
  if (!record) throw notFound();
  // Pool members (staff of the company) may open a ticket offered to them (Phase 2).
  if (record.pool_started_at && !isRecordInScope(req.user, record) && String(record.service_unit_id) === String(req.user?.companyId)) {
    if (await repo.isPoolMember(db, record.id, req.user.id)) return record;
  }
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
    // The category's occupation (Problem list): suggested for a pool.
    suggestedOccupationId: r.category_occupation_id ? String(r.category_occupation_id) : null,
    requester: r.requester,
    assignedEngineer: r.assigned_engineer || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // Time frame (24/7, from when it was raised) and when it was done (resolved / delivered, or rejected / closed).
    dueFrom: r.due_from ?? null,
    dueBy: r.due_by ?? null,
    doneAt: r.resolved_at || r.rejected_at || r.closed_at || null,
  };
}

async function toDetail(db, user, r) {
  const seeInternal = lifecycle.canSeeInternal(user, r);
  const [events, attachments, members] = await Promise.all([
    repo.listEvents(db, r.id),
    repo.listAttachments(db, r.id),
    r.pool_started_at ? repo.poolMembers(db, r.id) : [],
  ]);
  const inPool = members.some((m) => String(m.id) === String(user.id));
  const visibleAttachments = attachments.filter((a) => seeInternal || !a.is_internal);

  return {
    ...toSummary(r),
    description: r.description,
    location: r.location,
    categoryId: r.category_id ? String(r.category_id) : null,
    // From the problem list (step B): item and problem, or "Other" with the person's words.
    problem: r.ticket_item_id
      ? { itemId: String(r.ticket_item_id), item: r.item_name, problemId: r.ticket_problem_id ? String(r.ticket_problem_id) : null, problem: r.problem_name || null, text: r.problem_text || null }
      : null,
    raisedBy: r.raised_by,
    raisedForSomeoneElse: String(r.raised_by_id) !== String(r.requester_id),
    resolution: r.resolution,
    rejectionNote: r.rejection_note,
    assignedAt: r.assigned_at,
    resolvedAt: r.resolved_at,
    closedAt: r.closed_at,
    rejectedAt: r.rejected_at,
    // Pool (Phase 2): members are listed for whoever can assign; members see that it is offered to them.
    pool: r.pool_started_at
      ? { ...poolInfo(r.pool_started_at, members.length), members: lifecycle.canDo(user, r, 'assign') ? members : undefined, mine: inPool }
      : null,
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
    company: { code: r.service_unit_code, name: r.service_unit_name },
    permissions: {
      canLinkInvoices: seeInternal && (roles.isAdmin(user) || user.activeRole === 'ENGINEER'),
      canUnlinkInvoices: roles.isAdmin(user),
      actions: lifecycle.allowedActions(user, r),
      canComment: lifecycle.canComment(user, r),
      canAddInternalNote: seeInternal && lifecycle.canComment(user, r),
      canEditTriage: lifecycle.canEditTriage(user, r),
      canDecideItems: lifecycle.canDecideItems(user, r),
      canDeliverItems: lifecycle.canDeliverItems(user, r),
      canAddPhotos: lifecycle.canComment(user, r) && attachments.length < files.MAX_FILES_PER_TICKET,
      // Pool: send it / take it back (assigners, while nobody has it) · take it (members).
      canPool: !r.assigned_engineer_id && lifecycle.canDo(user, r, 'assign'),
      canTake: inPool && !r.assigned_engineer_id,
      // Super Admin: move to any status (Change status), all companies.
      canChangeStatus: user.activeRole === 'SUPER_ADMIN',
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
  if (!user.companyId) return { requests: [], total: 0 };
  const { rows, total } = await repo.listMine(pool, user.id, user.companyId, { open, limit, offset });
  return { requests: rows.map(toSummary), total };
}

// Ticket categories of the active company.
async function listCategories(user) {
  if (!user.companyId) return [];
  return (await repo.listCategories(pool, user.companyId)).map((c) => ({ id: String(c.id), name: c.name }));
}

// "Where?" prefill: the requester's department location (Phase 3.1). Only an Admin may ask
// for someone else (raise-for-someone); anyone else asking for another person gets 404.
async function defaultLocation(user, forUserId) {
  const target = forUserId ? String(forUserId) : String(user.id);
  if (target !== String(user.id) && !roles.isAdmin(user)) throw notFound();
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
// Step B (30 Oct 2026): the person may pick Category > Item > Problem from the company's list, or
// "Other" with their own words (problemText). Then the title fills itself in ("Door – Hinges") and
// the description is optional. With auto-assign on and an occupation linked to the category, the
// ticket goes straight to a staff member of that occupation (problems.pickAutoAssignee).
async function createTicket(user, input, uploads) {
  let title = clean(input.title);
  let description = clean(input.description);
  const problemText = clean(input.problemText) || null;
  const location = clean(input.location) || null;
  const isAdmin = roles.isAdmin(user);
  const priority = clean(input.priority).toUpperCase() || 'NORMAL';
  const fromList = Boolean(input.itemId);

  if (!fromList && (title.length < 3 || title.length > 120)) throw bad('Give the ticket a short title (3–120 characters).', 'bad_title');
  if (!fromList && (!description || description.length > 5000)) throw bad('Describe the problem (up to 5000 characters).', 'bad_description');
  if (description.length > 5000) throw bad('Keep the description under 5000 characters.', 'bad_description');
  if (problemText && problemText.length > 200) throw bad('Keep the problem under 200 characters.', 'bad_problem_text');
  if (location && location.length > 200) throw bad('Keep the location under 200 characters.', 'bad_location');
  if (!(isAdmin ? ALL_PRIORITIES : REQUESTER_PRIORITIES).has(priority)) throw bad('Choose how urgent it is.', 'bad_priority');

  // Files are written inside the transaction; if anything after that fails, delete them again.
  const written = { requestId: null, files: [] };
  let created;
  try {
    created = await inTransaction(async (db, afterCommit) => {
      // Raised in the active company (the session checked it is active).
      const serviceUnitId = user.companyId;
      if (!serviceUnitId) throw new HttpError(409, 'Choose a company first.', 'choose_company');

      const category = await repo.getCategory(db, input.categoryId);
      if (!category || !category.is_active || String(category.service_unit_id) !== String(serviceUnitId)) {
        throw bad('Choose a category.', 'bad_category');
      }

      // Item and problem from the list (they must belong to this category and be active).
      const choice = await problems.resolveChoice(db, serviceUnitId, category.id, { itemId: input.itemId, problemId: input.problemId });
      if (choice.item) {
        const what = choice.problem ? choice.problem.name : problemText;
        if (!title) title = `${choice.item.name}${what ? ` – ${what}` : ''}`.slice(0, 120);
        if (title.length < 3) title = `${category.name} – ${title}`.slice(0, 120);
        if (!description) description = [category.name, choice.item.name, what].filter(Boolean).join(' › ');
      }

      // Raise for someone else: Admin only (Decisions §9).
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
        itemId: choice.item?.id ?? null,
        problemId: choice.problem?.id ?? null,
        problemText: choice.problem ? null : problemText,
      });
      await repo.insertEvent(db, {
        requestId: row.id,
        type: 'created',
        actorId: user.id,
        toStatus: 'OPEN',
        data: requesterId !== String(user.id) ? { raisedFor: requesterId } : null,
      });
      written.requestId = row.id;
      const due = await timeFrames.setDue(db, row.id);
      written.files = await savePhotos(db, row, uploads, user.id, null);
      // Raised from the AI assistant: link the chat (only the requester's own open chat).
      if (input.assistantSessionId && String(requesterId) === String(user.id)) {
        await assistant.linkTicket(db, user, input.assistantSessionId, row.id, serviceUnitId);
      }

      // Auto-assign (company switch on + an occupation linked to the category).
      const staff = await problems.pickAutoAssignee(db, serviceUnitId, category.id);
      const ticket = {
        ...row, type: 'TICKET', status: 'OPEN', title, requester_id: requesterId, raised_by_id: user.id,
        assigned_engineer_id: null, due_by: due?.due_by, service_unit_name: user.company?.name,
      };
      let sent = await notifications.recordTicketEvent(db, ticket, {
        kind: 'created',
        actorId: user.id,
        raisedFor: requesterId !== String(user.id),
        autoAssignedTo: staff ? `${staff.occupation}: ${staff.name}` : null,
      });
      if (staff) {
        await repo.assignEngineer(db, row.id, staff.id, 'ASSIGNED');
        await repo.insertEvent(db, {
          requestId: row.id,
          type: 'assigned',
          actorId: null,
          fromStatus: 'OPEN',
          toStatus: 'ASSIGNED',
          data: { engineerId: staff.id, engineerName: staff.name, occupation: staff.occupation, auto: true },
        });
        const assign = { kind: 'assign', actorId: null, engineerId: staff.id, engineerName: staff.name, occupation: staff.occupation };
        sent = [...sent, ...(await notifications.recordTicketEvent(db, { ...ticket, status: 'ASSIGNED' }, assign))];
        afterCommit(() => notifications.publish(sent, ticket, [staff.id]));
      } else {
        afterCommit(() => notifications.publish(sent, ticket));
      }
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

    // A direct assignment, rejection or close ends any pool.
    if (['assign', 'reject', 'close'].includes(action)) await repo.clearPool(db, r.id);
    if (action === 'assign') {
      const engineerId = clean(body.engineerId);
      const engineer = await repo.eligibleEngineer(db, engineerId, r.service_unit_id);
      if (!engineer) throw bad('Choose an active staff member of this company.', 'bad_engineer');
      if (String(r.assigned_engineer_id) === engineerId) throw bad('Already assigned to this engineer.', 'no_change');
      if (engineer.on_leave_until) throw onLeave(engineer);
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
          occupation: engineer.occupation,
          previousEngineerId: r.assigned_engineer_id ? String(r.assigned_engineer_id) : null,
          previousEngineerName: r.assigned_engineer?.name || null,
        },
      });
      event = {
        ...event,
        engineerId,
        engineerName: engineer.name,
        occupation: engineer.occupation,
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

// ---------- Pool assignment (Phase 2, decided 6 Nov 2026) ----------
// The Admin (or someone given Assign queue / All tickets / Approvals) sends an unassigned ticket or request
// to a pool: whole occupations (e.g. all Engineers, all Help desk), chosen people, or everyone available.
// The pool is fixed when it is sent. Staff on leave are never in it. Everyone in it is told; the first to
// "Take it" gets it; nobody can decline. After POOL_HOURS with no taker it goes to the member with the
// fewest ongoing tickets (jobs.js → expirePools).
const POOL_HOURS = 12;

// Assign to one person inside an open transaction (direct, taken from the pool, or automatic).
async function assignInTx(db, r, engineer, { actorId, note = null, via = null }) {
  const to = lifecycle.nextStatus('assign', r.status);
  await repo.assignEngineer(db, r.id, engineer.id, to);
  const data = {
    engineerId: engineer.id,
    engineerName: engineer.name,
    occupation: engineer.occupation,
    previousEngineerId: r.assigned_engineer_id ? String(r.assigned_engineer_id) : null,
    previousEngineerName: r.assigned_engineer?.name || null,
  };
  if (via) data.via = via; // 'pool' (taken) | 'pool_auto' (nobody took it in time)
  await repo.insertEvent(db, { requestId: r.id, type: 'assigned', actorId, fromStatus: r.status, toStatus: to, note, data });
  return { kind: 'assign', actorId, note, engineerId: engineer.id, engineerName: engineer.name, occupation: engineer.occupation, previousEngineerId: data.previousEngineerId, via };
}

async function sendToPool(user, numberParam, body = {}) {
  const note = clean(body.note);
  if (note.length > 1000) throw bad('Keep the note under 1000 characters.', 'note_too_long');
  const ids = (list) => (Array.isArray(list) ? [...new Set(list.map(String))] : []);
  const occupationIds = ids(body.occupationIds);
  const engineerIds = ids(body.engineerIds);
  const everyone = body.all === true;
  if ([...occupationIds, ...engineerIds].some((x) => !/^\d{1,18}$/.test(x))) throw bad('Choose from the list.', 'bad_choice');
  return inTransaction(async (db, afterCommit) => {
    const r = await loadInScope(db, { user }, numberParam, { forUpdate: true });
    lifecycle.assertAllowed(user, r, 'assign');
    if (r.assigned_engineer_id) throw new HttpError(409, `Already with ${r.assigned_engineer?.name || 'someone'} — reassign it directly instead.`, 'already_assigned');
    const staff = await repo.eligibleEngineers(db, r.service_unit_id);
    const byId = new Map(staff.map((e) => [e.id, e]));
    const unknown = engineerIds.find((x) => !byId.has(x));
    if (unknown) throw bad('Choose active staff of this company.', 'bad_engineer');
    const onLeaveChosen = engineerIds.map((x) => byId.get(x)).find((e) => e.on_leave_until);
    if (onLeaveChosen) throw onLeave(onLeaveChosen);
    const members = staff.filter(
      (e) => !e.on_leave_until && (everyone || occupationIds.includes(String(e.occupation_id)) || engineerIds.includes(e.id))
    );
    if (!everyone && !occupationIds.length && engineerIds.length < 2) throw bad('Choose an occupation, everyone, or at least two people — or assign to one person directly.', 'pool_too_small');
    if (!members.length) throw new HttpError(409, 'Nobody available in that choice — everyone there is on leave.', 'pool_empty');
    await repo.setPool(db, r.id, members.map((m) => m.id), user.id);
    const occNames = [...new Set(staff.filter((e) => occupationIds.includes(String(e.occupation_id))).map((e) => e.occupation))];
    await repo.insertEvent(db, {
      requestId: r.id,
      type: 'status',
      actorId: user.id,
      fromStatus: r.status,
      toStatus: r.status,
      note: note || null,
      data: { action: 'pool', everyone, occupations: occNames, memberIds: members.map((m) => m.id), memberNames: members.map((m) => m.name), hours: POOL_HOURS },
    });
    const event = { kind: 'pooled', actorId: user.id, memberIds: members.map((m) => m.id), note };
    const sent = await notifications.recordTicketEvent(db, r, event);
    afterCommit(() => notifications.publish(sent, r, event.memberIds));
    return toDetail(db, user, await repo.getByNumber(db, r.number));
  });
}

// A pool member takes it: it is theirs; the pool ends.
async function takeFromPool(user, numberParam) {
  return inTransaction(async (db, afterCommit) => {
    const number = parseNumber(numberParam);
    const r = number && (await repo.getByNumber(db, number, { forUpdate: true }));
    if (!r || String(r.service_unit_id) !== String(user.companyId)) throw notFound();
    const member = await repo.isPoolMember(db, r.id, user.id);
    if (!member) {
      if (r.assigned_engineer_id) throw new HttpError(409, `${r.assigned_engineer?.name || 'Someone'} has already taken it.`, 'taken');
      throw notFound();
    }
    if (r.assigned_engineer_id) throw new HttpError(409, `${r.assigned_engineer?.name || 'Someone'} has already taken it.`, 'taken');
    const engineer = await repo.eligibleEngineer(db, user.id, r.service_unit_id);
    if (!engineer) throw notFound();
    if (engineer.on_leave_until) throw onLeave(engineer);
    const others = (await repo.poolMembers(db, r.id)).map((m) => m.id);
    await repo.clearPool(db, r.id);
    const event = await assignInTx(db, r, engineer, { actorId: user.id, via: 'pool' });
    const sent = await notifications.recordTicketEvent(db, r, event);
    afterCommit(() => notifications.publish(sent, r, [engineer.id, ...others]));
    return toDetail(db, user, await repo.getByNumber(db, r.number));
  });
}

// The Admin takes it back out of the pool (back to the Assign queue).
async function cancelPool(user, numberParam) {
  return inTransaction(async (db, afterCommit) => {
    const r = await loadInScope(db, { user }, numberParam, { forUpdate: true });
    lifecycle.assertAllowed(user, r, 'assign');
    const others = (await repo.poolMembers(db, r.id)).map((m) => m.id);
    if (!(await repo.clearPool(db, r.id))) throw new HttpError(409, 'It is not in a pool.', 'no_pool');
    await repo.insertEvent(db, { requestId: r.id, type: 'status', actorId: user.id, fromStatus: r.status, toStatus: r.status, note: null, data: { action: 'pool_cancel' } });
    afterCommit(() => notifications.publish([], r, others));
    return toDetail(db, user, await repo.getByNumber(db, r.number));
  });
}

// Scheduled (jobs.js): pools nobody took within POOL_HOURS → the member with the fewest ongoing tickets
// (on leave skipped; ties: the one who got work longest ago). If every member is now on leave or gone,
// the pool ends and the Admins are told. → number of tickets handled.
async function expirePools() {
  const { rows } = await pool.query(
    `SELECT number FROM requests WHERE pool_started_at IS NOT NULL AND pool_started_at <= now() - make_interval(hours => $1::int)
      ORDER BY pool_started_at LIMIT 200`,
    [POOL_HOURS]
  );
  let n = 0;
  for (const { number } of rows) {
    // eslint-disable-next-line no-await-in-loop
    const done = await inTransaction(async (db, afterCommit) => {
      const r = await repo.getByNumber(db, number, { forUpdate: true });
      if (!r || !r.pool_started_at || Date.now() - new Date(r.pool_started_at).getTime() < POOL_HOURS * 3600000) return false;
      const memberIds = (await repo.poolMembers(db, r.id)).map((m) => m.id);
      const { rows: pick } = await db.query(
        `SELECT e.id::text AS id FROM unnest($1::bigint[]) AS e(id)
          ORDER BY (SELECT count(*) FROM requests w WHERE w.assigned_engineer_id = e.id
                      AND w.status IN ('ASSIGNED','IN_PROGRESS','WAITING_FOR_USER','WAITING_FOR_EQUIPMENT')),
                   (SELECT max(w.assigned_at) FROM requests w WHERE w.assigned_engineer_id = e.id) NULLS FIRST, e.id`,
        [memberIds]
      );
      let engineer = null;
      for (const p of pick) {
        // eslint-disable-next-line no-await-in-loop
        const e = await repo.eligibleEngineer(db, p.id, r.service_unit_id);
        if (e && !e.on_leave_until) {
          engineer = e;
          break;
        }
      }
      await repo.clearPool(db, r.id);
      if (r.assigned_engineer_id || !lifecycle.ACTIONS.assign.from.has(r.status)) return true; // already handled
      if (!engineer) {
        await repo.insertEvent(db, { requestId: r.id, type: 'status', actorId: null, fromStatus: r.status, toStatus: r.status, note: null, data: { action: 'pool_empty' } });
        const sent = await notifications.recordTicketEvent(db, r, { kind: 'pool_empty', actorId: null });
        afterCommit(() => notifications.publish(sent, r, memberIds));
        return true;
      }
      const event = await assignInTx(db, r, engineer, {
        actorId: null,
        note: `Nobody took it within ${POOL_HOURS} hours — given to the person in the pool with the fewest ongoing tickets.`,
        via: 'pool_auto',
      });
      const sent = await notifications.recordTicketEvent(db, r, event);
      afterCommit(() => notifications.publish(sent, r, [engineer.id, ...memberIds]));
      return true;
    });
    if (done) n += 1;
  }
  return n;
}

// Pool members: tickets waiting for someone to take them.
async function listPoolQueue(user, { limit, offset }) {
  if (!user?.companyId) throw notFound();
  const scope = {
    clause: 'r.service_unit_id = $1::bigint AND EXISTS (SELECT 1 FROM request_pool p WHERE p.request_id = r.id AND p.user_id = $2::bigint)',
    params: [user.companyId, user.id],
  };
  const { rows, total } = await repo.listRequests(pool, scope, { sort: 'priority', limit, offset });
  return { requests: rows.map(toQueueItem), total };
}

// Staff on approved leave today can't be given work (Staff leave, 6 Nov 2026).
const onLeave = (e) => {
  const until = new Date(`${e.on_leave_until}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return new HttpError(409, `${e.name} is on leave till ${until}.`, 'on_leave');
};

// Super Admin only (decided 6 Nov 2026): move a ticket or request to any status — e.g. Closed → In
// progress — with a reason. Overrides "no reopening" for the Super Admin alone. Statuses that need someone
// working on it keep the current engineer or take the one chosen; Open / Waiting for approval clear it.
// Moving back clears the resolved / closed / rejected times that no longer apply. Logged and notified.
const STATUS_KEYS = Object.keys(require('../../../shared/statuses.json').requestStatuses);
const NEEDS_ENGINEER = new Set(['ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_EQUIPMENT', 'RESOLVED']);

async function overrideStatus(user, numberParam, body = {}) {
  if (user?.activeRole !== 'SUPER_ADMIN') throw notFound();
  const to = clean(body.status).toUpperCase();
  const note = clean(body.note);
  if (!STATUS_KEYS.includes(to)) throw bad('Choose a status.', 'bad_status');
  if (note.length < 3) throw bad('Say why the status is being changed.', 'note_required');
  if (note.length > 2000) throw bad('Keep the reason under 2000 characters.', 'note_too_long');
  return inTransaction(async (db, afterCommit) => {
    const r = await loadInScope(db, { user }, numberParam, { forUpdate: true });
    if (to === r.status) throw bad('It already has this status.', 'no_change');
    if (to === 'PENDING_APPROVAL' && r.type !== 'SERVICE_REQUEST') throw bad('Only service requests wait for approval.', 'bad_status');
    let engineerId = r.assigned_engineer_id ? String(r.assigned_engineer_id) : null;
    let engineer = null;
    const chosen = clean(body.engineerId);
    if (to === 'OPEN' || to === 'PENDING_APPROVAL') engineerId = null;
    else if (chosen && chosen !== engineerId) {
      engineer = await repo.eligibleEngineer(db, chosen, r.service_unit_id);
      if (!engineer) throw bad('Choose an active staff member of this company.', 'bad_engineer');
      if (engineer.on_leave_until) throw onLeave(engineer);
      engineerId = chosen;
    }
    if (NEEDS_ENGINEER.has(to) && !engineerId) throw bad('Choose who works on it.', 'engineer_required');
    await repo.clearPool(db, r.id);
    await db.query(
      `UPDATE requests SET status = $2::request_status,
              assigned_engineer_id = $3::bigint,
              assigned_at = CASE WHEN $3::bigint IS NULL THEN NULL WHEN assigned_engineer_id IS DISTINCT FROM $3::bigint THEN now() ELSE assigned_at END,
              resolved_at = CASE WHEN $2::request_status IN ('RESOLVED', 'CLOSED') THEN COALESCE(resolved_at, now()) ELSE NULL END,
              closed_at   = CASE WHEN $2::request_status = 'CLOSED' THEN now() ELSE NULL END,
              rejected_at = CASE WHEN $2::request_status = 'REJECTED' THEN now() ELSE NULL END,
              rejection_note = CASE WHEN $2::request_status = 'REJECTED' THEN $4::text ELSE rejection_note END,
              updated_at = now()
        WHERE id = $1::bigint`,
      [r.id, to, engineerId, note]
    );
    await repo.insertEvent(db, {
      requestId: r.id,
      type: 'status',
      actorId: user.id,
      fromStatus: r.status,
      toStatus: to,
      note,
      data: { action: 'override', engineerId, engineerName: engineer?.name || null },
    });
    const event = { kind: 'status_override', actorId: user.id, note, from: r.status, to };
    const sent = await notifications.recordTicketEvent(db, { ...r, status: to, assigned_engineer_id: engineerId }, event);
    afterCommit(() => notifications.publish(sent, r, engineerId ? [engineerId] : []));
    const fresh = await repo.getByNumber(db, r.number);
    return toDetail(db, user, fresh);
  });
}

// Super Admin triage: priority / category.
// Super Admin: priority (with an optional message to the requester and engineer — in-app + email;
// the time frame is recalculated from when it was raised) and category.
async function triage(user, numberParam, { priority, categoryId, message }) {
  const note = clean(message);
  if (note.length > 1000) throw bad('Keep the message under 1000 characters.', 'message_too_long');
  return inTransaction(async (db, afterCommit) => {
    const r = await loadInScope(db, { user }, numberParam, { forUpdate: true });
    afterCommit(() => notifications.publish([], r)); // no one is notified; open lists refresh
    if (!lifecycle.canEditTriage(user, r)) {
      if (roles.isAdmin(user)) throw new HttpError(409, 'This ticket is closed.', 'wrong_status');
      throw notFound();
    }
    if (priority !== undefined) {
      const p = clean(priority).toUpperCase();
      if (!ALL_PRIORITIES.has(p)) throw bad('Choose a priority.', 'bad_priority');
      if (p !== r.priority) {
        await repo.setPriority(db, r.id, p);
        const due = await timeFrames.setDue(db, r.id);
        await repo.insertEvent(db, { requestId: r.id, type: 'priority', actorId: user.id, note: note || null, data: { from: r.priority, to: p } });
        const event = { kind: 'priority', actorId: user.id, from: r.priority, to: p, message: note, dueText: due?.due_by ? dueText(due.due_by) : null };
        const sent = await notifications.recordTicketEvent(db, { ...r, priority: p, due_by: due?.due_by }, event);
        afterCommit(() => notifications.publish(sent, r));
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

const poolInfo = (startedAt, size) =>
  startedAt ? { startedAt, size: size ?? null, autoAssignAt: new Date(new Date(startedAt).getTime() + POOL_HOURS * 3600000).toISOString() } : null;

function toQueueItem(r) {
  return { ...toSummary(r), location: r.location || null, statusSince: r.status_since, pool: poolInfo(r.pool_started_at, r.pool_size) };
}

const requireStaffOrAdmin = (user) => {
  if (!roles.isAdmin(user) && !roles.isStaff(user)) throw notFound();
};
const requireAdmin = (user) => {
  if (!roles.isAdmin(user)) throw notFound();
};

// Staff (or an Admin who is assigned work): tickets assigned to ME, in this company.
async function listWorkQueue(user, { group = 'active', limit, offset }) {
  requireStaffOrAdmin(user);
  if (!WORK_GROUPS.includes(group)) throw bad('Unknown queue.', 'bad_group');
  const scope = recordScopeSql(user, 'r', 1);
  const { rows, total } = await repo.listRequests(pool, scope, {
    // "Resolved" keeps what they resolved after the Admin closes it (7 Nov 2026): resolved + closed.
    statuses: group === 'resolved' ? ['RESOLVED', 'CLOSED'] : STATUS_GROUPS[group],
    assignedTo: user.id,
    sort: group === 'resolved' ? 'updated' : 'priority',
    limit,
    offset,
  });
  return { requests: rows.map(toQueueItem), total };
}

// Admin: waiting for staff (high first, then oldest) / resolved, waiting to be closed.
async function listAssignQueue(user, { view = 'unassigned', limit, offset }) {
  requireAdmin(user);
  if (!['unassigned', 'to_close'].includes(view)) throw bad('Unknown queue.', 'bad_group');
  const { rows, total } = await repo.listRequests(pool, recordScopeSql(user, 'r', 1), {
    statuses: view === 'unassigned' ? ['OPEN'] : ['RESOLVED'],
    sort: view === 'unassigned' ? 'priority' : 'oldest',
    limit,
    offset,
  });
  return { requests: rows.map(toQueueItem), total };
}

// Admin: everything in the company, with filters.
async function listAll(user, f) {
  requireAdmin(user);
  if (f.status && !(f.status in STATUS_GROUPS)) throw bad('Unknown status filter.', 'bad_group');
  if (f.priority && !ALL_PRIORITIES.has(f.priority)) throw bad('Unknown priority.', 'bad_priority');
  if (f.categoryId && !/^\d{1,18}$/.test(f.categoryId)) throw bad('Unknown category.', 'bad_category');
  if (f.engineerId && f.engineerId !== 'none' && !/^\d{1,18}$/.test(f.engineerId)) throw bad('Unknown engineer.', 'bad_engineer');
  if (f.sort && !['updated', 'priority', 'oldest', 'due'].includes(f.sort)) throw bad('Unknown sort.', 'bad_sort');
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
  if (!roles.isAdmin(user) && !roles.isStaff(user)) return {};
  const c = await repo.queueCounts(pool, user.id, user.companyId);
  // Tickets offered to me in a pool count on My work queue too (Phase 2).
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM request_pool p JOIN requests r ON r.id = p.request_id
      WHERE p.user_id = $1::bigint AND r.service_unit_id = $2::bigint AND r.assigned_engineer_id IS NULL`,
    [user.id, user.companyId]
  );
  const work = c.work + rows[0].n;
  return roles.isAdmin(user)
    ? { workQueue: work, assignQueue: c.unassigned, toClose: c.to_close, approvals: c.approvals }
    : { workQueue: work };
}

const toStaff = (e) => ({
  id: e.id,
  name: e.name,
  occupation: e.occupation,
  occupationId: e.occupation_id,
  open_work: e.open_work,
  onLeaveUntil: e.on_leave_until || null, // approved leave today (Staff leave): can't be assigned
});

// Admin: staff who can take this company's tickets (for quick-assign in the queue).
async function listEngineers(user) {
  requireAdmin(user);
  return (await repo.eligibleEngineers(pool, user.companyId)).map(toStaff);
}

async function eligibleEngineers(user, numberParam) {
  if (!roles.isAdmin(user)) throw notFound();
  const r = await loadInScope(pool, { user }, numberParam);
  return (await repo.eligibleEngineers(pool, r.service_unit_id)).map(toStaff);
}

module.exports = {
  inTransaction,
  overrideStatus,
  sendToPool,
  takeFromPool,
  cancelPool,
  expirePools,
  listPoolQueue,
  POOL_HOURS,
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
