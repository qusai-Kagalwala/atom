// Scope guards (ATOM_Decisions.md §6–§7). Every endpoint that touches a ticket, request, asset,
// invoice or FAQ uses these — the UI hiding a button is never the protection.
//
// Access follows the ACTIVE role only (req.user.activeRole), never the union of roles.
// Out of scope = 404 "Not found." (same as missing), so record IDs can't be probed.
//
// Record convention (later tables use these column names):
//   requester_id          the person the ticket/request is for
//   raised_by_id          who raised it (a Super Admin raising for someone else)
//   assigned_engineer_id  the engineer working on it
//   service_unit_id       the team that does the work
const { requireRole } = require('./requireAuth');
const { notFound } = require('../utils/httpError');
const repo = require('../modules/serviceUnits/serviceUnits.repo');

const SUPER_ADMIN = 'SUPER_ADMIN';
const ENGINEER = 'ENGINEER';
const EMPLOYEE = 'EMPLOYEE';

const same = (a, b) => a != null && b != null && String(a) === String(b);

// Engineer's service-unit tags, loaded once per request.
async function serviceUnitIdsFor(req) {
  if (!req.scopeCache) req.scopeCache = {};
  if (!req.scopeCache.unitIds) req.scopeCache.unitIds = await repo.userServiceUnitIds(req.user.id);
  return req.scopeCache.unitIds;
}

// purpose:
//   'raise' — create a ticket / request in this unit. Any role; the unit must be active
//             (Super Admin may also use inactive units — Siyanaat is backend-only for now).
//   'work'  — act as the team: work queues, asset history, invoices.
//             Super Admin: any unit. Engineer: only units they're tagged to. Employee: never.
// Returns the service unit row; throws 404 otherwise.
async function assertServiceUnitInScope(req, serviceUnitId, { purpose = 'raise' } = {}) {
  const unit = await repo.getServiceUnit(serviceUnitId);
  if (!unit) throw notFound();

  const role = req.user?.activeRole;
  if (role === SUPER_ADMIN) return unit;

  if (purpose === 'raise') {
    if (unit.is_active) return unit;
    throw notFound();
  }

  if (purpose === 'work' && role === ENGINEER) {
    const ids = await serviceUnitIdsFor(req);
    if (ids.includes(String(unit.id))) return unit;
  }
  throw notFound();
}

// One record (ticket, request, …) — true/false, no DB access.
function isRecordInScope(user, record) {
  if (!user || !record) return false;
  const me = user.id;
  switch (user.activeRole) {
    case SUPER_ADMIN:
      return true;
    case ENGINEER:
      // Assigned work, plus anything they raised for themselves (Engineers have all Employee actions).
      return same(record.assigned_engineer_id, me) || same(record.requester_id, me);
    case EMPLOYEE:
      return same(record.requester_id, me) || same(record.raised_by_id, me);
    default:
      return false; // no or unknown role → nothing
  }
}

function assertRecordInScope(req, record) {
  if (!isRecordInScope(req.user, record)) throw notFound();
  return record;
}

// SQL filter for list endpoints, so lists only ever contain in-scope rows.
//   const { clause, params } = recordScopeSql(req.user, 'r', 1);
//   pool.query(`SELECT … FROM requests r WHERE ${clause} …`, params)
// startIndex = number of the first placeholder to use ($1, $2, …).
function recordScopeSql(user, alias, startIndex = 1) {
  const a = alias ? `${alias}.` : '';
  const p = `$${startIndex}::bigint`;
  switch (user?.activeRole) {
    case SUPER_ADMIN:
      return { clause: 'TRUE', params: [] };
    case ENGINEER:
      return { clause: `(${a}assigned_engineer_id = ${p} OR ${a}requester_id = ${p})`, params: [user.id] };
    case EMPLOYEE:
      return { clause: `(${a}requester_id = ${p} OR ${a}raised_by_id = ${p})`, params: [user.id] };
    default:
      return { clause: 'FALSE', params: [] }; // no or unknown role → nothing
  }
}

// Express wrapper: takes the unit id from req.params / req.body, checks it, sets req.serviceUnit.
//   router.post('/', requireAuth, serviceUnitFrom('body', 'serviceUnitId', 'raise'), handler)
function serviceUnitFrom(where, field, purpose = 'raise') {
  return async (req, res, next) => {
    try {
      req.serviceUnit = await assertServiceUnitInScope(req, req[where]?.[field], { purpose });
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  requireRole,
  assertServiceUnitInScope,
  assertRecordInScope,
  isRecordInScope,
  recordScopeSql,
  serviceUnitFrom,
  serviceUnitIdsFor,
};
