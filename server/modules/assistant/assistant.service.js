// AI assistant chat (Phase 12). Cheapest first:
//   1. browse buttons (category → item → problem)       no AI
//   2. typed text → local matching (matcher.js)           no AI
//   3. GPT picks an FAQ — only if 1–2 found nothing, GPT is switched on, and under every limit
// Answers are always the FAQ's own text. "Did this solve it?" → yes: solved, no: pre-filled ticket.
// Every session, step and GPT call is recorded; the session is linked to the ticket if one is raised.
const defaultPool = require('../../db/pool');
const { config } = require('../../config/env');
const { HttpError, notFound } = require('../../utils/httpError');
const { LANGS, clean } = require('./faqData');
const { buildIndex, match } = require('./matcher');
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

// ---------- FAQ cache (121 rows; refreshed every minute and after any FAQ change) ----------
let cache = null;
function bust() {
  cache = null;
}
async function faqCache() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const { rows } = await deps.pool.query(
    `SELECT f.id::text AS id, f.item_id, f.category, f.item, f.sub_item, f.keywords, f.direct_ticket, f.answers,
            f.details_en, f.ticket_info, f.ticket_category_id::text AS ticket_category_id, c.name AS ticket_category
       FROM faqs f LEFT JOIN categories c ON c.id = f.ticket_category_id
      WHERE f.is_active ORDER BY f.category, f.item, f.item_id`
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const index = buildIndex(
    rows.map((r) => ({
      id: r.id,
      item: r.item,
      subItem: r.sub_item,
      keywords: r.keywords,
      questions: Object.fromEntries(Object.entries(r.answers || {}).map(([l, a]) => [l, a.question])),
    }))
  );
  cache = { at: Date.now(), rows, byId, index };
  return cache;
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
async function addEvent(db, sessionId, kind, { text = null, faqId = null, data = null } = {}) {
  await db.query(
    `INSERT INTO assistant_events (session_id, kind, text, faq_id, data) VALUES ($1::bigint, $2::text, $3::text, $4::bigint, $5::jsonb)`,
    [sessionId, kind, text, faqId, data ? JSON.stringify(data) : null]
  );
}

async function ownSession(db, user, id, { open = true } = {}) {
  if (!isId(id)) throw notFound();
  const { rows } = await db.query('SELECT * FROM assistant_sessions WHERE id = $1::bigint AND user_id = $2::bigint', [id, user.id]);
  const s = rows[0];
  if (!s) throw notFound();
  if (open && s.status !== 'OPEN') throw new HttpError(409, 'This chat has ended. Start a new one.', 'session_ended');
  return s;
}

const toSession = (s) => ({ id: String(s.id), language: s.language, status: s.status, requestId: s.request_id ? String(s.request_id) : null });

async function getConfig() {
  const c = await faqCache();
  const s = await settingsRow();
  const content = s.content || {};
  // Browse tree: category → item → problems (with the question in every language).
  const tree = [];
  for (const r of c.rows) {
    let cat = tree.find((t) => t.category === r.category);
    if (!cat) tree.push((cat = { category: r.category, items: [] }));
    let item = cat.items.find((i) => i.item === r.item);
    if (!item) cat.items.push((item = { item: r.item, faqs: [] }));
    item.faqs.push({
      id: r.id,
      subItem: tidy(r.sub_item),
      questions: Object.fromEntries(Object.entries(r.answers || {}).map(([l, a]) => [l, a.question])),
    });
  }
  return {
    languages: content.languages?.length
      ? content.languages
      : [{ code: 'en', name: 'English', nativeName: 'English', direction: 'ltr' }],
    uiText: content.uiText || {},
    guidelines: content.guidelines || {},
    tree,
  };
}

async function startSession(user, { language } = {}) {
  const lang = LANGS.includes(language) ? language : 'en';
  const { rows } = await deps.pool.query(
    'INSERT INTO assistant_sessions (user_id, language) VALUES ($1::bigint, $2::text) RETURNING *',
    [user.id, lang]
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

async function ticketCategories(db) {
  const { rows } = await db.query(
    `SELECT c.id::text AS id, c.name FROM categories c JOIN service_units s ON s.id = c.service_unit_id
      WHERE s.code = 'AVIT' AND c.is_active ORDER BY c.sort_order, c.name`
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
  const c = await faqCache();

  await addEvent(db, session.id, 'typed', { text });
  if (!session.first_text) await db.query('UPDATE assistant_sessions SET first_text = $2::text WHERE id = $1::bigint', [session.id, text]);

  const local = match(c.index, text, lang);
  if (local.kind === 'answer') {
    await setShown(db, session, local.faqId, 'search');
    return { type: 'answer', via: 'search', faq: full(c.byId.get(local.faqId), lang) };
  }
  if (local.kind === 'choices') {
    const ids = local.hits.map((h) => h.faqId);
    await addEvent(db, session.id, 'choices', { data: { faqIds: ids, via: 'search' } });
    return { type: 'choices', via: 'search', faqs: ids.map((id) => brief(c.byId.get(id), lang)) };
  }

  // Nothing local. GPT, if allowed.
  const s = await settingsRow(db);
  const blocked = await gptBlocked(db, s, user, session);
  if (blocked) {
    await addEvent(db, session.id, 'gpt_skipped', { data: { reason: blocked } });
    await addEvent(db, session.id, 'no_match', { text });
    return { type: 'none' };
  }

  const cats = await ticketCategories(db);
  let result;
  let callId;
  try {
    result = await deps.classify({
      text,
      faqs: c.rows.map((r) => ({ id: r.id, category: r.category, item: r.item, subItem: tidy(r.sub_item) })),
      categories: cats.map((x) => x.name),
      model: s.model,
      temperature: s.temperature,
    });
    const cost = gpt.costUsd(result.usage, s.price_in_per_m, s.price_out_per_m);
    const { rows } = await db.query(
      `INSERT INTO assistant_gpt_calls (session_id, user_id, model, status, prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, result)
       VALUES ($1::bigint, $2::bigint, $3::text, 'ok', $4::int, $5::int, $6::int, $7::numeric, $8::int, $9::jsonb) RETURNING id`,
      [session.id, user.id, s.model, result.usage.prompt_tokens, result.usage.completion_tokens, result.usage.total_tokens, cost,
        result.latencyMs, JSON.stringify(result.suggestion)]
    );
    callId = String(rows[0].id);
  } catch (err) {
    if (!(err instanceof gpt.GptError)) throw err;
    const { rows } = await db.query(
      `INSERT INTO assistant_gpt_calls (session_id, user_id, model, status, error) VALUES ($1::bigint, $2::bigint, $3::text, 'error', $4::text) RETURNING id`,
      [session.id, user.id, s.model, err.message.slice(0, 300)]
    );
    console.error(`[ATOM] Assistant GPT call failed: ${err.message}`);
    await addEvent(db, session.id, 'gpt', { data: { callId: String(rows[0].id), error: true } });
    await addEvent(db, session.id, 'no_match', { text });
    return { type: 'none' };
  }

  const sug = result.suggestion;
  const categoryId = cats.find((x) => x.name === sug.category)?.id || null;
  await db.query('UPDATE assistant_sessions SET used_gpt = TRUE WHERE id = $1::bigint', [session.id]);
  await addEvent(db, session.id, 'gpt', { data: { callId, suggestion: { ...sug, categoryId } } });

  const ids = sug.faqIds.filter((id) => c.byId.has(id));
  if (ids.length === 1) {
    await setShown(db, session, ids[0], 'gpt');
    return { type: 'answer', via: 'gpt', faq: full(c.byId.get(ids[0]), lang) };
  }
  if (ids.length > 1) {
    await addEvent(db, session.id, 'choices', { data: { faqIds: ids, via: 'gpt' } });
    return { type: 'choices', via: 'gpt', faqs: ids.map((id) => brief(c.byId.get(id), lang)) };
  }
  await addEvent(db, session.id, 'no_match', { text });
  return { type: 'none' };
}

// A problem picked from the browse buttons or from "Did you mean…".
async function show(user, sessionId, body = {}) {
  const db = deps.pool;
  const session = await ownSession(db, user, sessionId);
  const via = body.via === 'choice' ? 'choice' : 'browse';
  const c = await faqCache();
  const r = isId(body.faqId) ? c.byId.get(String(body.faqId)) : null;
  if (!r) throw bad('That problem is not available.', 'bad_faq');
  await setShown(db, session, r.id, via);
  return { faq: full(r, session.language) };
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

// Pre-filled ticket for the Raise ticket page.
async function buildDraft(db, session) {
  const c = await faqCache();
  const faq = session.faq_id ? c.byId.get(String(session.faq_id)) : null;
  const { rows: g } = await db.query(
    `SELECT data FROM assistant_events WHERE session_id = $1::bigint AND kind = 'gpt' AND data ? 'suggestion'
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
  const title = faq ? `${faq.item} — ${tidy(faq.sub_item)}` : sug?.title || said;
  return {
    assistantSessionId: String(session.id),
    categoryId: faq?.ticket_category_id || sug?.categoryId || null,
    title: clean(title).slice(0, 120),
    description: lines.join('\n').trim().slice(0, 5000),
    priority: !faq && sug?.priority ? sug.priority : 'NORMAL',
    info: faq?.ticket_info || [],
  };
}

async function draft(user, sessionId) {
  const db = deps.pool;
  const session = await ownSession(db, user, sessionId);
  return { draft: await buildDraft(db, session) };
}

// Called by requests.service inside the ticket transaction. A wrong or used session is ignored
// (the ticket is still raised); only the person's own open session is linked.
async function linkTicket(db, user, sessionId, requestId) {
  if (!isId(sessionId)) return false;
  const { rows } = await db.query(
    `UPDATE assistant_sessions SET status = 'TICKET', request_id = $3::bigint, ended_at = now()
      WHERE id = $1::bigint AND user_id = $2::bigint AND status = 'OPEN' AND request_id IS NULL
      RETURNING id`,
    [sessionId, user.id, requestId]
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

async function usage({ days = 30 } = {}) {
  const db = deps.pool;
  const tz = config.timeZone;
  const span = Math.min(Math.max(Number(days) || 30, 1), 365);
  const s = await settingsRow(db);
  const totals = async (start) => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS calls, count(*) FILTER (WHERE status = 'error')::int AS errors,
              COALESCE(sum(total_tokens), 0)::bigint AS tokens, COALESCE(sum(cost_usd), 0)::numeric AS cost
         FROM assistant_gpt_calls WHERE created_at >= ${start}`,
      [tz]
    );
    return { calls: rows[0].calls, errors: rows[0].errors, tokens: Number(rows[0].tokens), costUsd: Number(rows[0].cost) };
  };
  const { rows: daily } = await db.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
            COALESCE(sum(g.total_tokens), 0)::bigint AS tokens, COALESCE(sum(g.cost_usd), 0)::numeric AS cost, count(g.id)::int AS calls
       FROM generate_series((now() AT TIME ZONE $1::text)::date - ($2::int - 1), (now() AT TIME ZONE $1::text)::date, '1 day') AS d
       LEFT JOIN assistant_gpt_calls g ON (g.created_at AT TIME ZONE $1::text)::date = d
      GROUP BY d ORDER BY d`,
    [tz, span]
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
            count(*) FILTER (WHERE faq_id IS NULL)::int AS no_faq
       FROM assistant_sessions WHERE created_at >= now() - make_interval(days => $1::int)`,
    [span]
  );
  const { rows: unmatched } = await db.query(
    `SELECT e.text, e.created_at AS at, s.language FROM assistant_events e JOIN assistant_sessions s ON s.id = e.session_id
      WHERE e.kind = 'no_match' ORDER BY e.id DESC LIMIT 25`
  );
  const { rows: recent } = await db.query(
    `SELECT g.id::text AS id, g.created_at AS at, g.model, g.status, g.total_tokens, g.cost_usd, g.error, u.name AS user_name
       FROM assistant_gpt_calls g JOIN users u ON u.id = g.user_id ORDER BY g.id DESC LIMIT 15`
  );
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
      via: { browse: x.by_browse, choice: x.by_choice, search: x.by_search, gpt: x.by_gpt, none: x.no_faq },
    },
    unmatched: unmatched.map((u) => ({ text: u.text, at: u.at, language: u.language })),
    recentCalls: recent.map((r) => ({ id: r.id, at: r.at, model: r.model, status: r.status, tokens: r.total_tokens, costUsd: Number(r.cost_usd), error: r.error, user: r.user_name })),
  };
}

module.exports = {
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
