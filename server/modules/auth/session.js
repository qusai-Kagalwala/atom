// Role choice + the user shape the API returns. Shared role constants come from shared/roles.json.
const { roles: ROLES } = require('../../../shared/roles.json');

const ROLE_KEYS = Object.keys(ROLES);

function highestRole(granted) {
  return [...granted].sort((a, b) => (ROLES[b]?.rank ?? 0) - (ROLES[a]?.rank ?? 0))[0] || null;
}

// Last-used role on this device if still granted, otherwise the highest granted role.
function pickActiveRole(granted, preferred) {
  if (preferred && granted.includes(preferred)) return preferred;
  return highestRole(granted);
}

// The only user object the auth API returns. Never includes a password.
function toPublicUser(row, activeRole) {
  return {
    id: String(row.id),
    loginType: row.login_type,
    itsNumber: row.its_number || null,
    employeeId: row.employee_id || null,
    name: row.name || (row.employee_id ? `Employee ${row.employee_id}` : null),
    email: row.email || null,
    roles: row.roles,
    activeRole,
  };
}

module.exports = { ROLE_KEYS, highestRole, pickActiveRole, toPublicUser };
