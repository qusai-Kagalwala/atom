// AI assistant chat (Phase 12). Cheapest first:
//   1. browse buttons (category → item → problem)       no AI
//   2. typed text → local matching (matcher.js)           no AI
//   3. GPT picks an FAQ — only if 1–2 found nothing, GPT is switched on, and under every limit
//   (2½) saved GPT answers: a question GPT already sorted is answered from the database, no tokens
// Answers are always the FAQ's own text. "Did this solve it?" → yes: solved, no: pre-filled ticket.
// Every session, step and GPT call is recorded; the session is linked to the ticket if one is raised.
const defaultPool = require('../../db/pool');
const { config } = require('../../config/env');
const { HttpError, notFound } = require('../../utils/httpError');
const { LANGS, clean } = require('./faqData');
const { buildIndex, match, matchKey, keySimilarity } = require('./matcher');
const gpt = require('./gpt');

const bad = (message, code) => new HttpError(400, message, code);
const isId = (v) => /^\d{1,18}$/.test(String(v ?? ''));
const MAX_TEXT = 500;
const GPT_PER_SESSION = 3;
const CACHE_MS = 60_000;

let deps = { pool: defaultPool, classify: gpt.classify };
// Tests swap the DB pool / GPT call.
function setDeps(next) {
  deps = { ...deps, ...next };
  bust();
}

// ---------- per-company cache (FAQs, problem list, Tanzeem catalogue; refreshed every minute and after
// any change). Each company has its own assistant (step C, 30 Oct 2026). ----------
// Index ids are prefixed: f<FAQ id> · p<problem id> (a problem with no FAQ) · c<catalogue item id>.
const MODE = { TANZEEM: 'request' }; // Tanzeem: things are mostly requested, tickets only for replacements
const MAX_GPT_OPTIONS = 700;
const caches = new Map();
function bust(companyId) {
  if (companyId == null) caches.clear();
  else caches.delete(String(companyId));
}

async function companyCache(companyId) {
  const key = String(companyId);
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const db = deps.pool;
  const [unit, faqs, problems] = await Promise.all([
    db.query('SELECT id::text AS id, code, name, tagline, assistant_enabled FROM service_units WHERE id = $1::bigint', [companyId]),
    db.query(
      `SELECT f.id::text AS id, f.item_id, f.category, f.item, f.sub_item, f.keywords, f.direct_ticket, f.answers,
              f.details_en, f.ticket_info, f.ticket_category_id::text AS ticket_category_id, c.name AS ticket_category,
              f.ticket_problem_id::text AS ticket_problem_id
         FROM faqs f LEFT JOIN categories c ON c.id = f.ticket_category_id
        WHERE f.is_active AND f.service_unit_id = $1::bigint ORDER BY f.category, f.item, f.item_id`,
      [companyId]
    ),
    db.query(
      `SELECT p.id::text AS id, p.name, i.id::text AS item_id, i.name AS item, c.id::text AS category_id, c.name AS category
         FROM ticket_problems p
         JOIN ticket_items i ON i.id = p.item_id AND i.is_active
         JOIN categories c ON c.id = i.category_id AND c.is_active
        WHERE p.service_unit_id = $1::bigint AND p.is_active
        ORDER BY c.sort_order, lower(c.name), i.sort_order, lower(i.name), p.sort_order, lower(p.name)`,
      [companyId]
    ),
  ]);
  const company = unit.rows[0] || null;
  const mode = MODE[company?.code] || 'ticket';
  const catalogue = mode === 'request'
    ? (await db.query(
        `SELECT id::text AS id, name, group_name, kind, price, pack_size FROM catalogue_items
          WHERE service_unit_id = $1::bigint AND is_active ORDER BY sort_order, lower(group_name) NULLS FIRST, lower(name)`,
        [companyId]
      )).rows
    : [];

  const rows = faqs.rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const probById = new Map(problems.rows.map((p) => [p.id, p]));
  const faqByProblem = new Map();
  for (const r of rows) if (r.ticket_problem_id && probById.has(r.ticket_problem_id) && !faqByProblem.has(r.ticket_problem_id)) faqByProblem.set(r.ticket_problem_id, r);
  const loneProblems = problems.rows.filter((p) => !faqByProblem.has(p.id));
  const catById = new Map(catalogue.map((x) => [x.id, x]));
  const questions = (r) => Object.fromEntries(Object.entries(r.answers || {}).map(([l, a]) => [l, a.question]));
  const index = buildIndex([
    ...rows.map((r) => ({ id: `f${r.id}`, item: r.item, subItem: r.sub_item, keywords: r.keywords, questions: questions(r) })),
    ...loneProblems.map((p) => ({ id: `p${p.id}`, item: p.item, subItem: p.name, keywords: [`${p.item} ${p.name}`], questions: {} })),
    ...catalogue.map((x) => ({ id: `c${x.id}`, item: x.name, subItem: x.group_name || '', keywords: [x.name], questions: {} })),
  ]);
  const built = { at: Date.now(), company, mode, rows, byId, probById, faqByProblem, loneProblems, catalogue, catById, index };
  caches.set(key, built);
  return built;
}

// Route guard: the company's assistant is switched on (Super Admin). Off = 404.
async function assistantOn(companyId) {
  if (!companyId) return false;
  const c = await companyCache(companyId);
  return Boolean(c.company?.assistant_enabled);
}

const tidy = (s) => String(s || '').replace(/\s*\(specify in description\)\s*/i, '').trim();
const pick = (answers, lang) => (answers?.[lang] ? { lang, a: answers[lang] } : { lang: 'en', a: answers?.en || {} });

