// /Atom/api/auth/*
//   POST /login            { identifier, password, role?, companyId? } → { token, user }
//   GET  /me                                                    → { user }
//   GET  /open-companies   (public)                             → { companies: [{ code, name }] }   open companies only
//   GET  /companies                                             → { companies: [{ id, code, name, tagline, isOpen, roles }] }
//                          (closed companies only for the Super Admin)
//   POST /switch           { companyId | null, role? }          → { token, user }   company picker
//                          (null = no company: Super Admin console only)
//   POST /switch-role      { role }                             → { token, user }   same company
//   POST /change-password  { currentPassword, newPassword }     → { message }   (employee-ID users)
//   POST /forgot-password  { employeeId }                       → { sent, message }
//   POST /reset-password   { token, newPassword }               → { message }
//   PATCH /preferences     { nameLanguage: 'en' | 'ar' }        → { user }
//   PATCH /contact         { email?, mobile? }  ('' clears)     → { user }   your own email / mobile (032)
//   GET   /theme                                                → { theme: { theme, mode } | null }   Appearance
//   PUT   /theme           { theme, mode }                      → { theme: { theme, mode } }
//                          (503 theme_unavailable until migration 025 is applied; allowed values: shared/themes.json)
// SECURITY: never log req.body here.
const express = require('express');
const { body, validationResult } = require('express-validator');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { login, AuthError } = require('./auth.service');
const { changePassword, requestReset, resetPassword, PasswordError } = require('./passwords.service');
const { requireAuth } = require('../../middleware/requireAuth');
const { ROLE_KEYS, pickActiveRole, rolesIn, toPublicUser } = require('./session');
const { loadSessionUser, listCompanies, setNameLanguage, setNotifyPrefs, bumpSessionVersion } = require('./users.repo');
const realtime = require('../../realtime');
const { signSession } = require('./tokens');
const { getTheme, setTheme } = require('./theme.repo');
const themes = require('../../../shared/themes.json');
const { setOwnContact } = require('../users/contact');
const pool = require('../../db/pool');

const WINDOW_MS = 15 * 60 * 1000;

function limiter({ limit, key, message, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    skipSuccessfulRequests,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: key,
    message: { message },
  });
}

