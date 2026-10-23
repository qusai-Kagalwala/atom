// Login logic (ATOM_Decisions.md §2):
//   1. Employee ID found  → compare stored legacy password (constant time).
//      Wrong → 401 and STOP (never falls through to eJamaat). Inactive → 403.
//   2. Not an employee ID → must be an 8-digit ITS number → eJamaat (or mock) → ATOM account check.
//   3. ATOM issues its own JWT carrying the active role.
// SECURITY: never log the password or the request body.
const { config } = require('../../config/env');
const ejamaat = require('../../services/ejamaatClient');
const safeCompare = require('../../utils/safeCompare');
const repo = require('./users.repo');
const { pickActiveRole, toPublicUser } = require('./session');
const { signSession } = require('./tokens');

const MSG = {
  invalid: 'Invalid ID or password.',
  noAccount: 'No ATOM account for this ITS.',
  inactive: 'Your ATOM account is inactive.',
  noRole: 'Your ATOM account has no role yet. Please contact a Super Admin.',
  unreachable: 'Could not reach the authentication service.',
};

class AuthError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function checkEmployeeId(identifier, password) {
  const employee = await repo.findEmployeeForLogin(identifier);
  if (!employee) return null;

  // Password first, so a wrong password never reveals whether the account is inactive.
  if (!safeCompare(password, employee.legacy_password)) throw new AuthError(401, MSG.invalid, 'invalid');
  if (!employee.is_active) throw new AuthError(403, MSG.inactive, 'inactive');
  return employee.id;
}

async function checkIts(itsNumber, password) {
  if (config.authMode !== 'mock') {
    let result;
    try {
      result = await ejamaat.authenticate(itsNumber, password);
    } catch (err) {
      console.error(`eJamaat call failed: ${err.message}`);
      throw new AuthError(502, MSG.unreachable, 'unreachable');
    }
    if (!result.success) throw new AuthError(401, MSG.invalid, 'invalid');
  }
  // AUTH_MODE=mock (dev/tests only): any non-empty password for an ITS number that has an ATOM account.

  const user = await repo.findItsUser(itsNumber);
  if (!user) throw new AuthError(403, MSG.noAccount, 'no_account');
  if (!user.is_active) throw new AuthError(403, MSG.inactive, 'inactive');
  return user.id;
}

async function login({ identifier, password, preferredRole }) {
  let userId = await checkEmployeeId(identifier, password);

  if (!userId) {
    if (!/^\d{8}$/.test(identifier)) throw new AuthError(401, MSG.invalid, 'invalid');
    userId = await checkIts(identifier, password);
  }

  const user = await repo.loadSessionUser(userId);
  if (!user || !user.is_active) throw new AuthError(403, MSG.inactive, 'inactive');
  if (!user.roles.length) throw new AuthError(403, MSG.noRole, 'no_role');

  const activeRole = pickActiveRole(user.roles, preferredRole);
  return { token: signSession(user.id, activeRole), user: toPublicUser(user, activeRole) };
}

module.exports = { login, AuthError, MSG };
