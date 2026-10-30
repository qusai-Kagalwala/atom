// Companies step C on real PostgreSQL: each company's own AI assistant — problem-list browse, problems
// without an FAQ → ticket draft, per-company FAQs and saved answers, the Super Admin switch, Tanzeem
// catalogue → Request page, GPT per company and usage per company.
// SQL Server, eJamaat and OpenAI mocked. Runs ONLY when TEST_DATABASE_URL names a "*_test" database.
const URL_ENV = process.env.TEST_DATABASE_URL || '';
let parsed = null;
try {
  parsed = new URL(URL_ENV);
} catch {
  /* not set */
}
const enabled = Boolean(parsed && /_test$/.test(parsed.pathname.slice(1)));
if (enabled) {
  process.env.PG_HOST = parsed.hostname;
  process.env.PG_PORT = parsed.port || '5432';
  process.env.PG_DATABASE = parsed.pathname.slice(1);
  process.env.PG_USER = decodeURIComponent(parsed.username);
  process.env.PG_PASSWORD = decodeURIComponent(parsed.password);
}

jest.mock('../../services/ejamaatClient', () => ({ authenticate: jest.fn(), getPhoto: jest.fn() }));
jest.mock('../../modules/sync/sqlServer', () => ({ ...jest.requireActual('../../modules/sync/sqlServer'), readSupportLogItems: jest.fn() }));

const maybe = enabled ? describe : describe.skip;

// Item_Master rows the way SQL Server returns them.
const COLS = [
  ['Company_Id', 'integer'], ['Item_Id', 'integer'], ['Category', 'text'], ['Item', 'text'], ['Sub_Item', 'text'], ['Description', 'text'],
  ['Tag', 'text'], ['Price', 'numeric(18,2)'], ['Qty', 'integer'], ['Qty_Multiples', 'integer'], ['M_ID', 'integer'],
].map(([name, pgType]) => ({ name, pgType }));
const row = (Company_Id, Item_Id, Category, Item, Sub_Item, extra = {}) => ({
  Company_Id, Item_Id, Category, Item, Sub_Item, Description: null, Tag: '0', Price: null, Qty: 0, Qty_Multiples: 0, M_ID: null, ...extra,
});
const BASE = [
  row(1, 1, 'Hardware', 'Mouse', 'Not working'),
  row(1, 2, 'Hardware', 'Printer', 'Paper jam'),
  row(1, 3, 'Software', 'Ms Word', 'Crashes', { Tag: '1' }),
  row(2, 100, 'Carpentry', 'Door', 'Hinges'),
  row(2, 101, 'Carpentry', 'Door', 'Lock'),
  row(2, 102, 'Carpentry', 'Door', 'lock'), // duplicate (case) → reported, not loaded
  row(2, 103, 'Electrical', 'Switch Board', 'Not Working'),
  row(2, 104, 'Cleaning', 'Other_Cleaning', 'Other'),
  row(3, 200, 'Stationary', 'Cello Tape', '3 inch', { Price: 25, Qty: 4, Qty_Multiples: 6 }), // 4 packs × 6 = 24
  row(3, 201, 'Cutlery / Crockery', 'Cup Saucer', 'Pcs ( 4)', { Price: 340, Qty: 0, Qty_Multiples: 0 }),
  row(3, 202, 'Courier Service', 'Documents', 'Packet', { Qty: 3, Qty_Multiples: 1 }),
  row(3, 203, 'Stationary', 'Book Stand', 'Book Stand (qty 1)', { Tag: '1', Qty: 20 }),
];
const MAIN = { columns: [{ name: 'Item_Id', pgType: 'integer' }, { name: 'Item', pgType: 'text' }, { name: 'Category', pgType: 'text' }], rows: [{ Item_Id: 1, Item: 'Mouse', Category: 'Hardware' }] };
const source = (rows = BASE, columns = COLS) => ({ items: { columns, rows }, main: MAIN });


