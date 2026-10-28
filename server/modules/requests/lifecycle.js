// Ticket lifecycle — the single place that decides who may do what (ATOM_Decisions.md §9).
// Pure: no database. The service calls allowedActions() / assertAllowed() with the locked row.
//
//   OPEN → ASSIGNED → IN_PROGRESS ⇄ WAITING_FOR_USER / WAITING_FOR_EQUIPMENT → RESOLVED → CLOSED
//   REJECTED from any non-final stage (note required). CLOSED and REJECTED are final — no reopening.
//
//   Service requests (Phase 9) start at PENDING_APPROVAL: the Admin approves / rejects each
//   item (any approved → OPEN, all rejected → REJECTED). They are not "resolved" by hand: the
//   request becomes RESOLVED ("Delivered") when the last approved item is delivered.
//
//   Admin of the company (or the Super Admin inside it): everything.
//   Staff (Engineer role) assigned to the ticket: start, wait, resume, resolve.
//   Everyone in scope: comment (until final). Only the Admin assigns, closes, rejects,
//   and changes priority / category. (Scope — same company — is checked before this.)
const { HttpError } = require('../../utils/httpError');
const roles = require('../../utils/roles');

const FINAL = new Set(['CLOSED', 'REJECTED']);
const WORKING = new Set(['IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_EQUIPMENT']);
const ASSIGNABLE = new Set(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_EQUIPMENT']);

// action → { to: next status (null = unchanged), from: allowed current statuses, who: 'admin' | 'worker' }
//   'worker' = Admin, or the assigned staff member acting as Staff.
const ACTIONS = {
  assign: { to: null, from: ASSIGNABLE, who: 'admin' }, // OPEN → ASSIGNED; otherwise reassign, status kept
  start: { to: 'IN_PROGRESS', from: new Set(['ASSIGNED']), who: 'worker' },
  wait_user: { to: 'WAITING_FOR_USER', from: new Set(['IN_PROGRESS', 'WAITING_FOR_EQUIPMENT']), who: 'worker' },
  wait_equipment: { to: 'WAITING_FOR_EQUIPMENT', from: new Set(['IN_PROGRESS', 'WAITING_FOR_USER']), who: 'worker' },
  resume: { to: 'IN_PROGRESS', from: new Set(['WAITING_FOR_USER', 'WAITING_FOR_EQUIPMENT']), who: 'worker' },
  resolve: { to: 'RESOLVED', from: WORKING, who: 'worker', noteRequired: 'Describe the fix.' },
  close: { to: 'CLOSED', from: new Set(['RESOLVED']), who: 'admin' },
  reject: { to: 'REJECTED', from: new Set(['PENDING_APPROVAL', ...ASSIGNABLE, 'RESOLVED']), who: 'admin', noteRequired: 'Enter a rejection note.' },
};

const ACTION_KEYS = Object.keys(ACTIONS);

const same = (a, b) => a != null && b != null && String(a) === String(b);
const isAdmin = (user) => roles.isAdmin(user);
const isAssignedEngineer = (user, req) => user?.activeRole === 'ENGINEER' && same(req.assigned_engineer_id, user.id);

function canDo(user, req, action) {
  const rule = ACTIONS[action];
  if (!rule || !rule.from.has(req.status)) return false;
  if (action === 'resolve' && req.type === 'SERVICE_REQUEST') return false; // delivered item by item
  if (isAdmin(user)) return true;
  return rule.who === 'worker' && isAssignedEngineer(user, req);
}

function allowedActions(user, req) {
  return ACTION_KEYS.filter((a) => canDo(user, req, a));
}

const canComment = (user, req) => !FINAL.has(req.status) && Boolean(user);
const canSeeInternal = (user, req) => isAdmin(user) || isAssignedEngineer(user, req);
const canEditTriage = (user, req) => isAdmin(user) && !FINAL.has(req.status); // priority / category
// Service requests: decide items (Admin, while waiting for approval) · deliver approved items.
const canDecideItems = (user, req) => req.type === 'SERVICE_REQUEST' && isAdmin(user) && req.status === 'PENDING_APPROVAL';
const canDeliverItems = (user, req) =>
  req.type === 'SERVICE_REQUEST' && WORKING.has(req.status) && (isAdmin(user) || isAssignedEngineer(user, req));

// Throws 409 for a wrong stage (the ticket moved on), 404 when the role can't act at all.
function assertAllowed(user, req, action) {
  const rule = ACTIONS[action];
  if (!rule) throw new HttpError(400, 'Unknown action.', 'bad_action');
  if (canDo(user, req, action)) return rule;
  if (action === 'resolve' && req.type === 'SERVICE_REQUEST') {
    throw new HttpError(409, 'A service request is delivered item by item.', 'deliver_items');
  }
  if (!rule.from.has(req.status) && (isAdmin(user) || (rule.who === 'worker' && isAssignedEngineer(user, req)))) {
    throw new HttpError(409, 'This ticket has moved on — refresh to see its current status.', 'wrong_status');
  }
  throw new HttpError(404, 'Not found.', 'not_found');
}

// Status after an action. assign: OPEN → ASSIGNED, else unchanged.
function nextStatus(action, current) {
  const rule = ACTIONS[action];
  if (action === 'assign') return current === 'OPEN' ? 'ASSIGNED' : current;
  return rule.to;
}

module.exports = {
  ACTIONS,
  ACTION_KEYS,
  FINAL,
  allowedActions,
  assertAllowed,
  canComment,
  canSeeInternal,
  canEditTriage,
  canDecideItems,
  canDeliverItems,
  nextStatus,
};