function brief(r, lang) {
  const { a } = pick(r.answers, lang);
  return { id: r.id, category: r.category, item: r.item, subItem: tidy(r.sub_item), question: a.question || '' };
}
function full(r, lang) {
  const { lang: used, a } = pick(r.answers, lang);
  return {
    ...brief(r, lang),
    language: used,
    steps: a.steps || [],
    raiseTicket: a.raise_ticket || '',
    details: r.details_en || [],
    directTicket: r.direct_ticket,
  };
}

// ---------- settings ----------
const SETTINGS_FIELDS = {
  gptEnabled: 'gpt_enabled',
  model: 'model',
  temperature: 'temperature',
  dailyTokenLimit: 'daily_token_limit',
  monthlyTokenLimit: 'monthly_token_limit',
  userDailyCalls: 'user_daily_calls',
  priceInPerM: 'price_in_per_m',
  priceOutPerM: 'price_out_per_m',
};
// The one settings row (re-created with defaults if it is ever missing).
async function settingsRow(db = deps.pool) {
  const { rows } = await db.query('SELECT * FROM assistant_settings WHERE id = 1');
  if (rows[0]) return rows[0];
  await db.query('INSERT INTO assistant_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  return (await db.query('SELECT * FROM assistant_settings WHERE id = 1')).rows[0];
}
function toSettings(s) {
  return {
    gptEnabled: s.gpt_enabled,
    model: s.model,
    temperature: Number(s.temperature),
    dailyTokenLimit: s.daily_token_limit,
    monthlyTokenLimit: s.monthly_token_limit,
    userDailyCalls: s.user_daily_calls,
    priceInPerM: Number(s.price_in_per_m),
    priceOutPerM: Number(s.price_out_per_m),
    keyConfigured: Boolean(config.openai.apiKey),
    updatedAt: s.updated_at,
  };
}

// Day / month start in the app time zone (India), as SQL fragments with $1 = time zone.
const DAY_START = `(date_trunc('day', now() AT TIME ZONE $1::text) AT TIME ZONE $1::text)`;
const MONTH_START = `(date_trunc('month', now() AT TIME ZONE $1::text) AT TIME ZONE $1::text)`;

async function spend(db, userId) {
  const { rows } = await db.query(
    `SELECT COALESCE(sum(total_tokens) FILTER (WHERE created_at >= ${DAY_START}), 0)::bigint   AS day_tokens,
            COALESCE(sum(total_tokens) FILTER (WHERE created_at >= ${MONTH_START}), 0)::bigint AS month_tokens,
            count(*) FILTER (WHERE created_at >= ${DAY_START} AND user_id = $2::bigint)::int     AS user_calls
       FROM assistant_gpt_calls WHERE created_at >= ${MONTH_START}`,
    [config.timeZone, userId]
  );
  return { dayTokens: Number(rows[0].day_tokens), monthTokens: Number(rows[0].month_tokens), userCalls: rows[0].user_calls };
}

// null = GPT may be called; otherwise the reason it is skipped.
async function gptBlocked(db, s, user, session) {
  if (!s.gpt_enabled) return 'switched_off';
  if (!config.openai.apiKey) return 'no_key';
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM assistant_events WHERE session_id = $1::bigint AND kind = 'gpt'`, [session.id]);
  if (rows[0].n >= GPT_PER_SESSION) return 'session_limit';
  const used = await spend(db, user.id);
  if (used.monthTokens >= s.monthly_token_limit) return 'monthly_limit';
  if (used.dayTokens >= s.daily_token_limit) return 'daily_limit';
  if (used.userCalls >= s.user_daily_calls) return 'user_limit';
  return null;
}

// ---------- sessions ----------
async function addEvent(db, sessionId, kind, { text = null, faqId = null, problemId = null, data = null } = {}) {
  await db.query(
    `INSERT INTO assistant_events (session_id, kind, text, faq_id, ticket_problem_id, data)
     VALUES ($1::bigint, $2::text, $3::text, $4::bigint, $5::bigint, $6::jsonb)`,
    [sessionId, kind, text, faqId, problemId, data ? JSON.stringify(data) : null]
  );
}

// The person's own session, in the company they are in now. Anything else = 404.
async function ownSession(db, user, id, { open = true } = {}) {
  if (!isId(id)) throw notFound();
  const { rows } = await db.query(
    'SELECT * FROM assistant_sessions WHERE id = $1::bigint AND user_id = $2::bigint AND service_unit_id = $3::bigint',
    [id, user.id, user.companyId]
  );
  const s = rows[0];
  if (!s) throw notFound();
  if (open && s.status !== 'OPEN') throw new HttpError(409, 'This chat has ended. Start a new one.', 'session_ended');
  return s;
}

const toSession = (s) => ({ id: String(s.id), language: s.language, status: s.status, requestId: s.request_id ? String(s.request_id) : null });

// Browse tree: the company's problem list (category → item → problem), each problem with its FAQ when
// it has one; FAQs not linked to a problem are added under their own category and item.
function browseTree(c) {
  const tree = [];
  const node = (category, item) => {
    let cat = tree.find((t) => t.category === category);
    if (!cat) tree.push((cat = { category, items: [] }));
    let it = cat.items.find((i) => i.item === item);
    if (!it) cat.items.push((it = { item, faqs: [] }));
    return it;
  };
  const questions = (r) => (r ? Object.fromEntries(Object.entries(r.answers || {}).map(([l, a]) => [l, a.question])) : {});
  for (const p of c.probById.values()) {
    const faq = c.faqByProblem.get(p.id) || null;
    node(p.category, p.item).faqs.push({ id: faq ? faq.id : null, problemId: p.id, subItem: tidy(p.name), questions: questions(faq) });
  }
  const linked = new Set([...c.faqByProblem.values()].map((r) => r.id));
  for (const r of c.rows) {
    if (linked.has(r.id)) continue;
    node(r.category, r.item).faqs.push({ id: r.id, problemId: null, subItem: tidy(r.sub_item), questions: questions(r) });
  }
  return tree;
}

async function getConfig(user) {
  const c = await companyCache(user.companyId);
  const s = await settingsRow();
  const content = s.content || {};
  return {
    company: { code: c.company?.code, name: c.company?.name, tagline: c.company?.tagline || null },
    // 'ticket': not solved → raise a ticket · 'request': mostly the Request page; a ticket only for replacements
    mode: c.mode,
    languages: content.languages?.length
      ? content.languages
      : [{ code: 'en', name: 'English', nativeName: 'English', direction: 'ltr' }],
    uiText: content.uiText || {},
    guidelines: content.guidelines || {},
    tree: browseTree(c),
  };
}

async function startSession(user, { language } = {}) {
  const lang = LANGS.includes(language) ? language : 'en';
  const { rows } = await deps.pool.query(
    'INSERT INTO assistant_sessions (user_id, language, service_unit_id) VALUES ($1::bigint, $2::text, $3::bigint) RETURNING *',
    [user.id, lang, user.companyId]
  );
  return toSession(rows[0]);
}

async function setShown(db, session, faqId, via) {
  await db.query(
    `UPDATE assistant_sessions SET faq_id = $2::bigint, matched_by = $3::text WHERE id = $1::bigint`,
    [session.id, faqId, via]
  );
  await addEvent(db, session.id, 'shown', { faqId, data: { via } });
}

// A problem of the list with no FAQ: the ticket draft is filled in from it.
async function setPicked(db, session, problemId, via) {
  await db.query(
    `UPDATE assistant_sessions SET ticket_problem_id = $2::bigint, faq_id = NULL, matched_by = $3::text WHERE id = $1::bigint`,
    [session.id, problemId, via]
  );
  await addEvent(db, session.id, 'picked', { problemId, data: { via } });
}

const toProblem = (p) => ({ id: p.id, category: p.category, item: p.item, problem: tidy(p.name) });
const toCatalogue = (x) => ({
  id: x.id,
  name: x.name,
  group: x.group_name || null,
  kind: x.kind,
  price: x.price == null ? null : Number(x.price),
  packSize: x.pack_size ?? null,
});

// One entry of a "Did you mean…" list (FAQ, problem or catalogue item).
function option(c, key, lang) {
  const id = key.slice(1);
  if (key[0] === 'f') return { kind: 'faq', ...brief(c.byId.get(id), lang) };
  if (key[0] === 'p') {
    const p = c.probById.get(id);
    return { kind: 'problem', id: null, problemId: p.id, category: p.category, item: p.item, subItem: tidy(p.name), question: `${p.item} – ${tidy(p.name)}` };
  }
  const x = c.catById.get(id);
  return { kind: 'catalogue', id: null, catalogueItemId: x.id, category: x.group_name || '', item: x.name, subItem: x.group_name || '', question: x.name, item_: toCatalogue(x) };
}
const known = (c, key) =>
  (key[0] === 'f' && c.byId.has(key.slice(1))) || (key[0] === 'p' && c.probById.has(key.slice(1))) || (key[0] === 'c' && c.catById.has(key.slice(1)));
// GPT and saved answers may give plain FAQ ids (older rows): treat them as FAQ ids.
const asKey = (v) => (/^\d+$/.test(String(v)) ? `f${v}` : String(v));

async function companyCategories(db, companyId) {
  const { rows } = await db.query(
    'SELECT id::text AS id, name FROM categories WHERE service_unit_id = $1::bigint AND is_active ORDER BY sort_order, name',
    [companyId]
  );
  return rows;
}

async function ask(user, sessionId, body = {}) {
  const db = deps.pool;
  const text = clean(body.text);
  if (!text) throw bad('Type your problem.', 'empty');
  if (text.length > MAX_TEXT) throw bad(`Keep it under ${MAX_TEXT} characters.`, 'too_long');
  const session = await ownSession(db, user, sessionId);
  const lang = session.language;
  const c = await companyCache(session.service_unit_id);

  await addEvent(db, session.id, 'typed', { text });
  if (!session.first_text) await db.query('UPDATE assistant_sessions SET first_text = $2::text WHERE id = $1::bigint', [session.id, text]);

  const local = match(c.index, text, lang);
  if (local.kind === 'answer') return respond(db, session, c, [local.faqId], 'search', text);
  if (local.kind === 'choices') return respond(db, session, c, local.hits.map((h) => h.faqId), 'search', text, { many: true });

  // Nothing local. A saved GPT answer for the same question (in this company)?
  const key = matchKey(text);
  const saved = await findLearned(db, session.service_unit_id, key, c);
  if (saved) {
    await db.query('UPDATE assistant_learned SET hits = hits + 1, last_used_at = now() WHERE id = $1::bigint', [saved.row.id]);
    await addEvent(db, session.id, 'learned', { data: { learnedId: String(saved.row.id), suggestion: saved.row.suggestion } });
    return respond(db, session, c, saved.keys, 'learned', text);
  }

  // GPT, if allowed.
  const s = await settingsRow(db);
  const blocked = await gptBlocked(db, s, user, session);
  if (blocked) {
    await addEvent(db, session.id, 'gpt_skipped', { data: { reason: blocked } });
    await addEvent(db, session.id, 'no_match', { text });
    return { type: 'none' };
  }

  const cats = await companyCategories(db, session.service_unit_id);
  const options = [
    ...c.rows.map((r) => ({ id: `f${r.id}`, category: r.category, item: r.item, subItem: tidy(r.sub_item) })),
    ...c.loneProblems.map((p) => ({ id: `p${p.id}`, category: p.category, item: p.item, subItem: tidy(p.name) })),
    ...c.catalogue.map((x) => ({ id: `c${x.id}`, category: x.group_name || 'Catalogue', item: x.name, subItem: 'request' })),
  ].slice(0, MAX_GPT_OPTIONS);
  let result;
  let callId;
  try {
    result = await deps.classify({
      text,
      faqs: options,
      categories: cats.map((x) => x.name),
      model: s.model,
      temperature: s.temperature,
      company: c.company ? { name: c.company.name, tagline: c.company.tagline } : null,
    });
    const cost = gpt.costUsd(result.usage, s.price_in_per_m, s.price_out_per_m);
    const { rows } = await db.query(
      `INSERT INTO assistant_gpt_calls (session_id, user_id, service_unit_id, model, status, prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, result)
       VALUES ($1::bigint, $2::bigint, $3::bigint, $4::text, 'ok', $5::int, $6::int, $7::int, $8::numeric, $9::int, $10::jsonb) RETURNING id`,
      [session.id, user.id, session.service_unit_id, s.model, result.usage.prompt_tokens, result.usage.completion_tokens, result.usage.total_tokens, cost,
        result.latencyMs, JSON.stringify(result.suggestion)]
    );
    callId = String(rows[0].id);
  } catch (err) {
    if (!(err instanceof gpt.GptError)) throw err;
    const { rows } = await db.query(
      `INSERT INTO assistant_gpt_calls (session_id, user_id, service_unit_id, model, status, error)
       VALUES ($1::bigint, $2::bigint, $3::bigint, $4::text, 'error', $5::text) RETURNING id`,
      [session.id, user.id, session.service_unit_id, s.model, err.message.slice(0, 300)]
    );
    console.error(`[ATOM] Assistant GPT call failed: ${err.message}`);
    await addEvent(db, session.id, 'gpt', { data: { callId: String(rows[0].id), error: true } });
    await addEvent(db, session.id, 'no_match', { text });
    return { type: 'none' };
  }

  const sug = result.suggestion;
  const keys = sug.faqIds.map(asKey).filter((k) => known(c, k));
  const suggestion = {
    category: sug.category,
    categoryId: cats.find((x) => x.name === sug.category)?.id || null,
    priority: sug.priority,
    title: sug.title,
    catalogueIds: keys.filter((k) => k[0] === 'c').map((k) => k.slice(1)),
  };
  await db.query('UPDATE assistant_sessions SET used_gpt = TRUE WHERE id = $1::bigint', [session.id]);
  await addEvent(db, session.id, 'gpt', { data: { callId, suggestion } });

  // Save it, so the same question never goes to GPT again in this company (unless switched off).
  if (key) {
    await db.query(
      `INSERT INTO assistant_learned (service_unit_id, match_key, sample_text, language, faq_ids, problem_ids, suggestion, source_call_id)
       VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::bigint[], $6::bigint[], $7::jsonb, $8::bigint)
       ON CONFLICT (service_unit_id, match_key) DO UPDATE
          SET faq_ids = EXCLUDED.faq_ids, problem_ids = EXCLUDED.problem_ids, suggestion = EXCLUDED.suggestion,
              source_call_id = EXCLUDED.source_call_id, sample_text = EXCLUDED.sample_text, language = EXCLUDED.language,
              is_active = TRUE, hits = 0, last_used_at = NULL`,
      [session.service_unit_id, key, text, lang,
        keys.filter((k) => k[0] === 'f').map((k) => k.slice(1)), keys.filter((k) => k[0] === 'p').map((k) => k.slice(1)),
        JSON.stringify(suggestion), callId]
    );
  }
  return respond(db, session, c, keys, 'gpt', text);
}

// Show what was found: one FAQ (answer), one problem with no FAQ (→ ticket), or a list to choose from.
// Catalogue items (Tanzeem) are always offered as a list with "Request".
async function respond(db, session, c, keys, via, text, { many = false } = {}) {
  const lang = session.language;
  if (keys.length === 1 && !many && keys[0][0] === 'f') {
    const r = c.byId.get(keys[0].slice(1));
    await setShown(db, session, r.id, via);
    return { type: 'answer', via, faq: full(r, lang) };
  }
  if (keys.length === 1 && !many && keys[0][0] === 'p') {
    const p = c.probById.get(keys[0].slice(1));
    await setPicked(db, session, p.id, via);
    return { type: 'problem', via, problem: toProblem(p) };
  }
  if (keys.length) {
    const list = keys.map((k) => option(c, k, lang));
    const cat = list.filter((o) => o.kind === 'catalogue');
    if (cat.length) {
      await addEvent(db, session.id, 'catalogue', { data: { catalogueItemIds: cat.map((o) => o.catalogueItemId), via } });
      if (cat.length === list.length) return { type: 'catalogue', via, items: cat.map((o) => o.item_) };
    } else {
      await addEvent(db, session.id, 'choices', { data: { options: keys, via } });
    }
    return { type: 'choices', via, faqs: list.map(({ item_, ...o }) => (o.kind === 'catalogue' ? { ...o, catalogueItem: item_ } : o)) };
  }
  await addEvent(db, session.id, 'no_match', { text });
  return { type: 'none' };
}

// Saved GPT answer for this question in this company: same key, or the same words with a small typo.
// A saved answer whose picks have all been switched off is ignored (GPT is asked again).
const LEARNED_SIMILARITY = 0.8;
async function findLearned(db, companyId, key, c) {
  if (!key) return null;
  let { rows } = await db.query(
    'SELECT * FROM assistant_learned WHERE service_unit_id = $1::bigint AND match_key = $2::text AND is_active',
    [companyId, key]
  );
  if (!rows[0]) {
    const { rows: keys } = await db.query(
      `SELECT id, match_key FROM assistant_learned WHERE service_unit_id = $1::bigint AND is_active
        ORDER BY last_used_at DESC NULLS LAST, id DESC LIMIT 2000`,
      [companyId]
    );
    let best = null;
    for (const k of keys) {
      const sim = keySimilarity(key, k.match_key);
      if (sim >= LEARNED_SIMILARITY && (!best || sim > best.sim)) best = { id: k.id, sim };
    }
    if (!best) return null;
    ({ rows } = await db.query('SELECT * FROM assistant_learned WHERE id = $1::bigint', [best.id]));
  }
  const row = rows[0];
  const all = [
    ...(row.faq_ids || []).map((id) => `f${id}`),
    ...(row.problem_ids || []).map((id) => `p${id}`),
    ...(row.suggestion?.catalogueIds || []).map((id) => `c${id}`),
  ];
  const keys = all.filter((k) => known(c, k));
  if (all.length && !keys.length) return null;
  return { row, keys };
}

// Picked from the browse buttons or from "Did you mean…": an FAQ (faqId) or a problem with no FAQ (problemId).
async function show(user, sessionId, body = {}) {
  const db = deps.pool;
  const session = await ownSession(db, user, sessionId);
  const via = body.via === 'choice' ? 'choice' : 'browse';
  const c = await companyCache(session.service_unit_id);
  if (body.problemId != null && body.faqId == null) {
    const p = isId(body.problemId) ? c.probById.get(String(body.problemId)) : null;
    if (!p) throw bad('That problem is not available.', 'bad_problem');
    const faq = c.faqByProblem.get(p.id);
    if (faq) {
      await setShown(db, session, faq.id, via);
      await db.query('UPDATE assistant_sessions SET ticket_problem_id = $2::bigint WHERE id = $1::bigint', [session.id, p.id]);
      return { faq: full(faq, session.language) };
    }
    await setPicked(db, session, p.id, via);
    return { problem: toProblem(p) };
  }
  const r = isId(body.faqId) ? c.byId.get(String(body.faqId)) : null;
  if (!r) throw bad('That problem is not available.', 'bad_faq');
  await setShown(db, session, r.id, via);
  return { faq: full(r, session.language) };
}

// Tanzeem: the person goes to the Request page (with the chosen catalogue items). The chat ends.
async function toRequest(user, sessionId, body = {}) {
  const db = deps.pool;
  const session = await ownSession(db, user, sessionId);
  const c = await companyCache(session.service_unit_id);
  const ids = (Array.isArray(body.catalogueItemIds) ? body.catalogueItemIds : []).map(String).slice(0, 10);
  if (ids.some((id) => !c.catById.has(id))) throw bad('That item is not available.', 'bad_item');
  await addEvent(db, session.id, 'request', { data: { catalogueItemIds: ids } });
  const { rows } = await db.query(`UPDATE assistant_sessions SET status = 'CLOSED', ended_at = now() WHERE id = $1::bigint RETURNING *`, [session.id]);
  return { session: toSession(rows[0]), catalogueItemIds: ids };
}

async function feedback(user, sessionId, body = {}) {
  const db = deps.pool;
  const session = await ownSession(db, user, sessionId);
  if (body.solved === true) {
    await addEvent(db, session.id, 'solved', { faqId: session.faq_id });
    const { rows } = await db.query(
      `UPDATE assistant_sessions SET status = 'SOLVED', ended_at = now() WHERE id = $1::bigint RETURNING *`,
      [session.id]
    );
    return { session: toSession(rows[0]) };
  }
  await addEvent(db, session.id, 'not_solved', { faqId: session.faq_id });
  return { session: toSession(session), draft: await buildDraft(db, session) };
}

// Pre-filled ticket for the Raise ticket page (with item and problem when one was picked).
async function buildDraft(db, session) {
  const c = await companyCache(session.service_unit_id);
  const faq = session.faq_id ? c.byId.get(String(session.faq_id)) : null;
  const problem =
    (session.ticket_problem_id && c.probById.get(String(session.ticket_problem_id))) ||
    (faq?.ticket_problem_id && c.probById.get(faq.ticket_problem_id)) ||
    null;
  const { rows: g } = await db.query(
    `SELECT data FROM assistant_events WHERE session_id = $1::bigint AND kind IN ('gpt', 'learned') AND data ? 'suggestion'
      ORDER BY id DESC LIMIT 1`,
    [session.id]
  );
  const sug = g[0]?.data?.suggestion || null;
  const said = session.first_text || '';
  const lines = [];
  if (said) lines.push(said);
  if (faq) {
    const en = faq.answers?.en || {};
    if (!faq.direct_ticket && en.steps?.length) {
      lines.push('', `Tried the AI assistant steps for "${en.question}" — not solved.`);
    }
    if (faq.ticket_info?.length) lines.push('', ...faq.ticket_info.map((i) => `${i}: `));
  }
  const title = problem ? `${problem.item} – ${tidy(problem.name)}` : faq ? `${faq.item} — ${tidy(faq.sub_item)}` : sug?.title || said;
  return {
    assistantSessionId: String(session.id),
    categoryId: problem?.category_id || faq?.ticket_category_id || sug?.categoryId || null,
    itemId: problem?.item_id || null,
    problemId: problem?.id || null,
    title: clean(title).slice(0, 120),
    description: lines.join('\n').trim().slice(0, 5000),
    priority: !faq && sug?.priority ? (sug.priority === 'URGENT' ? 'HIGH' : sug.priority) : 'NORMAL', // older saved answers may say URGENT
    info: faq?.ticket_info || [],
  };
}

async function draft(user, sessionId) {
  const db = deps.pool;
  const session = await ownSession(db, user, sessionId);
  return { draft: await buildDraft(db, session) };
}

// Called by requests.service inside the ticket transaction. A wrong or used session is ignored
// (the ticket is still raised); only the person's own open session in the same company is linked.
async function linkTicket(db, user, sessionId, requestId, companyId = user.companyId) {
  if (!isId(sessionId)) return false;
  const { rows } = await db.query(
    `UPDATE assistant_sessions SET status = 'TICKET', request_id = $3::bigint, ended_at = now()
      WHERE id = $1::bigint AND user_id = $2::bigint AND service_unit_id = $4::bigint AND status = 'OPEN' AND request_id IS NULL
      RETURNING id`,
    [sessionId, user.id, requestId, companyId]
  );
  if (!rows[0]) return false;
  await addEvent(db, sessionId, 'ticket', { data: { requestId: String(requestId) } });
  return true;
}

// For the ticket page: what happened in the assistant before the ticket.
async function forRequest(db, requestId) {
  const { rows } = await db.query(
    `SELECT s.id, s.language, s.first_text, s.matched_by, s.used_gpt, s.created_at,
            f.item, f.sub_item, f.answers->'en'->>'question' AS question
       FROM assistant_sessions s LEFT JOIN faqs f ON f.id = s.faq_id
      WHERE s.request_id = $1::bigint`,
    [requestId]
  );
  const s = rows[0];
  if (!s) return null;
  return {
    sessionId: String(s.id),
    language: s.language,
    said: s.first_text,
    faq: s.item ? { item: s.item, subItem: tidy(s.sub_item), question: s.question } : null,
    matchedBy: s.matched_by,
    usedGpt: s.used_gpt,
    at: s.created_at,
  };
}

// ---------- Super Admin: settings + usage ----------
async function getSettings() {
  return toSettings(await settingsRow());
}

const MODEL_RE = /^[a-z0-9][a-z0-9.\-:_]{2,59}$/i;
async function updateSettings(user, body = {}) {
  const next = {};
  if ('gptEnabled' in body) {
    if (typeof body.gptEnabled !== 'boolean') throw bad('Bad GPT switch value.', 'invalid');
    next.gptEnabled = body.gptEnabled;
  }
  if ('model' in body) {
    const m = clean(body.model);
    if (!MODEL_RE.test(m)) throw bad('Enter a model name such as gpt-4o-mini.', 'bad_model');
    next.model = m;
  }
  if ('temperature' in body) {
    const t = Number(body.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 1) throw bad('Temperature must be from 0 to 1.', 'bad_temperature');
    next.temperature = Math.round(t * 100) / 100;
  }
  for (const k of ['dailyTokenLimit', 'monthlyTokenLimit', 'userDailyCalls']) {
    if (!(k in body)) continue;
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) throw bad('Limits must be whole numbers, 0 or more.', 'bad_limit');
    next[k] = n;
  }
  for (const k of ['priceInPerM', 'priceOutPerM']) {
    if (!(k in body)) continue;
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw bad('Prices must be from 0 to 1000 USD per million tokens.', 'bad_price');
    next[k] = n;
  }
  if (!Object.keys(next).length) throw bad('Nothing to change.', 'empty');

  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    await settingsRow(client);
    const { rows } = await client.query('SELECT * FROM assistant_settings WHERE id = 1 FOR UPDATE');
    const before = toSettings(rows[0]);
    const changes = {};
    for (const [k, v] of Object.entries(next)) if (before[k] !== v) changes[k] = { from: before[k], to: v };
    if (Object.keys(changes).length) {
      const sets = Object.keys(changes).map((k, i) => `${SETTINGS_FIELDS[k]} = $${i + 1}`);
      await client.query(
        `UPDATE assistant_settings SET ${sets.join(', ')}, updated_by = $${sets.length + 1}::bigint, updated_at = now() WHERE id = 1`,
        [...Object.keys(changes).map((k) => changes[k].to), user.id]
      );
      await client.query('INSERT INTO assistant_settings_log (changed_by, changes) VALUES ($1::bigint, $2::jsonb)', [user.id, JSON.stringify(changes)]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getSettings();
}

// company: a company code to see one company only (tokens, sessions, questions), or all.
async function usage({ days = 30, company = null } = {}) {
  const db = deps.pool;
  const tz = config.timeZone;
  const span = Math.min(Math.max(Number(days) || 30, 1), 365);
  const s = await settingsRow(db);
  const units = await companies();
  const unit = company ? units.find((u) => u.code === String(company).toUpperCase()) : null;
  if (company && !unit) throw bad('Unknown company.', 'bad_company');
  const co = unit ? unit.id : null; // null = all companies
  const totals = async (start) => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS calls, count(*) FILTER (WHERE status = 'error')::int AS errors,
              COALESCE(sum(total_tokens), 0)::bigint AS tokens, COALESCE(sum(cost_usd), 0)::numeric AS cost
         FROM assistant_gpt_calls WHERE created_at >= ${start} AND ($2::bigint IS NULL OR service_unit_id = $2::bigint)`,
      [tz, co]
    );
    return { calls: rows[0].calls, errors: rows[0].errors, tokens: Number(rows[0].tokens), costUsd: Number(rows[0].cost) };
  };
  const { rows: daily } = await db.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
            COALESCE(sum(g.total_tokens), 0)::bigint AS tokens, COALESCE(sum(g.cost_usd), 0)::numeric AS cost, count(g.id)::int AS calls
       FROM generate_series((now() AT TIME ZONE $1::text)::date - ($2::int - 1), (now() AT TIME ZONE $1::text)::date, '1 day') AS d
       LEFT JOIN assistant_gpt_calls g ON (g.created_at AT TIME ZONE $1::text)::date = d
             AND ($3::bigint IS NULL OR g.service_unit_id = $3::bigint)
      GROUP BY d ORDER BY d`,
    [tz, span, co]
  );
  const { rows: sess } = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'SOLVED')::int AS solved,
            count(*) FILTER (WHERE status = 'TICKET')::int AS ticket,
            count(*) FILTER (WHERE status IN ('OPEN', 'CLOSED'))::int AS left_open,
            count(*) FILTER (WHERE used_gpt)::int AS used_gpt,
            count(*) FILTER (WHERE matched_by = 'browse')::int AS by_browse,
            count(*) FILTER (WHERE matched_by = 'choice')::int AS by_choice,
            count(*) FILTER (WHERE matched_by = 'search')::int AS by_search,
            count(*) FILTER (WHERE matched_by = 'gpt')::int AS by_gpt,
            count(*) FILTER (WHERE matched_by = 'learned')::int AS by_learned,
            count(*) FILTER (WHERE faq_id IS NULL)::int AS no_faq,
            count(*) FILTER (WHERE matched_by IS NOT NULL AND faq_id IS NULL AND ticket_problem_id IS NOT NULL)::int AS by_problem
       FROM assistant_sessions WHERE created_at >= now() - make_interval(days => $1::int)
        AND ($2::bigint IS NULL OR service_unit_id = $2::bigint)`,
    [span, co]
  );
  const { rows: reused } = await db.query(
    `SELECT count(*) FILTER (WHERE e.kind = 'learned')::int AS n, count(*) FILTER (WHERE e.kind = 'request')::int AS requests
       FROM assistant_events e JOIN assistant_sessions s ON s.id = e.session_id
      WHERE e.kind IN ('learned', 'request') AND e.created_at >= now() - make_interval(days => $1::int)
        AND ($2::bigint IS NULL OR s.service_unit_id = $2::bigint)`,
    [span, co]
  );
  const { rows: recent } = await db.query(
    `SELECT g.id::text AS id, g.created_at AS at, g.model, g.status, g.total_tokens, g.cost_usd, g.error, u.name AS user_name,
            su.name AS company
       FROM assistant_gpt_calls g JOIN users u ON u.id = g.user_id LEFT JOIN service_units su ON su.id = g.service_unit_id
      WHERE ($1::bigint IS NULL OR g.service_unit_id = $1::bigint)
      ORDER BY g.id DESC LIMIT 15`,
    [co]
  );
  // One line per company: sessions and GPT spend in the period.
  const { rows: per } = await db.query(
    `SELECT su.id::text AS id,
            (SELECT count(*)::int FROM assistant_sessions x WHERE x.service_unit_id = su.id AND x.created_at >= now() - make_interval(days => $1::int)) AS sessions,
            (SELECT count(*)::int FROM assistant_sessions x WHERE x.service_unit_id = su.id AND x.status = 'SOLVED' AND x.created_at >= now() - make_interval(days => $1::int)) AS solved,
            (SELECT count(*)::int FROM assistant_gpt_calls g WHERE g.service_unit_id = su.id AND g.created_at >= now() - make_interval(days => $1::int)) AS calls,
            (SELECT COALESCE(sum(g.total_tokens), 0)::bigint FROM assistant_gpt_calls g WHERE g.service_unit_id = su.id AND g.created_at >= now() - make_interval(days => $1::int)) AS tokens,
            (SELECT COALESCE(sum(g.cost_usd), 0)::numeric FROM assistant_gpt_calls g WHERE g.service_unit_id = su.id AND g.created_at >= now() - make_interval(days => $1::int)) AS cost
       FROM service_units su WHERE su.is_active`,
    [span]
  );
  const perBy = new Map(per.map((r) => [r.id, r]));
  const x = sess[0];
  return {
    settings: toSettings(s),
    today: await totals(DAY_START),
    month: await totals(MONTH_START),
    daily: daily.map((d) => ({ day: d.day, tokens: Number(d.tokens), costUsd: Number(d.cost), calls: d.calls })),
    sessions: {
      days: span,
      total: x.total,
      solved: x.solved,
      ticket: x.ticket,
      leftOpen: x.left_open,
      usedGpt: x.used_gpt,
      via: { browse: x.by_browse, choice: x.by_choice, search: x.by_search, learned: x.by_learned, gpt: x.by_gpt, none: x.no_faq, problem: x.by_problem },
      savedAnswersUsed: reused[0].n,
      sentToRequest: reused[0].requests,
    },
    company: unit ? unit.code : null,
    companies: units.map((u) => {
      const r = perBy.get(u.id) || {};
      return {
        code: u.code,
        name: u.name,
        assistantEnabled: u.assistantEnabled,
        sessions: r.sessions || 0,
        solved: r.solved || 0,
        calls: r.calls || 0,
        tokens: Number(r.tokens || 0),
        costUsd: Number(r.cost || 0),
      };
    }),
    unmatched: await unmatchedQuestions(db, { companyId: co }),
    recentCalls: recent.map((r) => ({ id: r.id, at: r.at, model: r.model, status: r.status, tokens: r.total_tokens, costUsd: Number(r.cost_usd), error: r.error, user: r.user_name, company: r.company })),
  };
}

