// /Atom/api/assistant — Phase 12; one assistant per company since step C (30 Oct 2026). Everything is
// the active company's: its FAQs, problem list, chats and saved answers (another company's = 404).
// GPT settings, limits and usage are global: Super Admin only. The Super Admin switches each company's
// assistant on or off; when off its chat routes answer 404 (FAQ editing still works).
//   Everyone (signed in, in a company whose assistant is on):
//     GET  /config                          → { company, mode, languages, uiText, guidelines, tree }
//     POST /sessions          { language }  → 201 { session }
//     POST /sessions/:id/ask  { text }      → { type: 'answer', via, faq } | { type: 'problem', via, problem }
//                                             | { type: 'choices', via, faqs } | { type: 'catalogue', via, items } | { type: 'none' }
//     POST /sessions/:id/show { faqId | problemId, via: 'browse'|'choice' } → { faq } | { problem }
//     POST /sessions/:id/request { catalogueItemIds } → { session, catalogueItemIds }   (Tanzeem → Request page)
//     POST /sessions/:id/feedback { solved } → { session } (+ draft when not solved)
//     GET  /sessions/:id/draft              → { draft }   pre-filled ticket (category, item, problem)
//   Admin of the company (or the Super Admin inside it):
//     GET  /faqs?includeInactive=1 · GET /faqs/:id · POST /faqs · PATCH /faqs/:id
//     POST /faqs/import   multipart: file (.json), commit?, keepAtomEdits?   → report
//     GET  /learned?includeOff=1 · PATCH /learned/:id { isActive }   saved GPT answers
//     GET  /guidelines · PUT /guidelines { guidelines: { en: [..], … } }   "Before you start" tips
//   Super Admin (any company or none):
//     GET  /settings · PATCH /settings     GPT switch, model, temperature, token limits, prices
//     GET  /usage?days=30&company=CODE      tokens, cost, sessions, unanswered questions; per company
//     GET  /companies · PATCH /companies/:code { enabled }   each company's assistant on / off
//     POST /unmatched/dismiss  { key }      hide a question from "Questions with no FAQ"
// Sessions belong to their user; anyone else's = 404. Out of role = 404.
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireRole, requireCompany, requireAdmin } = require('../../middleware/requireAuth');
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

  // Global (Super Admin): GPT settings, usage, unanswered questions.
  const superAdmin = requireRole('SUPER_ADMIN');
  router.get('/settings', superAdmin, handle(async (req, res) => res.json({ settings: await svc.getSettings() })));
  router.patch('/settings', superAdmin, handle(async (req, res) => res.json({ settings: await svc.updateSettings(req.user, req.body || {}) })));
  router.post('/unmatched/dismiss', superAdmin, handle(async (req, res) => res.json(await svc.dismissQuestion(req.user, req.body || {}))));
  router.get('/usage', superAdmin, handle(async (req, res) => res.json(await svc.usage({ days: req.query.days, company: req.query.company || null }))));
  router.get('/companies', superAdmin, handle(async (req, res) => res.json({ companies: await svc.companies() })));
  router.patch('/companies/:code', superAdmin, handle(async (req, res) => res.json({ companies: await svc.setCompanyAssistant(req.user, req.params.code, req.body || {}) })));

  // Everything else: inside a company.
  router.use(requireCompany);
  // Chat: only while the company's assistant is switched on.
  const assistantOn = (req, res, next) =>
    svc
      .assistantOn(req.user.companyId)
      .then((on) => (on ? next() : res.status(404).json({ message: 'Not found.' })))
      .catch(next);

  router.get('/config', assistantOn, handle(async (req, res) => res.json(await svc.getConfig(req.user))));
  router.post('/sessions', assistantOn, handle(async (req, res) => res.status(201).json({ session: await svc.startSession(req.user, req.body || {}) })));
  router.use('/sessions', assistantOn);
  router.post('/sessions/:id/request', handle(async (req, res) => res.json(await svc.toRequest(req.user, req.params.id, req.body || {}))));
  router.post('/sessions/:id/ask', askLimit, handle(async (req, res) => res.json(await svc.ask(req.user, req.params.id, req.body || {}))));
  router.post('/sessions/:id/show', handle(async (req, res) => res.json(await svc.show(req.user, req.params.id, req.body || {}))));
  router.post('/sessions/:id/feedback', handle(async (req, res) => res.json(await svc.feedback(req.user, req.params.id, req.body || {}))));
  router.get('/sessions/:id/draft', handle(async (req, res) => res.json(await svc.draft(req.user, req.params.id))));

  const admin = requireAdmin;
  router.get('/faqs', admin, handle(async (req, res) => res.json({ faqs: await faqs.listFaqs(req.user, { includeInactive: yes(req.query.includeInactive) }) })));
  router.get('/faqs/:id', admin, handle(async (req, res) => res.json({ faq: await faqs.getFaq(req.user, req.params.id) })));
  router.post('/faqs', admin, handle(async (req, res) => res.status(201).json({ faq: await faqs.createFaq(req.user, req.body || {}) })));
  router.patch('/faqs/:id', admin, handle(async (req, res) => res.json({ faq: await faqs.updateFaq(req.user, req.params.id, req.body || {}) })));
  router.post(
    '/faqs/import',
    admin,
    jsonFile,
    handle(async (req, res) => {
      if (!req.file) throw new HttpError(400, 'Choose the FAQ .json file.', 'no_file');
      res.json(await faqs.importFaqFile(req.user, req.file.buffer, { commit: yes(req.body?.commit), keepAtomEdits: req.body?.keepAtomEdits !== 'false' }));
    })
  );
  router.get('/guidelines', admin, handle(async (req, res) => res.json(await svc.getGuidelines(req.user))));
  router.put('/guidelines', admin, handle(async (req, res) => res.json(await svc.setGuidelines(req.user, req.body || {}))));
  router.get('/learned', admin, handle(async (req, res) => res.json({ learned: await svc.listLearned(req.user, { includeOff: yes(req.query.includeOff) }) })));
  router.patch('/learned/:id', admin, handle(async (req, res) => res.json({ learned: await svc.setLearned(req.user, req.params.id, req.body || {}) })));

  return router;
}

module.exports = { createAssistantRouter };
