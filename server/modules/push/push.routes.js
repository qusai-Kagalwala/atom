// /Atom/api/push — Phase 14. The signed-in person's devices (any role, any company or none):
//   GET    /                       → { publicKey, enabled, myDevices }   publicKey null until VAPID keys are set
//   POST   /subscriptions { subscription }  → same   this device gets pushes
//   DELETE /subscriptions { endpoint }      → same   this device stops
// Only the person's own subscriptions can be changed.
const express = require('express');
const { requireAuth } = require('../../middleware/requireAuth');
const push = require('./push.service');

const handle = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res);
  } catch (e) {
    return next(e);
  }
};

function createPushRouter() {
  const router = express.Router();
  router.use(requireAuth);
  router.get('/', handle(async (req, res) => res.json(await push.publicInfo(req.user))));
  router.post('/subscriptions', handle(async (req, res) => res.json(await push.subscribe(req.user, req.body || {}, req.get('user-agent')))));
  router.delete('/subscriptions', handle(async (req, res) => res.json(await push.unsubscribe(req.user, req.body || {}))));
  return router;
}

module.exports = { createPushRouter };