// ---------- Super Admin: questions with no FAQ, saved GPT answers ----------
// Typed questions that found no FAQ in the last 90 days, grouped by key (same words, any order),
// most asked first. Hidden: dismissed ones, and ones an FAQ now answers.
async function unmatchedQuestions(db = deps.pool, { limit = 30, companyId = null } = {}) {
  const { rows } = await db.query(
    `SELECT e.text, e.created_at AS at, s.language, s.service_unit_id::text AS company_id, su.name AS company,
            (SELECT g.data->'suggestion' FROM assistant_events g
              WHERE g.session_id = e.session_id AND g.kind IN ('gpt', 'learned') AND g.id < e.id AND g.data ? 'suggestion'
              ORDER BY g.id DESC LIMIT 1) AS suggestion
       FROM assistant_events e JOIN assistant_sessions s ON s.id = e.session_id
       JOIN service_units su ON su.id = s.service_unit_id
      WHERE e.kind = 'no_match' AND e.text IS NOT NULL AND e.created_at >= now() - interval '90 days'
        AND ($1::bigint IS NULL OR s.service_unit_id = $1::bigint)
      ORDER BY e.id DESC LIMIT 2000`,
    [companyId]
  );
  const { rows: off } = await db.query('SELECT match_key FROM assistant_dismissed');
  const dismissed = new Set(off.map((d) => d.match_key));
  const groups = new Map();
  for (const r of rows) {
    const key = matchKey(r.text);
    if (!key || dismissed.has(key)) continue;
    const g = groups.get(`${r.company_id}:${key}`);
    if (g) {
      g.count += 1;
      if (!g.suggestion && r.suggestion) g.suggestion = r.suggestion;
    } else {
      groups.set(`${r.company_id}:${key}`, {
        key, text: r.text, language: r.language, lastAt: r.at, count: 1, suggestion: r.suggestion || null,
        companyId: r.company_id, company: r.company,
      });
    }
  }
  // Hide the ones that company's assistant now answers.
  const answered = new Map();
  for (const g of groups.values()) {
    if (!answered.has(g.companyId)) answered.set(g.companyId, await companyCache(g.companyId));
    g.answered = match(answered.get(g.companyId).index, g.text, g.language).kind === 'answer';
  }
  return [...groups.values()]
    .filter((g) => !g.answered)
    .map(({ answered: _a, companyId: _c, ...g }) => g)
    .sort((a, b) => b.count - a.count || new Date(b.lastAt) - new Date(a.lastAt))
    .slice(0, limit);
}

