// /Atom/api/requests — tickets (Phase 6). Every route needs login; scope is checked per ticket
// (out of scope = 404). :number accepts "T-1001" or "1001".
//   GET    /categories                                         → { categories }
//   GET    /default-location?for=<userId>   "Where?" prefill from the department (for = Super Admin only) → { location }
//   GET    /mine?status=open|closed|all&page=&pageSize=        → { requests, total, page, pageSize }
//   POST   /               multipart: title, description, categoryId, priority, location,
//                          requesterId (Super Admin only), photos[] (≤ 5)      → 201 { request }
//   GET    /:number                                            → { request }
//   POST   /:number/actions/:action  { note?, engineerId? }    → { request }
//          action = assign | start | wait_user | wait_equipment | resume | resolve | close | reject
//   PATCH  /:number        { priority?, categoryId? }  (Super Admin)           → { request }
//   POST   /:number/comments  multipart: note, internal, photos[]              → { request }
//   GET    /:number/engineers  (Super Admin: who can be assigned)              → { engineers }
//   GET    /:number/attachments/:attachmentId                  → the image (scope-checked)
// Phase 7 (lists; out-of-role = 404):
//   GET    /counts                         sidebar badges for the active role
//   GET    /engineers                      Super Admin: engineers tagged to AVIT
//   GET    /queue/work?group=active|to_start|in_progress|waiting|resolved   Engineer / Super Admin: assigned to me
//   GET    /queue/assign?view=unassigned|to_close                          Super Admin
//   GET    /all?q=&status=&priority=&categoryId=&engineerId=(id|none)&type=TICKET|SERVICE_REQUEST&sort=  Super Admin
// Phase 9 (service requests):
//   GET    /catalogue?includeInactive=1          catalogue (inactive: Super Admin)          → { items }
//   POST   /catalogue · PATCH /catalogue/:id     Super Admin                                → { item }
//   POST   /service   { items: [{ catalogueItemId? | name, quantity, reason }], location?, priority?, requesterId? } → 201 { request }
//   POST   /:number/items/decide   { decisions: [{ itemId, decision: approve|reject, note? }] }  Super Admin → { request }
//   POST   /:number/items/:itemId/deliver   { note?, assetTags? }   assigned engineer / Super Admin → { request }
const express = require('express');
const { query, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../../middleware/requireAuth');
const { photosField } = require('./attachments');
const lifecycle = require('./lifecycle');
const svc = require('./requests.service');
const sr = require('./serviceRequests.service');

const handle = (fn) => async (req, res, next) => {
  const err = validationResult(req).array({ onlyFirstError: true })[0];
  if (err) return res.status(400).json({ message: err.msg, code: 'invalid' });
  try {
    return await fn(req, res);
  } catch (e) {
    return next(e);
  }
};

function createRequestsRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/categories', handle(async (req, res) => res.json({ categories: await svc.listCategories() })));

  router.get(
    '/default-location',
    query('for').optional({ values: 'falsy' }).matches(/^\d{1,18}$/).withMessage('Bad person.'),
    handle(async (req, res) => res.json(await svc.defaultLocation(req.user, req.query.for)))
  );

  router.get(
    '/mine',
    query('status').optional({ values: 'falsy' }).isIn(['open', 'closed', 'all']).withMessage('Choose open, closed or all.'),
    query('page').optional().isInt({ min: 1, max: 100000 }).withMessage('Bad page.'),
    query('pageSize').optional().isInt({ min: 1, max: 100 }).withMessage('Bad page size.'),
    handle(async (req, res) => {
      const page = Number(req.query.page) || 1;
      const pageSize = Number(req.query.pageSize) || 20;
      const status = req.query.status || 'open';
      const result = await svc.listMine(req.user, {
        open: status === 'all' ? null : status === 'open',
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      res.json({ ...result, page, pageSize });
    })
  );

  // ---------- Phase 7: queues ----------
  const paging = [
    query('page').optional().isInt({ min: 1, max: 100000 }).withMessage('Bad page.'),
    query('pageSize').optional().isInt({ min: 1, max: 100 }).withMessage('Bad page size.'),
  ];
  const pageOf = (req, size = 25) => {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || size;
    return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
  };

  router.get('/counts', handle(async (req, res) => res.json({ counts: await svc.queueCounts(req.user) })));

  router.get('/engineers', handle(async (req, res) => res.json({ engineers: await svc.listEngineers(req.user) })));

  router.get(
    '/queue/work',
    ...paging,
    handle(async (req, res) => {
      const p = pageOf(req);
      const result = await svc.listWorkQueue(req.user, { group: req.query.group || 'active', ...p });
      res.json({ ...result, page: p.page, pageSize: p.pageSize });
    })
  );

  router.get(
    '/queue/assign',
    ...paging,
    handle(async (req, res) => {
      const p = pageOf(req);
      const result = await svc.listAssignQueue(req.user, { view: req.query.view || 'unassigned', ...p });
      res.json({ ...result, page: p.page, pageSize: p.pageSize });
    })
  );

  router.get(
    '/all',
    ...paging,
    handle(async (req, res) => {
      const p = pageOf(req);
      const { q, status, priority, categoryId, engineerId, type, sort } = req.query;
      const result = await svc.listAll(req.user, { q, status, priority, categoryId, engineerId, type, sort, ...p });
      res.json({ ...result, page: p.page, pageSize: p.pageSize });
    })
  );

  router.post(
    '/',
    photosField,
    handle(async (req, res) => {
      const request = await svc.createTicket(req.user, req.body || {}, req.files || []);
      res.status(201).json({ request });
    })
  );

  // ---------- Phase 9: catalogue + service requests ----------
  const admin = requireRole('SUPER_ADMIN');
  router.get('/catalogue', handle(async (req, res) => res.json({ items: await sr.listCatalogue(req.user, { includeInactive: req.query.includeInactive === '1' }) })));
  router.post('/catalogue', admin, handle(async (req, res) => res.status(201).json({ item: await sr.createCatalogueItem(req.user, req.body || {}) })));
  router.patch('/catalogue/:id', admin, handle(async (req, res) => res.json({ item: await sr.updateCatalogueItem(req.user, req.params.id, req.body || {}) })));
  router.post('/service', handle(async (req, res) => res.status(201).json({ request: await sr.createServiceRequest(req.user, req.body || {}) })));
  router.post('/:number/items/decide', handle(async (req, res) => res.json({ request: await sr.decideItems(req.user, req.params.number, req.body || {}) })));
  router.post(
    '/:number/items/:itemId/deliver',
    handle(async (req, res) => res.json({ request: await sr.deliverItem(req.user, req.params.number, req.params.itemId, req.body || {}) }))
  );

  router.get('/:number', handle(async (req, res) => res.json({ request: await svc.getTicket(req.user, req.params.number) })));

  router.post(
    '/:number/actions/:action',
    handle(async (req, res) => {
      if (!lifecycle.ACTION_KEYS.includes(req.params.action)) {
        return res.status(400).json({ message: 'Unknown action.', code: 'bad_action' });
      }
      const request = await svc.act(req.user, req.params.number, req.params.action, req.body || {});
      return res.json({ request });
    })
  );

  router.patch(
    '/:number',
    handle(async (req, res) => {
      const { priority, categoryId } = req.body || {};
      res.json({ request: await svc.triage(req.user, req.params.number, { priority, categoryId }) });
    })
  );

  router.post(
    '/:number/comments',
    photosField,
    handle(async (req, res) => {
      res.json({ request: await svc.comment(req.user, req.params.number, req.body || {}, req.files || []) });
    })
  );

  router.get(
    '/:number/engineers',
    handle(async (req, res) => res.json({ engineers: await svc.eligibleEngineers(req.user, req.params.number) }))
  );

  router.get(
    '/:number/attachments/:attachmentId',
    handle(async (req, res) => {
      const file = await svc.getAttachmentFile(req.user, req.params.number, req.params.attachmentId);
      res.set({
        'Content-Type': file.mimeType,
        'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      });
      res.sendFile(file.path, (err) => {
        if (err && !res.headersSent) res.status(404).json({ message: 'Not found.' });
      });
    })
  );

  return router;
}

module.exports = { createRequestsRouter };
