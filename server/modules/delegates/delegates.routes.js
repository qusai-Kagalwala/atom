// /Atom/api/delegates — Delegate access (decided 6 Nov 2026). The company's Admin and the Super Admin
// inside the company only; it can never be delegated itself (everyone else 404).
//   GET /                         → { features: [{ key, label, hint, nav }], people: [{ id, name, itsNumber, employeeId, occupation, features, grants }] }
//   PUT /:userId  { features: [] } → { person, added, removed }   sets exactly these features
const express = require('express');
const { requireAuth, requireAdmin } = require('../../middleware/requireAuth');
const svc = require('./delegates.service');

const handle = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res);
  } catch (e) {
    return next(e);
  }
};

function createDelegatesRouter() {
  const router = express.Router();
  router.use(requireAuth, ...requireAdmin);
  router.get('/', handle(async (req, res) => res.json(await svc.overview(req.user))));
  router.put('/:userId', handle(async (req, res) => res.json(await svc.setFeatures(req.user, req.params.userId, req.body?.features))));
  return router;
}

module.exports = { createDelegatesRouter };