async function dismissQuestion(user, body = {}) {
  const key = matchKey(body.key || body.text || '');
  if (!key) throw bad('Nothing to dismiss.', 'empty');
  await deps.pool.query(
    'INSERT INTO assistant_dismissed (match_key, dismissed_by) VALUES ($1::text, $2::bigint) ON CONFLICT (match_key) DO NOTHING',
    [key, user.id]
  );
  return { dismissed: key };
}

function toLearned(r) {
  return {
    id: String(r.id),
    text: r.sample_text,
    language: r.language,
    faqs: r.faqs || [],
    suggestion: r.suggestion,
    hits: r.hits,
    lastUsedAt: r.last_used_at,
    isActive: r.is_active,
    createdAt: r.created_at,
  };
}

async function listLearned(user, { includeOff = false } = {}) {
  const { rows } = await deps.pool.query(
    `SELECT l.*,
            (SELECT COALESCE(json_agg(json_build_object('id', f.id::text, 'item', f.item, 'subItem', f.sub_item, 'isActive', f.is_active)
                                      ORDER BY array_position(l.faq_ids, f.id)), '[]')
               FROM faqs f WHERE f.id = ANY (l.faq_ids)) AS faqs
       FROM assistant_learned l
      WHERE l.service_unit_id = $1::bigint ${includeOff ? '' : 'AND l.is_active'}
      ORDER BY l.hits DESC, l.created_at DESC LIMIT 500`,
    [user.companyId]
  );
  return rows.map(toLearned);
}

