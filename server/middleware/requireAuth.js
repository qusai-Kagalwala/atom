// Use on every protected route. Verifies the token, then RELOADS the user and their roles,
// so deactivation, role removal and password changes take effect on the very next request.
// Sets req.user = { id, loginType, itsNumber, employeeId, name, email, roles, activeRole }
// and req.sessionVersion (needed to sign a replacement token, e.g. switch-role).
//
// 401 responses carry a `code` the client maps to /login?error=<code>:
//   session_expired · removed · role_changed · password_changed
//
// checkSession() is the same check without Express — Socket.IO uses it for its handshake.
const { verifySession } = require('../modules/auth/tokens');
const { loadSessionUser } = require('../modules/auth/users.repo');
const { toPublicUser } = require('../modules/auth/session');

const DENY = {
  session_expired: 'Your session has expired. Please sign in again.',
  removed: 'Your ATOM access has been removed.',
  role_changed: 'Your role has changed. Please sign in again.',
  password_changed: 'Your password was changed. Please sign in again.',
};

const deny = (res, code) => res.status(401).json({ message: DENY[code], code });

// → { user, sessionVersion } or { code } (one of the DENY keys). Throws only on a DB error.
async function checkSession(token) {
  if (!token) return { code: 'session_expired' };

  let session;
  try {
    session = verifySession(token);
  } catch {
    return { code: 'session_expired' };
  }

  const row = await loadSessionUser(session.userId);
  if (!row || !row.is_active || String(row.id) !== session.userId) return { code: 'removed' };
  if ((Number(row.session_version) || 0) !== session.version) return { code: 'password_changed' };
  if (!row.roles.includes(session.role)) return { code: 'role_changed' };

  return { user: toPublicUser(row, session.role), sessionVersion: session.version };
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  try {
    const result = await checkSession(token);
    if (result.code) return deny(res, result.code);
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

module.exports = { requireAuth, requireRole, checkSession, DENY };
