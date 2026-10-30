// /Atom/api/problems — the active company's problem list (Category > Item > Problem).
//   Everyone in the company:
//     GET  /                         → { autoAssign, categories: [{ …, occupation, items: [{ …, problems }] }] }  (active only)
//   Admin of the company (?includeInactive=1 on GET as well):
//     PATCH /settings     { autoAssign }                                   → { autoAssign }
//     POST  /categories   { name, occupationId?, sortOrder? }             → 201 { id }
//     PATCH /categories/:id { name?, isActive?, occupationId?, sortOrder? } → { id }
//     POST  /items        { categoryId, name }   · PATCH /items/:id { name?, isActive?, categoryId? }
//     POST  /problems     { itemId, name }       · PATCH /problems/:id { name?, isActive? }
// Another company's rows = 404.
const express = require('express');
const { requireAuth, requireCompany, requireAdmin } = require('../../middleware/requireAuth');
const { isAdmin } = require('../../utils/roles');
const svc = require('./problems.service');

const handle = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res);
  } catch (e) {
    return next(e);
  }
};

function createProblemsRouter() {
  const router = express.Router();
  router.use(requireAuth, requireCompany);

  router.get('/', handle(async (req, res) => res.json(await svc.tree(req.user, { includeInactive: req.query.includeInactive === '1' && isAdmin(req.user) }))));

  router.patch('/settings', ...requireAdmin, handle(async (req, res) => res.json(await svc.setAutoAssign(req.user, req.body || {}))));
  router.post('/categories', ...requireAdmin, handle(async (req, res) => res.status(201).json(await svc.createCategory(req.user, req.body || {}))));
  router.patch('/categories/:id', ...requireAdmin, handle(async (req, res) => res.json(await svc.updateCategory(req.user, req.params.id, req.body || {}))));
  router.post('/items', ...requireAdmin, handle(async (req, res) => res.status(201).json(await svc.createItem(req.user, req.body || {}))));
  router.patch('/items/:id', ...requireAdmin, handle(async (req, res) => res.json(await svc.updateItem(req.user, req.params.id, req.body || {}))));
  router.post('/problems', ...requireAdmin, handle(async (req, res) => res.status(201).json(await svc.createProblem(req.user, req.body || {}))));
  router.patch('/problems/:id', ...requireAdmin, handle(async (req, res) => res.json(await svc.updateProblem(req.user, req.params.id, req.body || {}))));

  return router;
}

module.exports = { createProblemsRouter };
