// Phase 12 AI assistant on real PostgreSQL: FAQ import, chat (buttons / search / GPT fallback),
// limits, feedback, ticket link, settings + usage. eJamaat and OpenAI mocked.
// Runs ONLY when TEST_DATABASE_URL names a "*_test" database.
// Optional: FAQ_JSON=/path/to/support_faq_chatbot_multilingual.json also imports the real file.
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

const maybe = enabled ? describe : describe.skip;

const faq = (id, category, item, sub, keywords, extra = {}) => ({
  item_id: id,
  category,
  item,
  sub_item: sub,
  keywords,
  direct_ticket: false,
  answers: {
    en: { question: `My ${item.toLowerCase()} — ${sub.toLowerCase()}?`, steps: ['Restart it.', 'Check the cable.'], raise_ticket: 'It needs repair. Please raise a ticket.' },
    ar: { question: `سؤال ${id}`, steps: ['خطوة'], raise_ticket: 'افتح تذكرة' },
  },
  diy_detailed_en: ['Longer step.'],
  info_to_include_in_ticket: ['Asset tag / serial number', 'Room / department'],
  ...extra,
});
const FILE = {
  languages: [
    { code: 'en', name: 'English', native_name: 'English', direction: 'ltr' },
    { code: 'ar', name: 'Arabic', native_name: 'العربية', direction: 'rtl' },
  ],
  ui_text: { yes: { en: 'Yes', ar: 'نعم' } },
  general_guidelines: { en: ['Never open a CPU.'] },
  faqs: [
    faq(1, 'Hardware', 'Mouse', 'Not Working', ['mouse not working', 'cursor not moving']),
    faq(2, 'Hardware', 'Mouse', 'Broken', ['mouse broken']),
    faq(3, 'Hardware', 'Printer', 'Paper Jam', ['paper jam', 'paper stuck']),
    faq(4, 'Hardware', 'Printer', 'Not Working', ['printer not working']),
    faq(5, 'Network', 'Lan', 'Internet Not Working', ['no internet', 'internet not working']),
    faq(6, 'Telecommunication', 'Intercom', 'Shift Intercom Line', ['shift intercom'], { direct_ticket: true }),
  ],
};
const fileBuf = (obj) => Buffer.from(JSON.stringify(obj));

