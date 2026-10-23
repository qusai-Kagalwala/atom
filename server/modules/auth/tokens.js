// ATOM session tokens. The JWT carries only the user id and the ACTIVE role.
// Everything else (roles granted, active flag) is reloaded by requireAuth on every request.
const jwt = require('jsonwebtoken');
const { config } = require('../../config/env');

const ALGORITHM = 'HS256';

function signSession(userId, activeRole) {
  return jwt.sign({ role: activeRole }, config.sessionSecret, {
    algorithm: ALGORITHM,
    subject: String(userId),
    expiresIn: config.jwtExpiresIn,
  });
}

// Throws on a bad, tampered or expired token.
function verifySession(token) {
  const payload = jwt.verify(token, config.sessionSecret, { algorithms: [ALGORITHM] });
  if (!payload.sub || typeof payload.role !== 'string') {
    throw new Error('Malformed session token');
  }
  return { userId: payload.sub, role: payload.role };
}

module.exports = { signSession, verifySession };