maybe('step C on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const sqlServer = require('../../modules/sync/sqlServer');
  const { runItemsSync } = require('../../modules/sync/itemsSync');
  const { staffOf, adminOf, companyId } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const { config } = require('../../config/env');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');
  const assistant = require('../../modules/assistant/assistant.service');

  let app;
  const ids = {};
  const co = {};
  const classify = jest.fn();
  let sa;
  let siyAdmin;
  let avitAdmin;
  let aliceSiy;
  let aliceAvit;
  let aliceTan;

  async function addUser(its, name, roles) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`, [its, name]);
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }
  const login = async (its, role, company) =>
    (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role, companyId: company })).body;
  const as = (token) => {
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return {
      get: (p) => auth(request(app).get(`/Atom/api${p}`)),
      post: (p, b = {}) => auth(request(app).post(`/Atom/api${p}`)).send(b),
      patch: (p, b = {}) => auth(request(app).patch(`/Atom/api${p}`)).send(b),
      put: (p, b = {}) => auth(request(app).put(`/Atom/api${p}`)).send(b),
    };
  };
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const chat = async (who) => (await who.post('/assistant/sessions', { language: 'en' })).body.session.id;
  const faqBody = (item, subItem, extra = {}) => ({
    category: 'Carpentry',
    item,
    subItem,
    keywords: [`${item} ${subItem}`.toLowerCase()],
    answers: { en: { question: `${item} — ${subItem}?`, steps: ['Close it gently.'], raise_ticket: 'Raise a ticket.' } },
    ...extra,
  });
  const entry = (tree, cat, item, sub) => tree.find((c) => c.category === cat)?.items.find((i) => i.item === item)?.faqs.find((f) => f.subItem === sub);

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: () => {} });
    } finally {
      c.release();
    }
    assistant.setDeps({ classify });
  });
  afterAll(async () => {
    config.openai.apiKey = '';
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE assistant_dismissed, assistant_learned, assistant_gpt_calls, assistant_events, assistant_sessions, faqs,
                      stock_movements, notifications, request_items, request_attachments, request_events, requests,
                      ticket_problems, ticket_items, user_change_log, user_posts, user_status_log, user_roles, password_reset_tokens,
                      users RESTART IDENTITY CASCADE`);
    await pool.query(`DELETE FROM categories WHERE source = 'supportlog'
                         OR (name <> 'Other' AND service_unit_id IN (SELECT id FROM service_units WHERE code IN ('SIYANAAT', 'TANZEEM')))`);
    await pool.query(`DELETE FROM catalogue_items WHERE source = 'supportlog'`);
    await pool.query(`DELETE FROM src.sync_runs WHERE job = 'items'`);
    await pool.query(`UPDATE service_units SET auto_assign = (code = 'SIYANAAT'), assistant_enabled = TRUE`);
    await pool.query('INSERT INTO assistant_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    await pool.query(`UPDATE assistant_settings SET gpt_enabled = FALSE, model = 'gpt-4o-mini', daily_token_limit = 200000,
                      monthly_token_limit = 3000000, user_daily_calls = 20 WHERE id = 1`);
    await pool.query(`SELECT setval('request_number_seq', 1001, false)`);
    sqlServer.readSupportLogItems.mockReset().mockResolvedValue(source());
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    classify.mockReset();
    config.openai.apiKey = 'sk-test';
    assistant.bust();
    app = createApp();
    co.avit = await companyId(pool, 'AVIT');
    co.siy = await companyId(pool, 'SIYANAAT');
    co.tan = await companyId(pool, 'TANZEEM');

    ids.sa = await addUser('30328701', 'Test Super Admin', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.siyAdmin = await addUser('40000020', 'Siyanaat Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.siyAdmin, 'SIYANAAT');
    ids.avitAdmin = await addUser('40000010', 'AVIT Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.avitAdmin, 'AVIT');
    ids.carp = await addUser('40000021', 'Abbas Test Carpenter', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.carp, 'SIYANAAT', 'Carpenter');
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);

    sa = as((await login('30328701', 'SUPER_ADMIN')).token);
    siyAdmin = as((await login('40000020', 'ADMIN')).token);
    avitAdmin = as((await login('40000010', 'ADMIN')).token);
    aliceSiy = as((await login('40000001', 'EMPLOYEE', co.siy)).token);
    aliceAvit = as((await login('40000001', 'EMPLOYEE', co.avit)).token);
    aliceTan = as((await login('40000001', 'EMPLOYEE', co.tan)).token);
    expect((await runItemsSync({ log: () => {} })).status).toBe('success');
  });

  // ---------------------------------------------------------------------------------
  test('Siyanaat: browse the problem list; a problem with no FAQ → draft with item and problem → auto-assigned ticket', async () => {
    const cfg = (await aliceSiy.get('/assistant/config')).body;
    expect(cfg).toMatchObject({ company: { code: 'SIYANAAT', name: 'Siyanaat' }, mode: 'ticket' });
    const hinges = entry(cfg.tree, 'Carpentry', 'Door', 'Hinges');
    expect(hinges).toMatchObject({ id: null, subItem: 'Hinges' });
    expect(cfg.tree.map((c) => c.category)).not.toContain('Hardware'); // AVIT's never shows here

    const id = await chat(aliceSiy);
    expect((await aliceSiy.post(`/assistant/sessions/${id}/show`, { problemId: hinges.problemId, via: 'browse' })).body).toEqual({
      problem: { id: hinges.problemId, category: 'Carpentry', item: 'Door', problem: 'Hinges' },
    });
    const draft = (await aliceSiy.get(`/assistant/sessions/${id}/draft`)).body.draft;
    expect(draft).toMatchObject({ title: 'Door – Hinges', problemId: hinges.problemId, assistantSessionId: String(id) });
    const t = (await aliceSiy.post('/requests', { ...draft, location: 'Room 1615' })).body.request;
    expect(t).toMatchObject({ status: 'ASSIGNED', problem: { item: 'Door', problem: 'Hinges' }, assignedEngineer: { name: 'Abbas Test Carpenter' } });
    expect((await q('SELECT status, request_id::text AS r FROM assistant_sessions WHERE id = $1', [id]))[0]).toEqual({ status: 'TICKET', r: t.id });

    // Typed: matched to the problem list locally (no FAQ, no GPT).
    const id2 = await chat(aliceSiy);
    expect((await aliceSiy.post(`/assistant/sessions/${id2}/ask`, { text: 'door hinges broken' })).body).toMatchObject({
      type: 'problem', via: 'search', problem: { item: 'Door', problem: 'Hinges' },
    });
    expect((await aliceSiy.get(`/assistant/sessions/${id2}/draft`)).body.draft).toMatchObject({ problemId: hinges.problemId });
  });

  test('per-company FAQs: linked to the problem list, isolated from other companies', async () => {
    const f = (await siyAdmin.post('/assistant/faqs', faqBody('Door', 'Hinges'))).body.faq;
    expect(f).toMatchObject({ item: 'Door', problem: { item: 'Door', name: 'Hinges' }, ticketCategory: { name: 'Carpentry' } });
    const cfg = (await aliceSiy.get('/assistant/config')).body;
    expect(entry(cfg.tree, 'Carpentry', 'Door', 'Hinges')).toMatchObject({ id: f.id });
    const id = await chat(aliceSiy);
    expect((await aliceSiy.post(`/assistant/sessions/${id}/ask`, { text: 'door hinges' })).body).toMatchObject({ type: 'answer', faq: { id: f.id } });
    // Not solved → the draft still carries the item and problem.
    expect((await aliceSiy.post(`/assistant/sessions/${id}/feedback`, { solved: false })).body.draft).toMatchObject({ title: 'Door – Hinges' });

    // AVIT can't see or use it.
    expect((await avitAdmin.get('/assistant/faqs')).body.faqs.map((x) => x.id)).not.toContain(f.id);
    expect((await avitAdmin.get(`/assistant/faqs/${f.id}`)).status).toBe(404);
    expect((await avitAdmin.patch(`/assistant/faqs/${f.id}`, { isActive: false })).status).toBe(404);
    const a = await chat(aliceAvit);
    expect((await aliceAvit.post(`/assistant/sessions/${a}/show`, { faqId: f.id })).body.code).toBe('bad_faq');
    expect((await aliceAvit.post(`/assistant/sessions/${a}/ask`, { text: 'door hinges' })).body).toEqual({ type: 'none' });
    // A Siyanaat chat can't be used from AVIT, and a problem of another company can't be linked.
    expect((await aliceAvit.post(`/assistant/sessions/${id}/ask`, { text: 'x' })).status).toBe(404);
    const avitProblem = (await q(`SELECT id::text FROM ticket_problems WHERE service_unit_id = $1 LIMIT 1`, [co.avit]))[0].id;
    expect((await siyAdmin.post('/assistant/faqs', faqBody('Door', 'Lock', { ticketProblemId: avitProblem }))).body.code).toBe('bad_problem');
    // Staff and employees can't manage FAQs.
    expect((await aliceSiy.get('/assistant/faqs')).status).toBe(404);
  });

  test('Super Admin switches a company assistant off: chat 404, menu flag off, FAQ editing still works', async () => {
    const list = (await sa.patch('/assistant/companies/SIYANAAT', { enabled: false })).body.companies;
    expect(list.find((c) => c.code === 'SIYANAAT')).toMatchObject({ assistantEnabled: false });
    expect((await aliceSiy.get('/assistant/config')).status).toBe(404);
    expect((await aliceSiy.post('/assistant/sessions', {})).status).toBe(404);
    expect((await aliceSiy.get('/auth/me')).body.user.company).toMatchObject({ code: 'SIYANAAT', assistantEnabled: false });
    expect((await siyAdmin.get('/assistant/faqs')).status).toBe(200);
    expect((await aliceAvit.get('/assistant/config')).status).toBe(200);
    expect((await siyAdmin.patch('/assistant/companies/SIYANAAT', { enabled: true })).status).toBe(404); // Super Admin only
    expect((await q(`SELECT changes FROM assistant_settings_log ORDER BY id DESC LIMIT 1`))[0].changes).toEqual({ assistant_SIYANAAT: { from: true, to: false } });
    await sa.patch('/assistant/companies/SIYANAAT', { enabled: true });
    expect((await aliceSiy.get('/assistant/config')).status).toBe(200);
  });

  test('"Before you start" tips are per company and edited by its Admin', async () => {
    await pool.query(`UPDATE service_units SET assistant_guidelines = '{"en":["Never open a CPU."]}' WHERE code = 'AVIT'`);
    await pool.query(`UPDATE service_units SET assistant_guidelines = '{}' WHERE code = 'SIYANAAT'`);
    assistant.bust();
    expect((await aliceSiy.get('/assistant/config')).body.guidelines).toEqual({});
    expect((await aliceAvit.get('/assistant/config')).body.guidelines).toEqual({ en: ['Never open a CPU.'] });
    expect((await siyAdmin.put('/assistant/guidelines', { guidelines: { ar: ['x'] } })).body.code).toBe('english_required');
    expect((await siyAdmin.put('/assistant/guidelines', { guidelines: { fr: ['x'] } })).body.code).toBe('bad_language');
    const saved = (await siyAdmin.put('/assistant/guidelines', { guidelines: { en: [' Switch off the MCB. ', ''], ar: [] } })).body;
    expect(saved).toEqual({ guidelines: { en: ['Switch off the MCB.'] } });
    expect((await aliceSiy.get('/assistant/config')).body.guidelines).toEqual({ en: ['Switch off the MCB.'] });
    expect((await aliceAvit.get('/assistant/config')).body.guidelines).toEqual({ en: ['Never open a CPU.'] });
    expect((await aliceSiy.put('/assistant/guidelines', { guidelines: { en: ['x'] } })).status).toBe(404);
  });

  test('Tanzeem: catalogue items suggested → Request page; the chat ends', async () => {
    expect((await aliceTan.get('/assistant/config')).body).toMatchObject({ mode: 'request', company: { code: 'TANZEEM' } });
    const id = await chat(aliceTan);
    const r = (await aliceTan.post(`/assistant/sessions/${id}/ask`, { text: 'need cello tape' })).body;
    expect(r.type).toBe('catalogue');
    const tape = r.items.find((x) => x.name === 'Cello Tape — 3 inch');
    expect(tape).toMatchObject({ group: 'Stationery', price: 25, packSize: 6 });
    expect((await aliceTan.post(`/assistant/sessions/${id}/request`, { catalogueItemIds: ['999999'] })).body.code).toBe('bad_item');
    expect((await aliceTan.post(`/assistant/sessions/${id}/request`, { catalogueItemIds: [tape.id] })).body).toMatchObject({
      session: { status: 'CLOSED' }, catalogueItemIds: [tape.id],
    });
    expect((await aliceTan.post(`/assistant/sessions/${id}/ask`, { text: 'more' })).body.code).toBe('session_ended');
  });

  test('GPT per company: the company prompt, its categories and problems; saved answers and usage per company', async () => {
    await sa.patch('/assistant/settings', { gptEnabled: true });
    const lock = (await q(`SELECT p.id::text FROM ticket_problems p JOIN ticket_items i ON i.id = p.item_id WHERE p.service_unit_id = $1 AND p.name = 'Lock'`, [co.siy]))[0].id;
    classify.mockResolvedValue({ suggestion: { faqIds: [`p${lock}`], category: 'Carpentry', priority: 'NORMAL', title: 'Cannot lock room' }, usage: { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920 }, latencyMs: 200 });
    const id = await chat(aliceSiy);
    expect((await aliceSiy.post(`/assistant/sessions/${id}/ask`, { text: 'room cannot be secured at night' })).body).toMatchObject({
      type: 'problem', via: 'gpt', problem: { item: 'Door', problem: 'Lock' },
    });
    const arg = classify.mock.calls[0][0];
    expect(arg.company).toMatchObject({ name: 'Siyanaat' });
    expect(arg.categories).toContain('Carpentry');
    expect(arg.categories).not.toContain('Printer / Scanner');
    expect(arg.faqs.map((o) => o.id)).toContain(`p${lock}`);
    expect(arg.faqs.every((o) => !/Mouse|Printer/.test(o.item))).toBe(true);

    // Same question again in Siyanaat → saved answer; in AVIT → GPT is asked (saved answers are per company).
    const id2 = await chat(aliceSiy);
    expect((await aliceSiy.post(`/assistant/sessions/${id2}/ask`, { text: 'room cannot be secured at night' })).body).toMatchObject({ type: 'problem', via: 'learned' });
    classify.mockResolvedValue({ suggestion: { faqIds: [], category: null, priority: 'NORMAL', title: null }, usage: { prompt_tokens: 500, completion_tokens: 10, total_tokens: 510 }, latencyMs: 200 });
    const a = await chat(aliceAvit);
    expect((await aliceAvit.post(`/assistant/sessions/${a}/ask`, { text: 'room cannot be secured at night' })).body).toEqual({ type: 'none' });
    expect(classify).toHaveBeenCalledTimes(2);
    expect((await siyAdmin.get('/assistant/learned')).body.learned).toHaveLength(1);
    expect((await avitAdmin.get('/assistant/learned')).body.learned).toHaveLength(1);

    const all = (await sa.get('/assistant/usage')).body;
    expect(all.today.tokens).toBe(1430);
    expect(all.companies.find((c) => c.code === 'SIYANAAT')).toMatchObject({ calls: 1, tokens: 920, sessions: 2 });
    const siy = (await sa.get('/assistant/usage?company=SIYANAAT')).body;
    expect(siy).toMatchObject({ company: 'SIYANAAT', today: { tokens: 920 }, sessions: { total: 2 } });
    expect(siy.recentCalls.every((c) => c.company === 'Siyanaat')).toBe(true);
    const avit = (await sa.get('/assistant/usage?company=AVIT')).body;
    expect(avit.unmatched[0]).toMatchObject({ text: 'room cannot be secured at night', company: 'AVIT' });
    expect(siy.unmatched).toHaveLength(0);
    expect((await sa.get('/assistant/usage?company=NOPE')).body.code).toBe('bad_company');
  });
});
