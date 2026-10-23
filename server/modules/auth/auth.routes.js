// /Atom/api/auth/*
//   POST /login        { identifier, password, role? }  → { token, user }
//   GET  /me                                            → { user }
//   POST /switch-role  { role }                         → { token, user }
// SECURITY: never log req.body here.
const express = require('express');
const { body, validationResult } = require('express-validator');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { login, AuthError } = require('./auth.service');
const { requireAuth } = require('../../middleware/requireAuth');
const { ROLE_KEYS } = require('./session');
const { signSession } = require('./tokens');

const WINDOW_MS = 15 * 60 * 1000;
const TOO_MANY = { message: 'Too many login attempts. Please try again later.' };

function createAuthRouter() {
  const router = express.Router();

  // Per IP + identifier: 10 failed attempts / 15 min (stops guessing one account,
  // and stops ATOM being used to guess eJamaat passwords).
  const perIdentifierLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.identifier ?? '').trim()}`,
    message: TOO_MANY,
  });

  // Per IP: 50 attempts / 15 min across all IDs (stops spraying many IDs from one machine).
  const perIpLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: 50,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    message: TOO_MANY,
  });

  const loginRules = [
    body('identifier').isString().trim().matches(/^\d{1,12}$/),
    body('password').isString().isLength({ min: 1, max: 256 }),
    body('role').optional({ values: 'null' }).isIn(ROLE_KEYS),
  ];

  router.post('/login', perIpLimiter, perIdentifierLimiter, loginRules, async (req, res, next) => {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ message: 'Enter your ITS number or Employee ID and password.' });
    }
    try {
      const { identifier, password, role } = req.body;
      const result = await login({ identifier, password, preferredRole: role });
      return res.json(result);
    } catch (err) {
      if (err instanceof AuthError) return res.status(err.status).json({ message: err.message, code: err.code });
      return next(err);
    }
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  router.post('/switch-role', requireAuth, [body('role').isIn(ROLE_KEYS)], (req, res) => {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ message: 'Choose a valid role.' });
    }
    const { role } = req.body;
    if (!req.user.roles.includes(role)) {
      return res.status(403).json({ message: 'You do not have that role.', code: 'role_not_granted' });
    }
    const user = { ...req.user, activeRole: role };
    return res.json({ token: signSession(user.id, role), user });
  });

  return router;
}

module.exports = { createAuthRouter };
