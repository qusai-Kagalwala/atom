// /Atom/api/settings — Super Admin only (out of role = 404). Decided 28 Oct 2026.
//   GET   /                      → { timeFrames, email: { emailEnabled, smtpConfigured, counts, emails } }
//   PATCH /time-frames  { targets: [{ priority, minMinutes, maxMinutes }] } → { timeFrames }
//   PATCH /email        { enabled: boolean }                              → { email }
const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/requireAuth');
const { HttpError } = require('../../utils/httpError');
const timeFrames = require('../requests/timeFrames');
const email = require('../notifications/email');

const handle = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res);
  } catch (e) {
    return next(e);
  }
};

function createSettingsRouter() {
  const router = express.Router();
  router.use(requireAuth, requireRole('SUPER_ADMIN'));
  router.get(
    '/',
    handle(async (req, res) => res.json({ timeFrames: await timeFrames.listTargets(), email: { ...(await email.getSettings()), ...(await email.recentEmails()) } }))
  );
  router.patch('/time-frames', handle(async (req, res) => res.json({ timeFrames: await timeFrames.updateTargets(req.user, req.body || {}) })));
  router.patch(
    '/email',
    handle(async (req, res) => {
      if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, 'Bad value.', 'invalid');
      res.json({ email: await email.setEnabled(req.user, req.body.enabled) });
    })
  );
  return router;
}

module.exports = { createSettingsRouter };