const ipKey = (req) => ipKeyGenerator(req.ip);
const fieldKey = (field) => (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.[field] ?? '').trim()}`;

// Turns service errors into JSON; anything else goes to the app error handler (500).
const handle = (fn) => async (req, res, next) => {
  try {
    return res.json(await fn(req));
  } catch (err) {
    if (err instanceof AuthError || err instanceof PasswordError) {
      return res.status(err.status).json({ message: err.message, code: err.code });
    }
    return next(err);
  }
};

const invalid = (req) => !validationResult(req).isEmpty();

function createAuthRouter() {
  const router = express.Router();

  // ---------- Login ----------
  const LOGIN_LIMIT_MSG = 'Too many login attempts. Please try again later.';
  // Per IP + identifier: 10 failed attempts / 15 min (also stops ATOM being used to guess eJamaat passwords).
  const loginPerId = limiter({ limit: 10, key: fieldKey('identifier'), message: LOGIN_LIMIT_MSG, skipSuccessfulRequests: true });
  // Per IP: 50 attempts / 15 min across all IDs (stops spraying many IDs from one machine).
  const loginPerIp = limiter({ limit: 50, key: ipKey, message: LOGIN_LIMIT_MSG });

  router.post(
    '/login',
    loginPerIp,
    loginPerId,
    body('identifier').isString().trim().matches(/^\d{1,12}$/),
    body('password').isString().isLength({ min: 1, max: 256 }),
    body('role').optional({ values: 'null' }).isIn(ROLE_KEYS),
    body('companyId').optional({ values: 'null' }).matches(/^\d{1,18}$/),
    body('keep').optional().isBoolean({ strict: true }),
    (req, res, next) =>
      invalid(req)
        ? res.status(400).json({ message: 'Enter your ITS number or Employee ID and password.' })
        : next(),
    handle((req) => {
      const { identifier, password, role, companyId, keep } = req.body;
      return login({ identifier, password, preferredRole: role, companyId, keep: keep === true });
    })
  );

  // ---------- Session ----------
  // keepSignedIn: this device was signed in with "Keep me signed in".
  router.get('/me', requireAuth, (req, res) => res.json({ user: req.user, keepSignedIn: req.sessionKeep }));

  // "Sign out of all devices" (6 Nov 2026): every other device is signed out; this one gets a fresh token.
  router.post('/sign-out-everywhere', requireAuth, async (req, res, next) => {
    try {
      const version = await bumpSessionVersion(req.user.id);
      const except = /^[A-Za-z0-9_-]{1,64}$/.test(String(req.get('X-Socket-Id') || '')) ? req.get('X-Socket-Id') : undefined;
      realtime.disconnectUser(req.user.id, { except });
      return res.json({ token: signSession(req.user.id, req.user.activeRole, version, req.user.companyId, { keep: req.sessionKeep }) });
    } catch (err) {
      return next(err);
    }
  });

  // How I get notified: { inApp, email } — at least one on.
  router.patch('/notify', requireAuth, body('inApp').isBoolean({ strict: true }), body('email').isBoolean({ strict: true }), async (req, res, next) => {
    if (invalid(req) || (!req.body.inApp && !req.body.email)) return res.status(400).json({ message: 'Keep at least one way on.', code: 'need_one' });
    try {
      await setNotifyPrefs(req.user.id, { inApp: req.body.inApp, email: req.body.email });
      return res.json({ notify: { inApp: req.body.inApp, email: req.body.email } });
    } catch (err) {
      return next(err);
    }
  });

  // Before sign-in: the open companies' names (login page subtitle).
  router.get('/open-companies', async (req, res, next) => {
    try {
      return res.json({ companies: (await listCompanies()).map(({ code, name }) => ({ code, name })) });
    } catch (err) {
      return next(err);
    }
  });

  // Company picker: every open company (the Super Admin also sees closed ones), with the roles this
  // person has there.
  router.get('/companies', requireAuth, async (req, res, next) => {
    try {
      const row = await loadSessionUser(req.user.id);
      const isSuper = row.roles.includes('SUPER_ADMIN');
      const companies = (await listCompanies({ includeClosed: isSuper })).map((c) => ({ ...c, roles: rolesIn(row, c.id) }));
      return res.json({ companies });
    } catch (err) {
      return next(err);
    }
  });

  // Signs a new token for another company (and role). The role defaults to the highest one there.
  router.post(
    '/switch',
    requireAuth,
    body('companyId').optional({ values: 'null' }).matches(/^\d{1,18}$/),
    body('role').optional({ values: 'null' }).isIn(ROLE_KEYS),
    async (req, res, next) => {
      if (invalid(req)) return res.status(400).json({ message: 'Choose a company.' });
      try {
        const companyId = req.body.companyId ? String(req.body.companyId) : null;
        const row = await loadSessionUser(req.user.id, companyId);
        if (companyId && !row.company) return res.status(404).json({ message: 'Not found.' });
        // Closed by the Super Admin: only the Super Admin may still enter.
        if (companyId && row.company.open === false && !row.roles.includes('SUPER_ADMIN')) return res.status(404).json({ message: 'Not found.' });
        const allowed = rolesIn(row, companyId);
        if (!allowed.length) return res.status(403).json({ message: 'You have no access to this company.', code: 'no_company_access' });
        if (req.body.role && !allowed.includes(req.body.role)) {
          return res.status(403).json({ message: 'You do not have that role here.', code: 'role_not_granted' });
        }
        const role = pickActiveRole(allowed, req.body.role);
        return res.json({ token: signSession(req.user.id, role, req.sessionVersion, companyId, { keep: req.sessionKeep }), user: toPublicUser(row, role) });
      } catch (err) {
        return next(err);
      }
    }
  );

  router.post('/switch-role', requireAuth, body('role').isIn(ROLE_KEYS), (req, res) => {
    if (invalid(req)) return res.status(400).json({ message: 'Choose a valid role.' });
    const { role } = req.body;
    if (!req.user.roles.includes(role)) {
      return res.status(403).json({ message: 'You do not have that role.', code: 'role_not_granted' });
    }
    if (req.user.companyId && !req.user.rolesHere.includes(role)) {
      return res.status(403).json({ message: 'You do not have that role in this company.', code: 'role_not_granted' });
    }
    const user = { ...req.user, activeRole: role };
    return res.json({ token: signSession(user.id, role, req.sessionVersion, req.user.companyId, { keep: req.sessionKeep }), user });
  });

  // ---------- Preferences ----------
  // Which name to show for yourself: 'en' (U_NAME) or 'ar' (T_Name, only if you have one).
  router.patch('/preferences', requireAuth, body('nameLanguage').isIn(['en', 'ar']), async (req, res, next) => {
    if (invalid(req)) return res.status(400).json({ message: 'Choose English or Arabic.' });
    try {
      const ok = await setNameLanguage(req.user.id, req.body.nameLanguage);
      if (!ok) return res.status(400).json({ message: 'No Arabic name is on file for you.', code: 'no_arabic_name' });
      const fresh = await loadSessionUser(req.user.id, req.user.companyId);
      return res.json({ user: toPublicUser(fresh, req.user.activeRole) });
    } catch (err) {
      return next(err);
    }
  });

  // Your own email and mobile (7 Nov 2026): saved straight away; the sync never overwrites them.
  router.patch('/contact', requireAuth, async (req, res, next) => {
    try {
      await setOwnContact(pool, req.user.id, { email: req.body?.email, mobile: req.body?.mobile });
      const fresh = await loadSessionUser(req.user.id, req.user.companyId);
      return res.json({ user: toPublicUser(fresh, req.user.activeRole) });
    } catch (err) {
      if (err.expose) return res.status(err.status).json({ message: err.message, code: err.code });
      return next(err);
    }
  });

  // ---------- Appearance ----------
  // Colour theme + light/dark, saved per person so it follows them to other devices. Kept apart from the
  // session user on purpose (see theme.repo.js): nothing here runs on ordinary requests.
  const themeLimit = limiter({
    limit: 120,
    key: (req) => `theme:${req.user.id}`,
    message: 'Too many changes. Please try again later.',
  });

  router.get('/theme', requireAuth, async (req, res, next) => {
    try {
      return res.json({ theme: await getTheme(req.user.id) });
    } catch (err) {
      return next(err);
    }
  });

  router.put(
    '/theme',
    requireAuth,
    themeLimit,
    body('theme').isIn(themes.themes),
    body('mode').isIn(themes.modes),
    async (req, res, next) => {
      if (invalid(req)) return res.status(400).json({ message: 'Choose a colour and light or dark.' });
      try {
        const saved = await setTheme(req.user.id, { theme: req.body.theme, mode: req.body.mode });
        if (!saved) {
          return res.status(503).json({ message: 'Saving your theme is not available yet.', code: 'theme_unavailable' });
        }
        return res.json({ theme: saved });
      } catch (err) {
        return next(err);
      }
    }
  );

  // ---------- Change password (logged in) ----------
  // 10 wrong "current password" tries / 15 min per user, so a stolen session can't brute-force it.
  const changeLimit = limiter({
    limit: 10,
    key: (req) => `user:${req.user.id}`,
    message: 'Too many attempts. Please try again later.',
    skipSuccessfulRequests: true,
  });

  router.post(
    '/change-password',
    requireAuth,
    changeLimit,
    body('currentPassword').isString().isLength({ min: 1, max: 256 }),
    body('newPassword').isString(),
    (req, res, next) =>
      invalid(req) ? res.status(400).json({ message: 'Enter your current and new password.' }) : next(),
    handle((req) =>
      changePassword(req.user, req.body.currentPassword, req.body.newPassword, { keepSocketId: req.get('X-Socket-Id'), keep: req.sessionKeep })
    )
  );

  // ---------- Forgot / reset (public) ----------
  const RESET_LIMIT_MSG = 'Too many reset requests. Please try again later.';
  const forgotPerId = limiter({ limit: 3, key: fieldKey('employeeId'), message: RESET_LIMIT_MSG });
  const forgotPerIp = limiter({ limit: 10, key: ipKey, message: RESET_LIMIT_MSG });

  router.post(
    '/forgot-password',
    forgotPerIp,
    forgotPerId,
    body('employeeId').isString().trim().matches(/^\d{1,12}$/),
    (req, res, next) => (invalid(req) ? res.status(400).json({ message: 'Enter your Employee ID.' }) : next()),
    handle((req) => requestReset(req.body.employeeId))
  );

  const resetPerIp = limiter({ limit: 20, key: ipKey, message: RESET_LIMIT_MSG });

  router.post(
    '/reset-password',
    resetPerIp,
    body('token').isString(),
    body('newPassword').isString(),
    (req, res, next) => (invalid(req) ? res.status(400).json({ message: 'Enter a new password.' }) : next()),
    handle((req) => resetPassword(req.body.token, req.body.newPassword))
  );

  return router;
}

module.exports = { createAuthRouter };
