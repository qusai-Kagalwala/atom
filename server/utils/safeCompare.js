// Constant-time string comparison. Hashing first makes both buffers the same length,
// so the comparison time doesn't reveal the stored value's length either.
const crypto = require('crypto');

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = safeCompare;
