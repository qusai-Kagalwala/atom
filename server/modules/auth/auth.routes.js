// /Atom/api/auth/*
//   POST /login            { identifier, password, role? }      → { token, user }
//   GET  /me                                                    → { user }
//   POST /switch-role      { role }                             → { token, user }
//   POST /change-password  { currentPassword, newPassword }     → { message }   (employee-ID users)
//   POST /forgot-password  { employeeId }                       → { sent, message }
//   POST /reset-password   { token, newPassword }               → { message }
// SECURITY: never log req.body here.
const express = require('express');
const { body, validationResult } = require('express-validator');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { login, AuthError } = require('./auth.service');
const { changePassword, requestReset, resetPassword, PasswordError } = require('./passwords.service');
const { requireAuth } = require('../../middleware/requireAuth');
const { ROLE_KEYS } = require('./session');
const { signSession } = require('./tokens');

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
    (req, res, next) =>
      invalid(req)
        ? res.status(400).json({ message: 'Enter your ITS number or Employee ID and password.' })
        : next(),
    handle((req) => {
      const { identifier, password, role } = req.body;
      return login({ identifier, password, preferredRole: role });
    })
  );

  // ---------- Session ----------
  router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

  router.post('/switch-role', requireAuth, body('role').isIn(ROLE_KEYS), (req, res) => {
    if (invalid(req)) return res.status(400).json({ message: 'Choose a valid role.' });
    const { role } = req.body;
    if (!req.user.roles.includes(role)) {
      return res.status(403).json({ message: 'You do not have that role.', code: 'role_not_granted' });
    }
    const user = { ...req.user, activeRole: role };
    return res.json({ token: signSession(user.id, role), user });
  });

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
    handle((req) => changePassword(req.user, req.body.currentPassword, req.body.newPassword))
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
