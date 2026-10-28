// Use on every protected route. Verifies the token, then RELOADS the user and their roles,
// so deactivation, role removal and password changes take effect on the very next request.
// Sets req.user = { id, loginType, itsNumber, employeeId, name, email, roles, activeRole,
//                   company, companyId, rolesHere, staffCompany, occupation }
// and req.sessionVersion (needed to sign a replacement token, e.g. switch-role).
//
// 401 responses carry a `code` the client maps to /login?error=<code>:
//   session_expired · removed · role_changed · password_changed · company_changed
//
// Company (decided 28 Oct 2026): the token carries the active company. A session without one only
// reaches the auth routes and the Super Admin console; company routes answer
// 409 { code: 'choose_company' } (requireCompany) and the client shows the company picker.
//
// checkSession() is the same check without Express — Socket.IO uses it for its handshake.
//
// Temporary password (Phase 3.1): while users.must_change_password is set, every route except
// GET /auth/me and POST /auth/change-password answers 403 { code: 'must_change_password' }.
const { config } = require('../config/env');
const { verifySession } = require('../modules/auth/tokens');
const { loadSessionUser } = require('../modules/auth/users.repo');
const { rolesIn, toPublicUser } = require('../modules/auth/session');
const { ADMIN_ROLES } = require('../utils/roles');

const DENY = {
  session_expired: 'Your session has expired. Please sign in again.',
  removed: 'Your ATOM access has been removed.',
  role_changed: 'Your role has changed. Please sign in again.',
  password_changed: 'Your password was changed. Please sign in again.',
  company_changed: 'Your access to this company has changed. Please sign in again.',
};

const deny = (res, code) => res.status(401).json({ message: DENY[code], code });

const ALLOWED_WITH_TEMP_PASSWORD = new Set([
  `GET ${config.basePath}/api/auth/me`,
  `POST ${config.basePath}/api/auth/change-password`,
]);
const routeKey = (req) => `${req.method} ${`${req.baseUrl}${req.path}`.replace(/\/+$/, '')}`;

// → { user, sessionVersion } or { code } (one of the DENY keys). Throws only on a DB error.
async function checkSession(token) {
  if (!token) return { code: 'session_expired' };

  let session;
  try {
    session = verifySession(token);
  } catch {
    return { code: 'session_expired' };
  }

  const row = await loadSessionUser(session.userId, session.companyId);
  if (!row || !row.is_active || String(row.id) !== session.userId) return { code: 'removed' };
  if ((Number(row.session_version) || 0) !== session.version) return { code: 'password_changed' };
  if (!row.roles.includes(session.role)) return { code: 'role_changed' };
  // In a company: it must still be active and the role still allowed there (Admin / Staff: own company).
  if (session.companyId && (!row.company || !rolesIn(row, session.companyId).includes(session.role))) {
    return { code: 'company_changed' };
  }

  return { user: toPublicUser(row, session.role), sessionVersion: session.version };
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  try {
    const result = await checkSession(token);
    if (result.code) return deny(res, result.code);
    if (result.user.mustChangePassword && !ALLOWED_WITH_TEMP_PASSWORD.has(routeKey(req))) {
      return res.status(403).json({
        message: 'Please set your own password before using ATOM.',
        code: 'must_change_password',
      });
    }
    req.user = result.user;
    req.sessionVersion = result.sessionVersion;
    return next();
  } catch (err) {
    return next(err);
  }
}

// After requireAuth: allow only the listed ACTIVE roles. Out-of-role = 404 (don't reveal the route).
function requireRole(...allowed) {
  return (req, res, next) => {
    if (req.user && allowed.includes(req.user.activeRole)) return next();
    return res.status(404).json({ message: 'Not found.' });
  };
}

// After requireAuth: company routes need a chosen company.
function requireCompany(req, res, next) {
  if (req.user?.companyId) return next();
  return res.status(409).json({ message: 'Choose a company first.', code: 'choose_company' });
}

// Company code check, e.g. the AI assistant (AVIT only until each company has its own). Else 404.
function requireCompanyCode(...codes) {
  return (req, res, next) => (codes.includes(req.user?.company?.code) ? next() : res.status(404).json({ message: 'Not found.' }));
}

// Admin of the active company (or the Super Admin inside it).
const requireAdmin = [requireCompany, requireRole(...ADMIN_ROLES)];

module.exports = { requireAuth, requireRole, requireCompany, requireCompanyCode, requireAdmin, checkSession, DENY };
