// /Atom/api/assistant — Phase 12.
//   Everyone (signed in):
//     GET  /config                          → { languages, uiText, guidelines, tree }   browse tree + texts
//     POST /sessions          { language }  → 201 { session }
//     POST /sessions/:id/ask  { text }      → { type: 'answer', via, faq } | { type: 'choices', via, faqs } | { type: 'none' }
//     POST /sessions/:id/show { faqId, via: 'browse'|'choice' } → { faq }
//     POST /sessions/:id/feedback { solved } → { session } (+ draft when not solved)
//     GET  /sessions/:id/draft              → { draft }   pre-filled ticket
//   Super Admin:
//     GET  /faqs?includeInactive=1 · GET /faqs/:id · POST /faqs · PATCH /faqs/:id
//     POST /faqs/import   multipart: file (.json), commit?, keepAtomEdits?   → report
//     GET  /settings · PATCH /settings     GPT switch, model, temperature, token limits, prices
//     GET  /usage?days=30                   tokens, cost, sessions, unanswered questions
// Sessions belong to their user; anyone else's = 404. Out of role = 404.
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireRole } = require('../../middleware/requireAuth');
const { HttpError } = require('../../utils/httpError');
const svc = require('./assistant.service');
const faqs = require('./faqAdmin.service');

const handle = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res);
  } catch (e) {
    return next(e);
  }
};
const yes = (v) => v === true || v === 'true' || v === '1';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 },
  fileFilter: (req, file, cb) =>
    /\.json$/i.test(file.originalname || '') ? cb(null, true) : cb(new HttpError(400, 'Choose the FAQ .json file.', 'bad_file_type')),
});
function jsonFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(400, 'The file must be 5 MB or smaller.', 'file_too_large'));
    return next(new HttpError(400, 'Could not read the upload.', 'bad_upload'));
  });
}

// Typed questions: 30 a minute per person is far more than anyone types.
const askLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `assistant:${req.user.id}`,
  message: { message: 'Too many questions in a minute. Please wait a moment.' },
});

function createAssistantRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/config', handle(async (req, res) => res.json(await svc.getConfig())));
  router.post('/sessions', handle(async (req, res) => res.status(201).json({ session: await svc.startSession(req.user, req.body || {}) })));
  router.post('/sessions/:id/ask', askLimit, handle(async (req, res) => res.json(await svc.ask(req.user, req.params.id, req.body || {}))));
  router.post('/sessions/:id/show', handle(async (req, res) => res.json(await svc.show(req.user, req.params.id, req.body || {}))));
  router.post('/sessions/:id/feedback', handle(async (req, res) => res.json(await svc.feedback(req.user, req.params.id, req.body || {}))));
  router.get('/sessions/:id/draft', handle(async (req, res) => res.json(await svc.draft(req.user, req.params.id))));

  const admin = requireRole('SUPER_ADMIN');
  router.get('/faqs', admin, handle(async (req, res) => res.json({ faqs: await faqs.listFaqs({ includeInactive: yes(req.query.includeInactive) }) })));
  router.get('/faqs/:id', admin, handle(async (req, res) => res.json({ faq: await faqs.getFaq(req.params.id) })));
  router.post('/faqs', admin, handle(async (req, res) => res.status(201).json({ faq: await faqs.createFaq(req.user, req.body || {}) })));
  router.patch('/faqs/:id', admin, handle(async (req, res) => res.json({ faq: await faqs.updateFaq(req.user, req.params.id, req.body || {}) })));
  router.post(
    '/faqs/import',
    admin,
    jsonFile,
    handle(async (req, res) => {
      if (!req.file) throw new HttpError(400, 'Choose the FAQ .json file.', 'no_file');
      res.json(await faqs.importFaqFile(req.file.buffer, { commit: yes(req.body?.commit), keepAtomEdits: req.body?.keepAtomEdits !== 'false' }));
    })
  );
  router.get('/settings', admin, handle(async (req, res) => res.json({ settings: await svc.getSettings() })));
  router.patch('/settings', admin, handle(async (req, res) => res.json({ settings: await svc.updateSettings(req.user, req.body || {}) })));
  router.get('/usage', admin, handle(async (req, res) => res.json(await svc.usage({ days: req.query.days }))));

  return router;
}

module.exports = { createAssistantRouter };
