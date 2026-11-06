// Delegate access (decided 6 Nov 2026): a company's Admin (or the Super Admin) gives single Admin
// features to people on the company's staff. req.user.features (reloaded on every request by
// requireAuth) lists the person's live grants in the active company.
//
// On a feature's routes the person is treated as the company's Admin FOR THAT REQUEST ONLY:
// req.user becomes { ...user, activeRole: 'ADMIN', delegated: <feature>, actualRole }. Everything after
// it (scope checks, lists, permissions) then works exactly as for the Admin. Nowhere else changes.
//
//   feature('inventory')         Admin, or a person with the feature (elevated); everyone else 404
//   feature('assign', 'tickets') any of the listed features
//   elevateIf('assign', …)       never blocks: elevates if they have one, otherwise leaves them as they are
const rolesData = require('../../shared/roles.json');
const { isAdmin } = require('../utils/roles');

const FEATURES = rolesData.features;
const FEATURE_KEYS = Object.keys(FEATURES);
// Ticket / request work given as features.
const TICKET_FEATURES = ['assign', 'approvals', 'tickets'];

const has = (user, keys) => keys.find((k) => Array.isArray(user?.features) && user.features.includes(k)) || null;
const elevate = (user, key) => ({ ...user, activeRole: 'ADMIN', delegated: key, actualRole: user.activeRole });

function feature(...keys) {
  return (req, res, next) => {
    if (!req.user?.companyId) return res.status(409).json({ message: 'Choose a company first.', code: 'choose_company' });
    if (isAdmin(req.user)) return next();
    const k = has(req.user, keys);
    if (!k) return res.status(404).json({ message: 'Not found.' });
    req.user = elevate(req.user, k);
    return next();
  };
}

function elevateIf(...keys) {
  return (req, res, next) => {
    if (req.user?.companyId && !isAdmin(req.user)) {
      const k = has(req.user, keys);
      if (k) req.user = elevate(req.user, k);
    }
    return next();
  };
}

// True if the person may use the feature (Admin, or given it).
const canUse = (user, key) => isAdmin(user) || Boolean(has(user, [key]));

module.exports = { FEATURES, FEATURE_KEYS, TICKET_FEATURES, feature, elevateIf, elevate, canUse, has };
