// /Atom/api/settings — Super Admin only (out of role = 404). Decided 28 Oct 2026.
//   GET   /                      → { timeFrames, email: { emailEnabled, smtpConfigured, counts, emails } }
//   PATCH /time-frames  { targets: [{ priority, minMinutes, maxMinutes }] } → { timeFrames }
//   PATCH /email        { enabled: boolean }                              → { email }
//   GET   /push                          → { pushEnabled, keysConfigured, devices, people }
//   PATCH /push        { enabled: boolean }                              → same   (Web Push, Phase 14)
//   GET   /companies                     → { companies: [{ id, code, name, isOpen }] }
//   PATCH /companies/:code { isOpen }    → { companies }   open / close a company (at least one stays open)
//   GET   /email-design                  → { design, defaults, palettes, styles, smtpConfigured, history }
//   PUT   /email-design  { design }      → { design }      save (checked, logged)
//   POST  /email-design/reset            → { design }      back to the default look (logged)
//   POST  /email-design/preview { design, sample, company } → { html }   nothing saved
//   POST  /email-design/test    { design?, sample, company } → { sent, to }  to the Super Admin's own email
const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/requireAuth');
const { HttpError } = require('../../utils/httpError');
const timeFrames = require('../requests/timeFrames');
const email = require('../notifications/email');
const companies = require('./companies.service');
const push = require('../push/push.service');
const emailDesign = require('../../services/emailDesign');
const emailDesignPage = require('./emailDesign.service');

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
  router.get('/push', handle(async (req, res) => res.json(await push.getSettings())));
  router.patch('/push', handle(async (req, res) => res.json(await push.setEnabled(req.user, req.body?.enabled))));
  router.get('/companies', handle(async (req, res) => res.json({ companies: await companies.list() })));
  router.patch('/companies/:code', handle(async (req, res) => res.json({ companies: await companies.setOpen(req.user, req.params.code, req.body || {}) })));
  router.get('/email-design', handle(async (req, res) => res.json(await emailDesignPage.overview())));
  router.put('/email-design', handle(async (req, res) => res.json({ design: await emailDesign.save(req.user, req.body?.design) })));
  router.post('/email-design/reset', handle(async (req, res) => res.json({ design: await emailDesign.reset(req.user) })));
  router.post(
    '/email-design/preview',
    handle(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(emailDesignPage.preview(req.body?.design, { sample: req.body?.sample, company: req.body?.company }));
    })
  );
  router.post(
    '/email-design/test',
    handle(async (req, res) => res.json(await emailDesignPage.sendTest(req.user, req.body?.design || null, { sample: req.body?.sample, company: req.body?.company })))
  );
  return router;
}

module.exports = { createSettingsRouter };
