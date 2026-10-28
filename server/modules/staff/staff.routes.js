// /Atom/api/staff — the active company's staff and occupations. Admin of the company (or the Super
// Admin inside it) only; anyone else 404. Never reaches another company.
//   GET    /                          → { staff }          Staff and Admins of the company
//   GET    /people?q=                 → { people }         search people to add (2+ characters)
//   POST   /          { userId, occupationId }  → 201 { member }   make them Staff here
//   PATCH  /:userId   { occupationId }           → { member }       change occupation
//   DELETE /:userId                              → { removed }      remove the Staff role
//   GET    /occupations?includeInactive=1        → { occupations }
//   POST   /occupations        { name, sortOrder? }              → 201 { occupation }
//   PATCH  /occupations/:id    { name?, sortOrder?, isActive? }  → { occupation }
const express = require('express');
const { requireAuth, requireAdmin } = require('../../middleware/requireAuth');
const svc = require('./staff.service');

const handle = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res);
  } catch (e) {
    return next(e);
  }
};

function createStaffRouter() {
  const router = express.Router();
  router.use(requireAuth, ...requireAdmin);

  router.get('/occupations', handle(async (req, res) => res.json({ occupations: await svc.listOccupations(req.user, { includeInactive: req.query.includeInactive === '1' }) })));
  router.post('/occupations', handle(async (req, res) => res.status(201).json({ occupation: await svc.createOccupation(req.user, req.body || {}) })));
  router.patch('/occupations/:id', handle(async (req, res) => res.json({ occupation: await svc.updateOccupation(req.user, req.params.id, req.body || {}) })));

  router.get('/', handle(async (req, res) => res.json({ staff: await svc.listStaff(req.user) })));
  router.get('/people', handle(async (req, res) => res.json({ people: await svc.searchPeople(req.user, String(req.query.q || '').slice(0, 100)) })));
  router.post('/', handle(async (req, res) => res.status(201).json({ member: await svc.addStaff(req.user, req.body || {}) })));
  router.patch('/:userId', handle(async (req, res) => res.json({ member: await svc.changeOccupation(req.user, req.params.userId, req.body || {}) })));
  router.delete('/:userId', handle(async (req, res) => res.json(await svc.removeStaff(req.user, req.params.userId))));

  return router;
}

module.exports = { createStaffRouter };