// Switch a saved answer off (GPT is asked again next time) or back on. Never deleted.
async function setLearned(user, id, body = {}) {
  if (!isId(id)) throw notFound();
  if (typeof body.isActive !== 'boolean') throw bad('Bad status value.', 'invalid');
  const { rows } = await deps.pool.query(
    `UPDATE assistant_learned SET is_active = $2::boolean, changed_by = $3::bigint
      WHERE id = $1::bigint AND service_unit_id = $4::bigint RETURNING id`,
    [id, body.isActive, user.id, user.companyId]
  );
  if (!rows[0]) throw notFound();
  return (await listLearned(user, { includeOff: true })).find((l) => l.id === String(id));
}

// ---------- Super Admin: each company's assistant on / off ----------
async function companies() {
  const { rows } = await deps.pool.query(
    `SELECT id::text AS id, code, name, assistant_enabled,
            (SELECT count(*)::int FROM faqs f WHERE f.service_unit_id = s.id AND f.is_active) AS faqs
       FROM service_units s WHERE s.is_active ORDER BY s.sort_order, s.id`
  );
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, assistantEnabled: r.assistant_enabled, faqs: r.faqs }));
}

async function setCompanyAssistant(user, code, body = {}) {
  if (typeof body.enabled !== 'boolean') throw bad('Bad switch value.', 'invalid');
  const { rows } = await deps.pool.query(
    'SELECT id, assistant_enabled AS before FROM service_units WHERE code = $1::text AND is_active',
    [String(code || '').toUpperCase()]
  );
  if (!rows[0]) throw notFound();
  if (rows[0].before !== body.enabled) {
    await deps.pool.query('UPDATE service_units SET assistant_enabled = $2::boolean WHERE id = $1::bigint', [rows[0].id, body.enabled]);
    await deps.pool.query('INSERT INTO assistant_settings_log (changed_by, changes) VALUES ($1::bigint, $2::jsonb)', [
      user.id,
      JSON.stringify({ [`assistant_${String(code).toUpperCase()}`]: { from: rows[0].before, to: body.enabled } }),
    ]);
  }
  bust(rows[0].id);
  return companies();
}

module.exports = {
  companies,
  setCompanyAssistant,
  assistantOn,
  companyCache,
  toRequest,
  unmatchedQuestions,
  dismissQuestion,
  listLearned,
  setLearned,
  getConfig,
  startSession,
  ask,
  show,
  feedback,
  draft,
  linkTicket,
  forRequest,
  getSettings,
  updateSettings,
  usage,
  bust,
  setDeps,
  GPT_PER_SESSION,
};
