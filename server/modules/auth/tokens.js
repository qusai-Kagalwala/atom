// ATOM session tokens. The JWT carries the user id, the ACTIVE role and the session version ("sv").
// Everything else (roles granted, active flag) is reloaded by requireAuth on every request.
// sv must equal users.session_version, which goes up when the password changes (signs out other devices).
const jwt = require('jsonwebtoken');
const { config } = require('../../config/env');

const ALGORITHM = 'HS256';

function signSession(userId, activeRole, sessionVersion = 0) {
  return jwt.sign({ role: activeRole, sv: Number(sessionVersion) || 0 }, config.sessionSecret, {
    algorithm: ALGORITHM,
    subject: String(userId),
    expiresIn: config.jwtExpiresIn,
  });
}

// Throws on a bad, tampered or expired token. Tokens from before Phase 7.1 have no sv → version 0.
function verifySession(token) {
  const payload = jwt.verify(token, config.sessionSecret, { algorithms: [ALGORITHM] });
  if (!payload.sub || typeof payload.role !== 'string') {
    throw new Error('Malformed session token');
  }
  const version = payload.sv === undefined ? 0 : payload.sv;
  if (!Number.isInteger(version) || version < 0) throw new Error('Malformed session token');
  return { userId: payload.sub, role: payload.role, version };
}

module.exports = { signSession, verifySession };
