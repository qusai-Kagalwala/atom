// Companies step B on real PostgreSQL: Support Log items sync (AVIT / Siyanaat problem lists, Tanzeem
// catalogue), the problem list API, raising a ticket from the list, auto-assign by occupation, and
// Tanzeem stock. SQL Server and eJamaat mocked. Runs ONLY when TEST_DATABASE_URL names a "*_test" database.
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

maybe('step B on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const sqlServer = require('../../modules/sync/sqlServer');
  const { runItemsSync } = require('../../modules/sync/itemsSync');
  const { staffOf, adminOf, companyId } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  const ids = {};
  const co = {};
  let sa;
  let siyAdmin;
  let avitAdmin;
  let tanAdmin;
  let carp1;
  let aliceSiy;
  let aliceTan;

  async function addUser(its, name, roles) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`, [its, name]);
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }
  const session = async (its, role, company) =>
    (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role, companyId: company })).body.token;
  const as = (token) => {
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return {
      get: (p) => auth(request(app).get(`/Atom/api${p}`)),
      post: (p, b = {}) => auth(request(app).post(`/Atom/api${p}`)).send(b),
      patch: (p, b = {}) => auth(request(app).patch(`/Atom/api${p}`)).send(b),
    };
  };
  const sync = (opts = {}) => runItemsSync({ log: () => {}, ...opts });
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const find = (tree, cat, item) => {
    const c = tree.categories.find((x) => x.name === cat);
    return item ? { c, i: c.items.find((x) => x.name === item) } : { c };
  };

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: () => {} });
    } finally {
      c.release();
    }
  });
  afterAll(async () => pool.end());

  beforeEach(async () => {
    await pool.query(`TRUNCATE stock_movements, notifications, request_items, request_attachments, request_events, requests,
                      ticket_problems, ticket_items, user_change_log, user_posts, user_status_log, user_roles, password_reset_tokens,
                      users RESTART IDENTITY CASCADE`);
    await pool.query(`DELETE FROM categories WHERE source = 'supportlog'
                         OR (name <> 'Other' AND service_unit_id IN (SELECT id FROM service_units WHERE code IN ('SIYANAAT', 'TANZEEM')))`);
    await pool.query(`DELETE FROM catalogue_items WHERE source = 'supportlog'`);
    await pool.query(`DELETE FROM src.sync_runs WHERE job = 'items'`);
    await pool.query(`UPDATE service_units SET auto_assign = (code = 'SIYANAAT')`);
    await pool.query(`SELECT setval('request_number_seq', 1001, false)`);
    sqlServer.readSupportLogItems.mockReset().mockResolvedValue(source());
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    co.avit = await companyId(pool, 'AVIT');
    co.siy = await companyId(pool, 'SIYANAAT');
    co.tan = await companyId(pool, 'TANZEEM');

    ids.sa = await addUser('30328701', 'Test Super Admin', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.siyAdmin = await addUser('40000020', 'Huzaifa Siyanaat Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.siyAdmin, 'SIYANAAT');
    ids.avitAdmin = await addUser('40000010', 'AVIT Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.avitAdmin, 'AVIT');
    ids.tanAdmin = await addUser('40000030', 'Tanzeem Admin', ['EMPLOYEE']);
    await adminOf(pool, ids.tanAdmin, 'TANZEEM');
    ids.peon = await addUser('40000031', 'Yusuf Peon Bhai', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.peon, 'TANZEEM', 'Peon');
    ids.carp1 = await addUser('40000021', 'Abbas Test Carpenter', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.carp1, 'SIYANAAT', 'Carpenter');
    ids.carp2 = await addUser('40000022', 'Burhan Test Carpenter', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.carp2, 'SIYANAAT', 'Carpenter');
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);

    sa = as(await session('30328701', 'SUPER_ADMIN'));
    siyAdmin = as(await session('40000020', 'ADMIN'));
    avitAdmin = as(await session('40000010', 'ADMIN'));
    tanAdmin = as(await session('40000030', 'ADMIN'));
    carp1 = as(await session('40000021', 'ENGINEER'));
    aliceSiy = as(await session('40000001', 'EMPLOYEE', co.siy));
    aliceTan = as(await session('40000001', 'EMPLOYEE', co.tan));
  });

  // ---------------------------------------------------------------------------------
  test('sync: preview saves nothing; sync loads all three companies; a re-run changes nothing', async () => {
    const pre = await sync({ preview: true });
    expect(pre).toMatchObject({ status: 'success', preview: true });
    expect(pre.summary.companies.SIYANAAT).toMatchObject({ valid: 4, duplicates: 1, problems: { created: 4 }, categoriesCreated: 3 });
    expect(await q(`SELECT 1 FROM ticket_problems`)).toHaveLength(0);
    expect(await q(`SELECT 1 FROM src.sync_runs WHERE job = 'items'`)).toHaveLength(0);

    const r = await sync();
    expect(r.status).toBe('success');
    expect(r.summary.companies.AVIT).toMatchObject({ valid: 3, inactive: 1, problems: { created: 3 }, categoriesCreated: 0 });
    expect(r.summary.companies.TANZEEM).toMatchObject({ valid: 4, inactive: 1, catalogue: { created: 4 } });

    // AVIT: items go under AVIT's own categories (Mouse → Computer / Laptop, Printer → Printer / Scanner).
    const avitTree = (await avitAdmin.get('/problems?includeInactive=1')).body;
    expect(find(avitTree, 'Computer / Laptop', 'Mouse').i.problems.map((p) => p.name)).toEqual(['Not working']);
    expect(find(avitTree, 'Printer / Scanner', 'Printer').i.problems.map((p) => p.name)).toEqual(['Paper jam']);
    expect(find(avitTree, 'Software', 'Ms Word').i).toMatchObject({ isActive: false }); // Tag 1

    // Siyanaat: its own categories, cleaned names, default occupations.
    const siyTree = (await aliceSiy.get('/problems')).body;
    expect(siyTree.autoAssign).toBe(true);
    expect(find(siyTree, 'Carpentry').c.occupation).toMatchObject({ name: 'Carpenter' });
    expect(find(siyTree, 'Electrical').c.occupation).toMatchObject({ name: 'Electrician' });
    expect(find(siyTree, 'Carpentry', 'Door').i.problems.map((p) => p.name)).toEqual(['Hinges', 'Lock']);
    expect(find(siyTree, 'Cleaning', 'Other').i.problems.map((p) => p.name)).toEqual(['Other']);

    // Tanzeem: catalogue with price, pack size, stock (Qty × Qty_Multiples), services untracked.
    const cat = (await tanAdmin.get('/requests/catalogue?includeInactive=1')).body.items.filter((i) => i.source === 'supportlog');
    const by = Object.fromEntries(cat.map((i) => [i.name, i]));
    expect(by['Cello Tape — 3 inch']).toMatchObject({ group: 'Stationery', kind: 'supply', price: 25, packSize: 6, stock: 24, isActive: true });
    expect(by['Cup Saucer — Pcs (4)']).toMatchObject({ group: 'Cutlery / Crockery', price: 340, stock: 0 });
    expect(by['Documents — Packet']).toMatchObject({ kind: 'service', stock: null });
    expect(by['Book Stand — Book Stand (qty 1)']).toMatchObject({ isActive: false });

    const again = await sync();
    expect(again.summary.companies.SIYANAAT.problems).toMatchObject({ created: 0, unchanged: 4 });
    expect(again.summary.companies.TANZEEM.catalogue).toMatchObject({ created: 0, unchanged: 4 });
    expect((await q(`SELECT count(*)::int AS n FROM src.supportlog_item_master`))[0].n).toBe(BASE.length);
  });

  test('sync: changes made in ATOM are kept unless overwritten; missing rows switched off; guards; columns', async () => {
    await sync();
    const tree = (await siyAdmin.get('/problems?includeInactive=1')).body;
    const hinges = find(tree, 'Carpentry', 'Door').i.problems.find((p) => p.name === 'Hinges');
    expect((await siyAdmin.patch(`/problems/problems/${hinges.id}`, { name: 'Hinge broken' })).status).toBe(200);
    const tape = (await tanAdmin.get('/requests/catalogue')).body.items.find((i) => i.name === 'Cello Tape — 3 inch');
    expect((await tanAdmin.post(`/requests/catalogue/${tape.id}/stock`, { change: 6, reason: 'New box arrived' })).body.item.stock).toBe(30);

    // Source changes: hinge text, tape stock, the lock row disappears.
    const changed = BASE.filter((r) => r.Item_Id !== 101 && r.Item_Id !== 102).map((r) =>
      r.Item_Id === 100 ? { ...r, Sub_Item: 'Hinge loose' } : r.Item_Id === 200 ? { ...r, Qty: 2 } : r
    );
    sqlServer.readSupportLogItems.mockResolvedValue(source(changed));
    const kept = await sync();
    expect(kept.summary.companies.SIYANAAT.problems).toMatchObject({ kept: 1, missing: 1 });
    expect(kept.summary.companies.TANZEEM.catalogue).toMatchObject({ stockKept: 1 });
    const t2 = (await siyAdmin.get('/problems?includeInactive=1')).body;
    expect(find(t2, 'Carpentry', 'Door').i.problems.map((p) => [p.name, p.isActive])).toEqual([['Hinge broken', true], ['Lock', false]]);
    expect((await tanAdmin.get('/requests/catalogue')).body.items.find((i) => i.id === tape.id).stock).toBe(30);

    const over = await sync({ keepAtomEdits: false, companies: ['SIYANAAT', 'TANZEEM'] });
    expect(over.summary.companies.AVIT).toBeUndefined();
    const t3 = (await siyAdmin.get('/problems?includeInactive=1')).body;
    expect(find(t3, 'Carpentry', 'Door').i.problems.find((p) => p.id === hinges.id).name).toBe('Hinge loose');
    expect((await tanAdmin.get('/requests/catalogue')).body.items.find((i) => i.id === tape.id).stock).toBe(12);
    const moves = (await tanAdmin.get(`/requests/catalogue/${tape.id}/stock`)).body.movements;
    expect(moves.map((m) => [m.kind, m.change, m.stockAfter])).toEqual([['sync', -18, 12], ['adjust', 6, 30], ['sync', 24, 24]]);

    // Guards: no Tanzeem rows → blocked; Siyanaat under half of last time → blocked unless forced.
    sqlServer.readSupportLogItems.mockResolvedValue(source(BASE.filter((r) => r.Company_Id !== 3)));
    expect(await sync({ companies: ['TANZEEM'] })).toMatchObject({ status: 'blocked' });
    sqlServer.readSupportLogItems.mockResolvedValue(source(BASE.filter((r) => ![101, 102, 103, 104].includes(r.Item_Id)))); // 1 of 3
    expect(await sync({ companies: ['SIYANAAT'] })).toMatchObject({ status: 'blocked' });
    expect(await sync({ companies: ['SIYANAAT'], force: true })).toMatchObject({ status: 'success' });

    // A column gone from the source stops the run.
    sqlServer.readSupportLogItems.mockResolvedValue(source(BASE, COLS.filter((c) => c.name !== 'Qty_Multiples')));
    const bad = await sync();
    expect(bad.status).toBe('failed');
    expect(bad.message).toMatch(/qty_multiples/);
  });

  test('sync route: Super Admin only; preview and options', async () => {
    const res = await sa.post('/sync/items', { preview: true, companies: ['TANZEEM'] });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.summary.companies)).toEqual(['TANZEEM']);
    expect((await sa.post('/sync/items', { companies: ['NOPE'] })).status).toBe(400);
    expect((await siyAdmin.post('/sync/items', {})).status).toBe(404);
    expect((await sa.post('/sync/items', {})).body.status).toBe('success');
    expect((await sa.get('/sync/runs?job=items')).body.runs[0]).toMatchObject({ status: 'success', triggered_by_name: 'Test Super Admin' });
  });

  test('problem list API: Admin edits own company only; occupation links stay in the company', async () => {
    await sync();
    const tree = (await siyAdmin.get('/problems?includeInactive=1')).body;
    const carpentry = find(tree, 'Carpentry').c;
    const occs = (await siyAdmin.get('/staff/occupations')).body.occupations;
    const mason = occs.find((o) => o.name === 'Mason');
    const masonry = await siyAdmin.post('/problems/categories', { name: 'Masonry', occupationId: mason.id });
    expect(masonry.status).toBe(201);
    const item = await siyAdmin.post('/problems/items', { categoryId: masonry.body.id, name: 'Wall' });
    expect((await siyAdmin.post('/problems/problems', { itemId: item.body.id, name: 'Crack' })).status).toBe(201);
    expect((await siyAdmin.post('/problems/categories', { name: 'Masonry' })).status).toBe(409);

    const avitOcc = (await avitAdmin.get('/staff/occupations')).body.occupations[0];
    expect((await siyAdmin.patch(`/problems/categories/${carpentry.id}`, { occupationId: avitOcc.id })).body.code).toBe('bad_occupation');
    expect((await avitAdmin.patch(`/problems/categories/${carpentry.id}`, { name: 'Taken' })).status).toBe(404);
    expect((await avitAdmin.post('/problems/items', { categoryId: carpentry.id, name: 'X' })).body.code).toBe('bad_category');
    expect((await carp1.patch(`/problems/categories/${carpentry.id}`, { name: 'Mine' })).status).toBe(404);
    expect((await aliceSiy.patch('/problems/settings', { autoAssign: false })).status).toBe(404);
    expect((await siyAdmin.patch('/problems/settings', { autoAssign: false })).body).toEqual({ autoAssign: false });

    // Employees only see active rows.
    await siyAdmin.patch(`/problems/categories/${masonry.body.id}`, { isActive: false });
    expect(find((await aliceSiy.get('/problems')).body, 'Masonry').c).toBeUndefined();
  });

  test('raise from the list: title fills in; auto-assigned to the carpenter with the least work; full names', async () => {
    await sync();
    const tree = (await aliceSiy.get('/problems')).body;
    const { c, i } = find(tree, 'Carpentry', 'Door');
    const hinges = i.problems.find((p) => p.name === 'Hinges');

    const t1 = (await aliceSiy.post('/requests', { categoryId: c.id, itemId: i.id, problemId: hinges.id, location: 'Room 1615' })).body.request;
    expect(t1).toMatchObject({ title: 'Door – Hinges', status: 'ASSIGNED', problem: { item: 'Door', problem: 'Hinges' } });
    expect(t1.assignedEngineer).toMatchObject({ name: 'Abbas Test Carpenter', occupation: 'Carpenter' });
    expect(t1.events.at(-1)).toMatchObject({ type: 'assigned', actor: null, data: { auto: true, occupation: 'Carpenter', engineerName: 'Abbas Test Carpenter' } });

    // Second one → the other carpenter (fewer open jobs); "Other" with own words.
    const t2 = (await aliceSiy.post('/requests', { categoryId: c.id, itemId: i.id, problemText: 'Door handle came off' })).body.request;
    expect(t2).toMatchObject({ title: 'Door – Door handle came off', problem: { problem: null, text: 'Door handle came off' } });
    expect(t2.assignedEngineer.name).toBe('Burhan Test Carpenter');

    const notes = async (id) => (await q('SELECT title, body FROM notifications WHERE user_id = $1 ORDER BY id', [id]));
    expect((await notes(ids.alice))[0]).toEqual({ title: 'A carpenter is on T-1001', body: 'Carpenter: Abbas Test Carpenter will help with: Door – Hinges' });
    expect((await notes(ids.carp1))[0]).toMatchObject({ title: 'T-1001 is assigned to you' });
    expect((await notes(ids.siyAdmin))[0]).toEqual({
      title: 'New ticket T-1001', body: 'Door – Hinges · assigned automatically to Carpenter: Abbas Test Carpenter',
    });

    // Item of another category → refused.
    const elec = find(tree, 'Electrical').c;
    expect((await aliceSiy.post('/requests', { categoryId: elec.id, itemId: i.id })).body.code).toBe('bad_item');
    // No active carpenter → waits for the Admin; auto-assign off → waits too.
    await pool.query(`UPDATE users SET is_active = FALSE WHERE id IN ($1, $2)`, [ids.carp1, ids.carp2]);
    expect((await aliceSiy.post('/requests', { categoryId: c.id, itemId: i.id, problemId: hinges.id })).body.request.status).toBe('OPEN');
    await pool.query(`UPDATE users SET is_active = TRUE WHERE id IN ($1, $2)`, [ids.carp1, ids.carp2]);
    await siyAdmin.patch('/problems/settings', { autoAssign: false });
    expect((await aliceSiy.post('/requests', { categoryId: c.id, itemId: i.id, problemId: hinges.id })).body.request.status).toBe('OPEN');
    // A category without an occupation never auto-assigns.
    await siyAdmin.patch('/problems/settings', { autoAssign: true });
    const other = (await aliceSiy.get('/problems')).body.categories.find((x) => x.name === 'Other');
    expect((await aliceSiy.post('/requests', { categoryId: other.id, title: 'Something odd', description: 'x' })).body.request.status).toBe('OPEN');
  });

  test('Tanzeem: prices on the request, delivery takes from stock, never below zero; stock adjustments', async () => {
    await sync();
    const items = (await aliceTan.get('/requests/catalogue')).body.items;
    const tape = items.find((x) => x.name === 'Cello Tape — 3 inch');
    const cup = items.find((x) => x.name === 'Cup Saucer — Pcs (4)');
    const req = (await aliceTan.post('/requests/service', {
      items: [{ catalogueItemId: tape.id, quantity: 5, reason: 'Packing' }, { catalogueItemId: cup.id, quantity: 2, reason: 'Guests' }],
    })).body.request;
    expect(req.items.map((x) => [x.kind, x.unitPrice, x.stock])).toEqual([['supply', 25, 24], ['supply', 340, 0]]);

    await tanAdmin.post(`/requests/${req.number}/items/decide`, { decisions: req.items.map((x) => ({ itemId: x.id, decision: 'approve' })) });
    await tanAdmin.post(`/requests/${req.number}/actions/assign`, { engineerId: ids.peon });
    const peon = as(await session('40000031', 'ENGINEER'));
    await peon.post(`/requests/${req.number}/actions/start`);
    const d1 = await peon.post(`/requests/${req.number}/items/${req.items[0].id}/deliver`, {});
    expect(d1.status).toBe(200);
    expect(d1.body.request.items[0]).toMatchObject({ status: 'DELIVERED', stock: 19 });
    const d2 = await peon.post(`/requests/${req.number}/items/${req.items[1].id}/deliver`, {});
    expect(d2.status).toBe(409);
    expect(d2.body.code).toBe('not_enough_stock');

    // Stock adjustments: Admin only, reason required, never negative.
    expect((await tanAdmin.post(`/requests/catalogue/${cup.id}/stock`, { change: 5 })).body.code).toBe('reason_required');
    expect((await tanAdmin.post(`/requests/catalogue/${cup.id}/stock`, { change: -1, reason: 'Broken one' })).body.code).toBe('negative_stock');
    expect((await tanAdmin.post(`/requests/catalogue/${cup.id}/stock`, { setTo: 4, reason: 'Counted the store' })).body.item.stock).toBe(4);
    expect((await peon.post(`/requests/catalogue/${cup.id}/stock`, { change: 1, reason: 'xxx' })).status).toBe(404);
    expect((await peon.post(`/requests/${req.number}/items/${req.items[1].id}/deliver`, {})).body.request.status).toBe('RESOLVED');
    const moves = (await tanAdmin.get(`/requests/catalogue/${cup.id}/stock`)).body.movements;
    expect(moves[0]).toMatchObject({ kind: 'delivery', change: -2, stockAfter: 2, request: req.number });
    expect((await siyAdmin.get(`/requests/catalogue/${cup.id}/stock`)).status).toBe(404); // another company
  });
});

if (!enabled) {
  test('step B integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
