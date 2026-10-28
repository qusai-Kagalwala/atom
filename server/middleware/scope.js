// Scope guards (ATOM_Decisions.md §6–§7, companies 28 Oct 2026). Every endpoint that touches a
// ticket, request, asset, invoice or FAQ uses these — the UI hiding a button is never the protection.
//
// Access follows the ACTIVE role and the ACTIVE company only (req.user.activeRole, req.user.companyId),
// never the union of roles. Records of another company are out of scope for everyone, Admins included.
// Out of scope = 404 "Not found." (same as missing), so record IDs can't be probed.
//
// Record convention:
//   requester_id          the person the ticket/request is for
//   raised_by_id          who raised it (an Admin raising for someone else)
//   assigned_engineer_id  the staff member working on it
//   service_unit_id       the company that does the work
const { requireRole } = require('./requireAuth');
const { notFound } = require('../utils/httpError');
const { isAdmin } = require('../utils/roles');
const repo = require('../modules/serviceUnits/serviceUnits.repo');

const same = (a, b) => a != null && b != null && String(a) === String(b);

// The active company, if the record is in it. Raising: the company must be active.
async function assertServiceUnitInScope(req, serviceUnitId) {
  const unit = await repo.getServiceUnit(serviceUnitId);
  if (!unit || !unit.is_active || !same(unit.id, req.user?.companyId)) throw notFound();
  return unit;
}

// One record (ticket, request, …) — true/false, no DB access.
function isRecordInScope(user, record) {
  if (!user || !record || !user.companyId || !same(record.service_unit_id, user.companyId)) return false;
  const me = user.id;
  if (isAdmin(user)) return true;
  switch (user.activeRole) {
    case 'ENGINEER':
      // Assigned work, plus anything they raised for themselves (Staff have all Employee actions).
      return same(record.assigned_engineer_id, me) || same(record.requester_id, me);
    case 'EMPLOYEE':
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
  if (!user?.companyId) return { clause: 'FALSE', params: [] };
  const co = `$${startIndex}::bigint`;
  const p = `$${startIndex + 1}::bigint`;
  const inCompany = `${a}service_unit_id = ${co}`;
  if (isAdmin(user)) return { clause: inCompany, params: [user.companyId] };
  switch (user.activeRole) {
    case 'ENGINEER':
      return { clause: `(${inCompany} AND (${a}assigned_engineer_id = ${p} OR ${a}requester_id = ${p}))`, params: [user.companyId, user.id] };
    case 'EMPLOYEE':
      return { clause: `(${inCompany} AND (${a}requester_id = ${p} OR ${a}raised_by_id = ${p}))`, params: [user.companyId, user.id] };
    default:
      return { clause: 'FALSE', params: [] }; // no or unknown role → nothing
  }
}

module.exports = {
  requireRole,
  assertServiceUnitInScope,
  assertRecordInScope,
  isRecordInScope,
  recordScopeSql,
};
