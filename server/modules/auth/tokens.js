// ATOM session tokens. The JWT carries the user id, the ACTIVE role, the ACTIVE company ("co") and
// the session version ("sv"). Everything else (roles granted, company, active flag) is reloaded by
// requireAuth on every request.
// sv must equal users.session_version, which goes up when the password changes (signs out other devices).
// co is a service_units id, or null (no company chosen — only the Super Admin console works then).
// k = "Keep me signed in on this device" (decided 6 Nov 2026): the token lasts KEEP_DAYS instead of
// JWT_EXPIRES_IN (8 hours) and is renewed while it is used (requireAuth), so the device stays signed in
// until the person signs out — or doesn't open ATOM for KEEP_DAYS.
const jwt = require('jsonwebtoken');
const { config } = require('../../config/env');

const ALGORITHM = 'HS256';
const KEEP_DAYS = 90;

function signSession(userId, activeRole, sessionVersion = 0, companyId = null, { keep = false } = {}) {
  const payload = { role: activeRole, co: companyId == null ? null : String(companyId), sv: Number(sessionVersion) || 0 };
  if (keep) payload.k = 1;
  return jwt.sign(payload, config.sessionSecret, {
    algorithm: ALGORITHM,
    subject: String(userId),
    expiresIn: keep ? `${KEEP_DAYS}d` : config.jwtExpiresIn,
  });
}

// Throws on a bad, tampered or expired token. Tokens from before Phase 7.1 have no sv → version 0;
// tokens from before the companies change have no co → no company chosen.
function verifySession(token) {
  const payload = jwt.verify(token, config.sessionSecret, { algorithms: [ALGORITHM] });
  if (!payload.sub || typeof payload.role !== 'string') {
    throw new Error('Malformed session token');
  }
  const version = payload.sv === undefined ? 0 : payload.sv;
  if (!Number.isInteger(version) || version < 0) throw new Error('Malformed session token');
  const co = payload.co == null ? null : String(payload.co);
  if (co !== null && !/^\d{1,18}$/.test(co)) throw new Error('Malformed session token');
  return { userId: payload.sub, role: payload.role, version, companyId: co, keep: payload.k === 1, issuedAt: payload.iat };
}

module.exports = { signSession, verifySession, KEEP_DAYS };