maybe('AI assistant on real PostgreSQL', () => {
  const fs = require('fs');
  const request = require('supertest');
  const pool = require('../../db/pool');
  const ejamaat = require('../../services/ejamaatClient');
  const { config } = require('../../config/env');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');
  const assistant = require('../../modules/assistant/assistant.service');

  let app;
  const ids = {};
  let admin;
  let alice;
  let bob;
  const classify = jest.fn();

  async function addUser(its, name, roles) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`, [its, name]);
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }
  const login = async (its, role) => (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role })).body.token;
  const as = (token) => {
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    const A = '/Atom/api/assistant';
    return {
      get: (p) => auth(request(app).get(`${A}${p}`)),
      post: (p, b = {}) => auth(request(app).post(`${A}${p}`)).send(b),
      patch: (p, b = {}) => auth(request(app).patch(`${A}${p}`)).send(b),
      import: (buf, fields = {}) => {
        let r = auth(request(app).post(`${A}/faqs/import`));
        for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
        return r.attach('file', buf, { filename: 'faq.json', contentType: 'application/json' });
      },
      raise: (b) => auth(request(app).post('/Atom/api/requests')).send(b),
      ticket: (n) => auth(request(app).get(`/Atom/api/requests/${n}`)),
    };
  };
  const chat = async (who, language = 'en') => (await who.post('/sessions', { language })).body.session.id;
  const gptReply = (s, usage = { prompt_tokens: 1800, completion_tokens: 30, total_tokens: 1830 }) => ({ suggestion: s, usage, latencyMs: 300 });

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
    await pool.query(`TRUNCATE assistant_dismissed, assistant_learned, assistant_gpt_calls, assistant_events, assistant_sessions, assistant_settings_log, faqs,
                      notifications, request_attachments, request_events, requests, user_change_log, user_service_units,
                      user_posts, user_status_log, user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query('INSERT INTO assistant_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    await pool.query(`UPDATE assistant_settings SET gpt_enabled = FALSE, model = 'gpt-4o-mini', temperature = 0.4,
                      daily_token_limit = 200000, monthly_token_limit = 3000000, user_daily_calls = 20, content = '{}' WHERE id = 1`);
    await pool.query(`SELECT setval('request_number_seq', 1001, false)`);
    // These tests use FAQs only: no AVIT problem list (step C tests cover it); assistants on.
    await pool.query(`UPDATE ticket_problems SET is_active = FALSE WHERE service_unit_id = (SELECT id FROM service_units WHERE code = 'AVIT')`);
    await pool.query('UPDATE service_units SET assistant_enabled = TRUE');
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    classify.mockReset();
    config.openai.apiKey = 'sk-test';
    assistant.bust();
    app = createApp();
    ids.admin = await addUser('30328701', 'Qusai', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);
    ids.bob = await addUser('40000002', 'Bob Saifee', ['EMPLOYEE']);
    admin = as(await login('30328701', 'SUPER_ADMIN'));
    alice = as(await login('40000001'));
    bob = as(await login('40000002'));
    expect((await admin.import(fileBuf(FILE), { commit: 'true' })).body).toMatchObject({ committed: true, created: 6 });
  });

  test('import: preview saves nothing, re-import unchanged, ATOM edits kept, ticket categories mapped', async () => {
    await pool.query('TRUNCATE faqs RESTART IDENTITY CASCADE');
    const preview = await admin.import(fileBuf(FILE));
    expect(preview.body).toMatchObject({ committed: false, created: 6, languages: ['en', 'ar'] });
    expect((await pool.query('SELECT count(*)::int AS n FROM faqs')).rows[0].n).toBe(0);
    await admin.import(fileBuf(FILE), { commit: 'true' });
    expect((await admin.import(fileBuf(FILE), { commit: 'true' })).body).toMatchObject({ created: 0, updated: 0, unchanged: 6 });

    const { faqs } = (await admin.get('/faqs')).body;
    const byItem = Object.fromEntries(faqs.map((f) => [`${f.item}/${f.subItem}`, f]));
    expect(byItem['Printer/Paper Jam'].ticketCategory.name).toBe('Printer / Scanner');
    expect(byItem['Intercom/Shift Intercom Line'].ticketCategory.name).toBe('Telephone / Intercom');
    expect(byItem['Lan/Internet Not Working'].ticketCategory.name).toBe('Network / Internet');

    // Edit one in ATOM, change it in the file too.
    const mouse = byItem['Mouse/Broken'];
    await admin.patch(`/faqs/${mouse.id}`, { keywords: ['mouse broken', 'mouse smashed'] });
    const changed = JSON.parse(JSON.stringify(FILE));
    changed.faqs[1].answers.en.steps = ['New step.'];
    changed.faqs[2].answers.en.steps = ['Open the tray.'];
    changed.faqs.pop();
    const r = (await admin.import(fileBuf(changed), { commit: 'true' })).body;
    expect(r).toMatchObject({ updated: 1, unchanged: 3 });
    expect(r.keptAtomEdits).toEqual([{ itemId: 2, item: 'Mouse', subItem: 'Broken' }]);
    expect(r.notInFile).toEqual([{ itemId: 6, item: 'Intercom', subItem: 'Shift Intercom Line' }]);
    expect((await admin.get(`/faqs/${mouse.id}`)).body.faq.keywords).toEqual(['mouse broken', 'mouse smashed']);
    // Overwrite when "keep ATOM changes" is off.
    expect((await admin.import(fileBuf(changed), { commit: 'true', keepAtomEdits: 'false' })).body.updated).toBe(1);
    expect((await admin.get(`/faqs/${mouse.id}`)).body.faq).toMatchObject({ keywords: ['mouse broken'], editedInAtom: false });

    expect((await admin.import(Buffer.from('nope'))).status).toBe(400);
  });

  test('config: languages, texts and the browse tree', async () => {
    const c = (await alice.get('/config')).body;
    expect(c.languages.map((l) => l.code)).toEqual(['en', 'ar']);
    expect(c.uiText.yes.ar).toBe('نعم');
    expect(c.tree.map((t) => t.category)).toEqual(['Hardware', 'Network', 'Telecommunication']);
    expect(c.tree[0].items.map((i) => i.item)).toEqual(['Mouse', 'Printer']);
    expect(c.tree[0].items[0].faqs[0]).toMatchObject({ subItem: 'Not Working', questions: { ar: 'سؤال 1' } });
  });

  test('typed problem → local answer (no GPT); yes → solved', async () => {
    const id = await chat(alice);
    const r = (await alice.post(`/sessions/${id}/ask`, { text: 'my mouse is not working' })).body;
    expect(r).toMatchObject({ type: 'answer', via: 'search', faq: { item: 'Mouse', subItem: 'Not Working', steps: ['Restart it.', 'Check the cable.'], details: ['Longer step.'] } });
    expect(classify).not.toHaveBeenCalled();
    expect((await alice.post(`/sessions/${id}/feedback`, { solved: true })).body.session.status).toBe('SOLVED');
    expect((await alice.post(`/sessions/${id}/ask`, { text: 'again' })).status).toBe(409);
  });

  test('Arabic chat shows the Arabic text; choices; browse', async () => {
    const id = await chat(alice, 'ar');
    const choices = (await alice.post(`/sessions/${id}/ask`, { text: 'printer' })).body;
    expect(choices.type).toBe('choices');
    expect(choices.faqs.map((f) => f.question).sort()).toEqual(['سؤال 3', 'سؤال 4']);
    const shown = (await alice.post(`/sessions/${id}/show`, { faqId: choices.faqs[0].id, via: 'choice' })).body.faq;
    expect(shown).toMatchObject({ language: 'ar', steps: ['خطوة'] });
    expect((await alice.post(`/sessions/${id}/show`, { faqId: '999999' })).status).toBe(400);
    const s = (await pool.query('SELECT matched_by FROM assistant_sessions WHERE id = $1', [id])).rows[0];
    expect(s.matched_by).toBe('choice');
  });

  test('nothing local and GPT off → none, no call; reason recorded', async () => {
    const id = await chat(alice);
    expect((await alice.post(`/sessions/${id}/ask`, { text: 'projector in hall b shows no picture' })).body).toEqual({ type: 'none' });
    expect(classify).not.toHaveBeenCalled();
    const ev = (await pool.query(`SELECT kind, data FROM assistant_events WHERE session_id = $1 ORDER BY id`, [id])).rows;
    expect(ev.map((e) => e.kind)).toEqual(['typed', 'gpt_skipped', 'no_match']);
    expect(ev[1].data).toEqual({ reason: 'switched_off' });
  });

  test('GPT on: picks an FAQ (answer shown is the FAQ text); tokens and cost recorded', async () => {
    await admin.patch('/settings', { gptEnabled: true });
    const lan = (await pool.query(`SELECT id FROM faqs WHERE item = 'Lan'`)).rows[0].id;
    classify.mockResolvedValue(gptReply({ faqIds: [String(lan)], category: 'Network / Internet', priority: 'NORMAL', title: 'WiFi down' }));
    const id = await chat(alice);
    const r = (await alice.post(`/sessions/${id}/ask`, { text: 'wifi gaya' })).body;
    expect(r).toMatchObject({ type: 'answer', via: 'gpt', faq: { item: 'Lan', steps: ['Restart it.', 'Check the cable.'] } });
    const arg = classify.mock.calls[0][0];
    expect(arg).toMatchObject({ text: 'wifi gaya', model: 'gpt-4o-mini' });
    expect(Number(arg.temperature)).toBe(0.4);
    expect(arg.faqs).toHaveLength(6);
    expect(arg.categories).toContain('Telephone / Intercom');
    const call = (await pool.query('SELECT status, total_tokens, cost_usd FROM assistant_gpt_calls')).rows[0];
    expect(call).toMatchObject({ status: 'ok', total_tokens: 1830 });
    expect(Number(call.cost_usd)).toBeCloseTo((1800 * 0.15 + 30 * 0.6) / 1e6, 6);

    const u = (await admin.get('/usage')).body;
    expect(u.today).toMatchObject({ calls: 1, tokens: 1830 });
    expect(u.month.tokens).toBe(1830);
    expect(u.sessions).toMatchObject({ total: 1, usedGpt: 1, via: { gpt: 1 } });
    expect(u.recentCalls[0]).toMatchObject({ user: 'Alice Hamid', tokens: 1830 });
  });

  test('GPT finds nothing → ticket draft uses its category, priority and title', async () => {
    await admin.patch('/settings', { gptEnabled: true });
    classify.mockResolvedValue(gptReply({ faqIds: [], category: 'Projector / Display', priority: 'HIGH', title: 'Hall B projector no picture' }));
    const id = await chat(alice);
    expect((await alice.post(`/sessions/${id}/ask`, { text: 'hall b projector dead before majlis' })).body).toEqual({ type: 'none' });
    const d = (await alice.get(`/sessions/${id}/draft`)).body.draft;
    const cat = (await pool.query(`SELECT id FROM categories WHERE name = 'Projector / Display'`)).rows[0].id;
    expect(d).toMatchObject({ assistantSessionId: String(id), categoryId: String(cat), priority: 'HIGH', title: 'Hall B projector no picture', description: 'hall b projector dead before majlis' });
    expect((await admin.get('/usage')).body.unmatched[0]).toMatchObject({ text: 'hall b projector dead before majlis', language: 'en' });
  });

  test('limits: daily tokens, per person, per chat; GPT error is logged and the chat carries on', async () => {
    await admin.patch('/settings', { gptEnabled: true, userDailyCalls: 2 });
    classify.mockResolvedValue(gptReply({ faqIds: [], category: null, priority: 'NORMAL', title: null }));
    const reason = async (sid) =>
      (await pool.query(`SELECT data->>'reason' AS r FROM assistant_events WHERE session_id = $1 AND kind = 'gpt_skipped' ORDER BY id DESC LIMIT 1`, [sid])).rows[0]?.r;

    const a1 = await chat(alice);
    await alice.post(`/sessions/${a1}/ask`, { text: 'zzz one' });
    await alice.post(`/sessions/${a1}/ask`, { text: 'zzz two' });
    await alice.post(`/sessions/${a1}/ask`, { text: 'zzz three' });
    expect(classify).toHaveBeenCalledTimes(2);
    expect(await reason(a1)).toBe('user_limit');

    // per chat: 3 GPT calls max
    await admin.patch('/settings', { userDailyCalls: 100 });
    const b1 = await chat(bob);
    for (const t of ['qq1', 'qq2', 'qq3', 'qq4']) await bob.post(`/sessions/${b1}/ask`, { text: t });
    expect(classify).toHaveBeenCalledTimes(5);
    expect(await reason(b1)).toBe('session_limit');

    // daily tokens (5 × 1830 used)
    await admin.patch('/settings', { dailyTokenLimit: 9000 });
    const b2 = await chat(bob);
    await bob.post(`/sessions/${b2}/ask`, { text: 'qq5' });
    expect(await reason(b2)).toBe('daily_limit');
    await admin.patch('/settings', { dailyTokenLimit: 200000, monthlyTokenLimit: 9000 });
    await bob.post(`/sessions/${b2}/ask`, { text: 'qq6' });
    expect(await reason(b2)).toBe('monthly_limit');

    // OpenAI down: error row, user still gets "none"
    await admin.patch('/settings', { monthlyTokenLimit: 3000000 });
    const { GptError } = require('../../modules/assistant/gpt');
    classify.mockRejectedValueOnce(new GptError('OpenAI error: Rate limit reached', 429));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const b3 = await chat(bob);
    expect((await bob.post(`/sessions/${b3}/ask`, { text: 'qq7' })).body).toEqual({ type: 'none' });
    errSpy.mockRestore();
    expect((await pool.query(`SELECT status, error FROM assistant_gpt_calls ORDER BY id DESC LIMIT 1`)).rows[0]).toEqual({ status: 'error', error: 'OpenAI error: Rate limit reached' });

    // no key: skipped
    config.openai.apiKey = '';
    const b4 = await chat(bob);
    await bob.post(`/sessions/${b4}/ask`, { text: 'qq8' });
    expect(await reason(b4)).toBe('no_key');
  });

  test('not solved → draft → ticket linked to the chat; staff see where it came from', async () => {
    const id = await chat(alice);
    await alice.post(`/sessions/${id}/ask`, { text: 'printer paper jam' });
    const fb = (await alice.post(`/sessions/${id}/feedback`, { solved: false })).body;
    const cat = (await pool.query(`SELECT id FROM categories WHERE name = 'Printer / Scanner'`)).rows[0].id;
    expect(fb.draft).toMatchObject({
      categoryId: String(cat),
      title: 'Printer — Paper Jam',
      priority: 'NORMAL',
      info: ['Asset tag / serial number', 'Room / department'],
    });
    expect(fb.draft.description).toBe(
      'printer paper jam\n\nTried the AI assistant steps for "My printer — paper jam?" — not solved.\n\nAsset tag / serial number: \nRoom / department:'
    );
    const t = (await alice.raise({ ...fb.draft, assistantSessionId: id })).body.request;
    expect(t.assistant).toMatchObject({ sessionId: String(id), language: 'en', said: 'printer paper jam', faq: { item: 'Printer', subItem: 'Paper Jam' }, matchedBy: 'search', usedGpt: false });
    const s = (await pool.query(`SELECT s.status, r.number FROM assistant_sessions s JOIN requests r ON r.id = s.request_id WHERE s.id = $1`, [id])).rows[0];
    expect(s).toEqual({ status: 'TICKET', number: Number(String(t.number).replace(/\D/g, '')) });

    // A used or someone else's chat is ignored (the ticket is still raised, not linked).
    const t2 = (await bob.raise({ title: 'Other thing', description: 'x', categoryId: String(cat), assistantSessionId: id })).body.request;
    expect(t2.assistant).toBeNull();
    expect((await admin.ticket(t.number)).body.request.assistant.faq.item).toBe('Printer');
  });

  test('direct-ticket FAQ: shown with its ticket text, draft has no "tried" line', async () => {
    const id = await chat(alice);
    const r = (await alice.post(`/sessions/${id}/ask`, { text: 'shift intercom line to new desk' })).body;
    expect(r).toMatchObject({ type: 'answer', faq: { directTicket: true, raiseTicket: 'It needs repair. Please raise a ticket.' } });
    const d = (await alice.get(`/sessions/${id}/draft`)).body.draft;
    expect(d.description).not.toMatch(/Tried/);
  });

  test('privacy and roles: other people’s chats 404; admin endpoints 404 for employees', async () => {
    const id = await chat(alice);
    expect((await bob.post(`/sessions/${id}/ask`, { text: 'mouse' })).status).toBe(404);
    expect((await bob.get(`/sessions/${id}/draft`)).status).toBe(404);
    expect((await bob.post('/sessions/abc/feedback', { solved: true })).status).toBe(404);
    for (const [m, p] of [['get', '/faqs'], ['get', '/settings'], ['get', '/usage'], ['patch', '/settings'], ['post', '/faqs']]) {
      expect((await alice[m](p, {})).status).toBe(404);
    }
    expect((await request(app).get('/Atom/api/assistant/config')).status).toBe(401);
    expect((await alice.post(`/sessions/${id}/ask`, { text: 'x'.repeat(501) })).status).toBe(400);
    expect((await alice.post(`/sessions/${id}/ask`, { text: '  ' })).status).toBe(400);
  });

  test('settings: validated, changes logged', async () => {
    expect((await admin.patch('/settings', { temperature: 2 })).status).toBe(400);
    expect((await admin.patch('/settings', { model: 'gpt 4o; drop' })).status).toBe(400);
    expect((await admin.patch('/settings', { dailyTokenLimit: -1 })).status).toBe(400);
    expect((await admin.patch('/settings', { gptEnabled: 'yes' })).status).toBe(400);
    const s = (await admin.patch('/settings', { gptEnabled: true, temperature: 0.3, model: 'gpt-4.1-mini' })).body.settings;
    expect(s).toMatchObject({ gptEnabled: true, temperature: 0.3, model: 'gpt-4.1-mini', keyConfigured: true });
    const log = (await pool.query('SELECT changed_by::text, changes FROM assistant_settings_log')).rows;
    expect(log).toEqual([{ changed_by: ids.admin, changes: { gptEnabled: { from: false, to: true }, temperature: { from: 0.4, to: 0.3 }, model: { from: 'gpt-4o-mini', to: 'gpt-4.1-mini' } } }]);
  });

  test('FAQ add / edit / switch off (the chat stops offering it)', async () => {
    const created = (await admin.post('/faqs', {
      category: 'Hardware', item: 'Projector', subItem: 'No Picture', keywords: ['projector no picture'],
      answers: { en: { question: 'Projector shows no picture?', steps: ['Check the HDMI cable.'] } },
    })).body.faq;
    expect(created).toMatchObject({ itemId: 100000, source: 'atom', ticketCategory: { name: 'Projector / Display' } });
    const id = await chat(alice);
    expect((await alice.post(`/sessions/${id}/ask`, { text: 'projector no picture' })).body).toMatchObject({ type: 'answer', faq: { item: 'Projector' } });

    expect((await admin.patch(`/faqs/${created.id}`, { isActive: false })).body.faq.isActive).toBe(false);
    const id2 = await chat(alice);
    expect((await alice.post(`/sessions/${id2}/ask`, { text: 'projector no picture' })).body.type).toBe('none');
    expect((await admin.post('/faqs', { category: 'x' })).status).toBe(400);
    expect((await admin.get('/faqs')).body.faqs).toHaveLength(6);
    expect((await admin.get('/faqs?includeInactive=1')).body.faqs).toHaveLength(7);
  });

  test('saved GPT answers: same question (any word order, small typo) is answered from the DB, no GPT', async () => {
    await admin.patch('/settings', { gptEnabled: true });
    const lan = String((await pool.query(`SELECT id FROM faqs WHERE item = 'Lan'`)).rows[0].id);
    classify.mockResolvedValue(gptReply({ faqIds: [lan], category: 'Network / Internet', priority: 'NORMAL', title: 'WiFi down' }));
    const a = await chat(alice);
    expect((await alice.post(`/sessions/${a}/ask`, { text: 'wifi gaya office me' })).body).toMatchObject({ type: 'answer', via: 'gpt' });

    const b = await chat(bob);
    expect((await bob.post(`/sessions/${b}/ask`, { text: 'offfice me wifi gaya' })).body).toMatchObject({ type: 'answer', via: 'learned', faq: { item: 'Lan' } });
    expect(classify).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT matched_by, used_gpt FROM assistant_sessions WHERE id = $1', [b])).rows[0]).toEqual({ matched_by: 'learned', used_gpt: false });

    const learned = (await admin.get('/learned')).body.learned;
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({ text: 'wifi gaya office me', hits: 1, isActive: true, faqs: [{ id: lan, item: 'Lan' }] });
    const u = (await admin.get('/usage')).body.sessions;
    expect(u).toMatchObject({ savedAnswersUsed: 1, via: { learned: 1, gpt: 1 } });

    // Switched off → GPT is asked again, and the saved answer is refreshed and back on.
    expect((await admin.patch(`/learned/${learned[0].id}`, { isActive: false })).body.learned.isActive).toBe(false);
    expect((await admin.get('/learned')).body.learned).toHaveLength(0);
    const c2 = await chat(bob);
    expect((await bob.post(`/sessions/${c2}/ask`, { text: 'wifi gaya office me' })).body.via).toBe('gpt');
    expect(classify).toHaveBeenCalledTimes(2);
    expect((await admin.get('/learned')).body.learned[0]).toMatchObject({ hits: 0, isActive: true });

    // Its FAQ switched off → the saved answer is ignored, GPT again.
    await admin.patch(`/faqs/${lan}`, { isActive: false });
    classify.mockResolvedValue(gptReply({ faqIds: [], category: 'Network / Internet', priority: 'HIGH', title: 'WiFi down in office' }));
    const c3 = await chat(bob);
    expect((await bob.post(`/sessions/${c3}/ask`, { text: 'wifi gaya office me' })).body).toEqual({ type: 'none' });
    expect(classify).toHaveBeenCalledTimes(3);
    expect((await pool.query('SELECT count(*)::int AS n FROM assistant_learned')).rows[0].n).toBe(1);
    expect((await admin.patch('/learned/999999', { isActive: true })).status).toBe(404);
    expect((await alice.get('/learned')).status).toBe(404);
  });

  test('saved "no FAQ" answer: no GPT next time, and the ticket draft still gets GPT’s category / priority / title', async () => {
    await admin.patch('/settings', { gptEnabled: true });
    classify.mockResolvedValue(gptReply({ faqIds: [], category: 'Projector / Display', priority: 'HIGH', title: 'Hall B projector no picture' }));
    const a = await chat(alice);
    await alice.post(`/sessions/${a}/ask`, { text: 'hall b projector dead' });
    const b = await chat(bob);
    expect((await bob.post(`/sessions/${b}/ask`, { text: 'projector dead hall b' })).body).toEqual({ type: 'none' });
    expect(classify).toHaveBeenCalledTimes(1);
    const d = (await bob.get(`/sessions/${b}/draft`)).body.draft;
    expect(d).toMatchObject({ priority: 'HIGH', title: 'Hall B projector no picture', description: 'projector dead hall b' });
    expect(d.categoryId).toBeTruthy();
  });

  test('questions with no FAQ: grouped with a count, dismiss hides them, an FAQ made from one hides it', async () => {
    for (const [who, t] of [[alice, 'conference room projector remote missing'], [bob, 'projector remote missing conference room'], [alice, 'asdf qwer']]) {
      const id = await chat(who);
      await who.post(`/sessions/${id}/ask`, { text: t });
    }
    let list = (await admin.get('/usage')).body.unmatched;
    expect(list.map((q) => [q.text, q.count])).toEqual([['projector remote missing conference room', 2], ['asdf qwer', 1]]);

    await admin.post('/unmatched/dismiss', { key: list[1].key });
    list = (await admin.get('/usage')).body.unmatched;
    expect(list.map((q) => q.text)).toEqual(['projector remote missing conference room']);

    // "Add as FAQ": the form saves the question as the English question and as a keyword.
    await admin.post('/faqs', {
      category: 'Telecommunication', item: 'Projector Remote', subItem: 'Missing', keywords: ['projector remote missing conference room'],
      answers: { en: { question: 'projector remote missing conference room', steps: ['Check the cable.'] } },
    });
    expect((await admin.get('/usage')).body.unmatched).toEqual([]);
    const id = await chat(alice);
    expect((await alice.post(`/sessions/${id}/ask`, { text: 'conference room projector remote missing' })).body).toMatchObject({ type: 'answer', faq: { item: 'Projector Remote' } });
    expect((await admin.post('/unmatched/dismiss', {})).status).toBe(400);
    expect((await alice.post('/unmatched/dismiss', { key: 'x' })).status).toBe(404);
  });

  (process.env.FAQ_JSON ? test : test.skip)('real FAQ file imports and answers', async () => {
    const r = (await admin.import(fs.readFileSync(process.env.FAQ_JSON), { commit: 'true' })).body;
    expect(r.errors).toEqual([]);
    expect(r.created + r.updated + r.unchanged).toBeGreaterThan(100);
    const id = await chat(alice);
    expect((await alice.post(`/sessions/${id}/ask`, { text: 'keyboard keys not working' })).body).toMatchObject({ type: 'answer', faq: { item: 'Keyboard' } });
  });
});
