// Use on every protected route. Verifies the token, then RELOADS the user and their roles,
// so deactivation and role removal take effect on the very next request.
// Sets req.user = { id, loginType, itsNumber, employeeId, name, email, roles, activeRole }.
//
// 401 responses carry a `code` the client maps to /login?error=<code>:
//   session_expired · removed · role_changed
const { verifySession } = require('../modules/auth/tokens');
const { loadSessionUser } = require('../modules/auth/users.repo');
const { toPublicUser } = require('../modules/auth/session');

const DENY = {
  session_expired: 'Your session has expired. Please sign in again.',
  removed: 'Your ATOM access has been removed.',
  role_changed: 'Your role has changed. Please sign in again.',
};

const deny = (res, code) => res.status(401).json({ message: DENY[code], code });

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return deny(res, 'session_expired');

  let session;
  try {
    session = verifySession(token);
  } catch {
    return deny(res, 'session_expired');
  }

  try {
    const user = await loadSessionUser(session.userId);
    if (!user || !user.is_active || String(user.id) !== session.userId) return deny(res, 'removed');
    if (!user.roles.includes(session.role)) return deny(res, 'role_changed');

    req.user = toPublicUser(user, session.role);
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

module.exports = { requireAuth, requireRole, DENY };
