// /Atom/api/wifi — Jamea Internet Access (Wi-Fi passes) (AVIT only; other companies 404). See wifi.service.js.
//   GET    /me                                   → { isAdmin, hodDepartments }        anyone in AVIT (drives the menu)
//   GET    /lookup?its=                          → { its, name, mobile, email, source } Admin or HOD
//   HOD (their own department; else 404):
//   GET    /departments/:id                      → { batches, passes, requests }
//   POST   /departments/:id/requests  { count, reason }
//   POST   /batches/:id/assign  { departmentId?, people:[{ its?, name, mobile?, email?, count? }] }  (no departmentId = Admin direct)
//   POST   /passes/:id/unassign · POST /passes/:id/whatsapp · POST /passes/email { passIds }  (one email per address)
//   POST   /groups/:id/unassign                  passes given together: taken back together only (035)
//   AVIT Admin:
//   GET    /batches                              → { batches }
//   POST   /batches   multipart: file (.csv), name, ssid, expiresAt, commit?, skipErrors?   → preview | saved
//   GET    /batches/:id                          → { batch, departments }
//   POST   /batches/:id/allocate  { items:[{ departmentId, count }] }
//   POST   /batches/:id/move      { fromDepartmentId, toDepartmentId (null = unallocated), count }  unused passes only
//   POST   /batches/:id/reset                    → { summary }   deletes the passes now
//   GET    /batches/:id/passes?view=&q=&departmentId=&page=
//   GET    /requests · POST /requests/:id  { status: done|declined, note? }
//   Super Admin: GET /settings · PATCH /settings { hodPosts: [] }
//                PUT /settings/hods { person, departmentIds, kind: grant|revoke } · DELETE /settings/hods/:userId/:departmentId
const express = require('express');
const multer = require('multer');
const { requireAuth, requireCompany, requireCompanyCode, requireRole } = require('../../middleware/requireAuth');
const { HttpError } = require('../../utils/httpError');
const { feature, elevateIf } = require('../../middleware/features');
const svc = require('./wifi.service');

const handle = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res);
  } catch (e) {
    return next(e);
  }
};
// The AVIT Admin, or someone given Jamea Internet Access (Delegate access, 6 Nov 2026).
const admin = feature('wifi');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => (/\.csv$/i.test(file.originalname || '') ? cb(null, true) : cb(new HttpError(400, 'Choose a .csv file.', 'bad_file_type'))),
});
function csvField(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(400, 'The file must be 5 MB or smaller.', 'file_too_large'));
    return next(new HttpError(400, 'Could not read the upload.', 'bad_upload'));
  });
}
// Passwords are in these answers: never cache them.
const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

function createWifiRouter() {
  const router = express.Router();
  router.use(requireAuth, requireCompany, requireCompanyCode('AVIT'), noStore);

  router.get('/me', elevateIf('wifi'), handle(async (req, res) => res.json(await svc.me(req.user))));
  router.get('/lookup', elevateIf('wifi'), handle(async (req, res) => {
    const me = await svc.me(req.user);
    if (!me.isAdmin && !me.hodDepartments.length) throw new HttpError(404, 'Not found.');
    res.json(await svc.lookupIts(req.user, req.query.its));
  }));

  // HOD (checked per department in the service) and Admin
  router.get('/departments/:id', handle(async (req, res) => res.json(await svc.departmentView(req.user, req.params.id))));
  router.post('/departments/:id/requests', handle(async (req, res) => res.status(201).json(await svc.requestMore(req.user, req.params.id, req.body || {}))));
  router.post('/batches/:id/assign', elevateIf('wifi'), handle(async (req, res) => res.json(await svc.assign(req.user, req.params.id, req.body || {}))));
  router.post('/passes/email', elevateIf('wifi'), handle(async (req, res) => res.json(await svc.emailPasses(req.user, req.body?.passIds))));
  router.post('/passes/:id/unassign', elevateIf('wifi'), handle(async (req, res) => res.json(await svc.unassign(req.user, req.params.id))));
  router.post('/groups/:id/unassign', elevateIf('wifi'), handle(async (req, res) => res.json(await svc.unassignGroup(req.user, req.params.id))));
  router.post('/passes/:id/whatsapp', elevateIf('wifi'), handle(async (req, res) => res.json(await svc.markWhatsapp(req.user, req.params.id))));

  // AVIT Admin
  router.get('/batches', admin, handle(async (req, res) => res.json({ batches: await svc.listBatches(req.user) })));
  router.post('/batches', admin, csvField, handle(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Choose the .csv file.', 'no_file');
    res.json(await svc.uploadBatch(req.user, req.file.buffer, req.body || {}, String(req.file.originalname || '').slice(0, 200)));
  }));
  router.get('/batches/:id', admin, handle(async (req, res) => res.json(await svc.getBatch(req.user, req.params.id))));
  router.post('/batches/:id/allocate', admin, handle(async (req, res) => res.json(await svc.allocate(req.user, req.params.id, req.body?.items))));
  router.post('/batches/:id/move', admin, handle(async (req, res) => res.json(await svc.movePasses(req.user, req.params.id, req.body || {}))));
  router.post('/batches/:id/reset', admin, handle(async (req, res) => res.json(await svc.resetBatch(req.user, req.params.id))));
  router.get('/batches/:id/passes', admin, handle(async (req, res) => res.json(await svc.listPasses(req.user, req.params.id, req.query))));
  router.get('/requests', admin, handle(async (req, res) => res.json({ requests: await svc.listRequests(req.user) })));
  router.post('/requests/:id', admin, handle(async (req, res) => res.json({ requests: await svc.decideRequest(req.user, req.params.id, req.body || {}) })));

  router.get('/settings', requireRole('SUPER_ADMIN'), handle(async (req, res) => res.json(await svc.getSettings())));
  router.patch('/settings', requireRole('SUPER_ADMIN'), handle(async (req, res) => res.json(await svc.setHodPosts(req.user, req.body?.hodPosts))));
  router.put('/settings/hods', requireRole('SUPER_ADMIN'), handle(async (req, res) => res.json(await svc.setHodAccess(req.user, req.body || {}))));
  router.delete('/settings/hods/:userId/:departmentId', requireRole('SUPER_ADMIN'), handle(async (req, res) =>
    res.json(await svc.clearHodAccess(req.user, req.params.userId, req.params.departmentId))));
  return router;
}

module.exports = { createWifiRouter };
