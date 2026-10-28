// Phase 9 catalogue + service requests on real PostgreSQL: create, approve/reject per item,
// assign, deliver (assets handed to the requester), close. eJamaat mocked.
// Runs ONLY when TEST_DATABASE_URL names a "*_test" database.
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

maybe('service requests on real PostgreSQL', () => {
  const request = require('supertest');
  const pool = require('../../db/pool');
  const { staffOf, adminOf } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  const ids = {};
  let admin;
  let alice;
  let bob;
  let eng1;
  let eng2;
  const cat = {};

  async function addUser(its, name, roles) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`, [its, name]);
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }
  const login = async (its, role) => (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role })).body.token;
  const as = (token) => {
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    const R = '/Atom/api/requests';
    return {
      get: (p) => auth(request(app).get(`${R}${p}`)),
      post: (p, b = {}) => auth(request(app).post(`${R}${p}`)).send(b),
      patch: (p, b = {}) => auth(request(app).patch(`${R}${p}`)).send(b),
      mine: () => auth(request(app).get('/Atom/api/inventory/mine')),
      notes: () => auth(request(app).get('/Atom/api/notifications')),
    };
  };
  const raise = (who, items, extra = {}) => who.post('/service', { items, ...extra });

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: () => {} });
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE request_item_assets, request_items, place_occupants, asset_events, assets, asset_category_aliases,
                      asset_categories, places, notifications, request_attachments, request_events, requests, user_change_log,
                      user_service_units, user_posts, user_status_log, user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query(`SELECT setval('request_number_seq', 1001, false)`);
    await pool.query('TRUNCATE catalogue_items RESTART IDENTITY CASCADE');
    await pool.query(`INSERT INTO catalogue_items (name, kind, service_unit_id, sort_order)
                      SELECT v.n, v.k, s.id, v.o FROM service_units s,
                             (VALUES ('Office 365','software',10), ('Headset','physical',50), ('Mouse','physical',70)) v(n,k,o)
                       WHERE s.code = 'AVIT'`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    ids.admin = await addUser('30328701', 'Qusai', ['EMPLOYEE']);
    await adminOf(pool, ids.admin);
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);
    ids.bob = await addUser('40000002', 'Bob Saifee', ['EMPLOYEE']);
    ids.eng1 = await addUser('40000003', 'Eng One', ['EMPLOYEE', 'ENGINEER']);
    ids.eng2 = await addUser('40000004', 'Eng Two', ['EMPLOYEE', 'ENGINEER']);
    const avit = (await pool.query(`SELECT id FROM service_units WHERE code='AVIT'`)).rows[0].id;
    for (const e of [ids.eng1, ids.eng2]) await staffOf(pool, e);
    admin = as(await login('30328701', 'ADMIN'));
    alice = as(await login('40000001'));
    bob = as(await login('40000002'));
    eng1 = as(await login('40000003', 'ENGINEER'));
    eng2 = as(await login('40000004', 'ENGINEER'));

    const { rows: cats } = await pool.query('SELECT id, name FROM catalogue_items');
    for (const r of cats) cat[r.name] = String(r.id);
    const hc = (await pool.query(`INSERT INTO asset_categories (name, service_unit_id) VALUES ('Headset', $1) RETURNING id`, [avit])).rows[0].id;
    for (const [tag, status, holder] of [['HS-01', 'IN_STORE', null], ['HS-02', 'IN_STORE', null], ['HS-03', 'IN_USE', ids.bob]]) {
      await pool.query(
        `INSERT INTO assets (asset_tag, name, category_id, service_unit_id, status, holder_user_id, source) VALUES ($1, 'Jabra headset', $2, $3, $4, $5, 'snipeit')`,
        [tag, hc, avit, status, holder]
      );
    }
  });

  const items = () => [
    { catalogueItemId: cat['Office 365'], quantity: 1, reason: 'New staff member needs Outlook' },
    { catalogueItemId: cat.Headset, quantity: 2, reason: 'Online classes' },
    { name: 'Wireless presenter', quantity: 1, reason: 'For the majlis hall' },
  ];

  test('catalogue: everyone reads active items; only Super Admin edits', async () => {
    expect((await alice.get('/catalogue')).body.items.map((i) => i.name)).toEqual(['Office 365', 'Headset', 'Mouse']);
    expect((await alice.post('/catalogue', { name: 'Laptop' })).status).toBe(404);
    const made = (await admin.post('/catalogue', { name: 'Laptop', kind: 'physical', description: 'For staff who travel' })).body.item;
    expect(made).toMatchObject({ name: 'Laptop', kind: 'physical', isActive: true });
    expect((await admin.post('/catalogue', { name: 'laptop' })).status).toBe(409);
    expect((await admin.post('/catalogue', { name: 'X', kind: 'physical' })).status).toBe(400);
    expect((await admin.post('/catalogue', { name: 'Thing', kind: 'car' })).status).toBe(400);
    expect((await admin.patch(`/catalogue/${made.id}`, { isActive: false })).body.item.isActive).toBe(false);
    expect((await alice.get('/catalogue')).body.items).toHaveLength(3);
    expect((await admin.get('/catalogue?includeInactive=1')).body.items).toHaveLength(4);
  });

  test('raise: items + something else → R-1001 waiting for approval; not in the Assign queue', async () => {
    const r = await raise(alice, items());
    expect(r.status).toBe(201);
    const sr = r.body.request;
    expect(sr).toMatchObject({ number: 'R-1001', type: 'SERVICE_REQUEST', status: 'PENDING_APPROVAL', title: 'Office 365, Headset ×2, Wireless presenter' });
    expect(sr.items.map((i) => [i.name, i.kind, i.quantity, i.status])).toEqual([
      ['Office 365', 'software', 1, 'PENDING'], ['Headset', 'physical', 2, 'PENDING'], ['Wireless presenter', 'service', 1, 'PENDING'],
    ]);
    expect(sr.description).toContain('• Headset ×2 — Online classes');
    expect(sr.permissions).toMatchObject({ canDecideItems: false, canDeliverItems: false });

    expect((await admin.get('/counts')).body.counts).toMatchObject({ approvals: 1, assignQueue: 0 });
    expect((await admin.get('/queue/assign')).body.total).toBe(0);
    expect((await admin.get('/all?status=approval')).body.requests.map((x) => x.number)).toEqual(['R-1001']);
    expect((await admin.get('/all?type=TICKET')).body.total).toBe(0);
    expect((await admin.notes()).body.notifications[0]).toMatchObject({ title: 'New request R-1001 to approve' });
    expect((await alice.get('/mine')).body.requests[0]).toMatchObject({ number: 'R-1001', status: 'PENDING_APPROVAL' });
    expect((await bob.get('/R-1001')).status).toBe(404);

    // Validation
    expect((await raise(alice, [])).status).toBe(400);
    expect((await raise(alice, [{ catalogueItemId: cat.Mouse, quantity: 1, reason: 'x' }])).status).toBe(400);
    expect((await raise(alice, [{ catalogueItemId: cat.Mouse, quantity: 0, reason: 'broken one' }])).status).toBe(400);
    expect((await raise(alice, [{ catalogueItemId: '999999', quantity: 1, reason: 'need it' }])).status).toBe(400);
    expect((await raise(alice, [{ name: '', quantity: 1, reason: 'need it' }])).status).toBe(400);
    expect((await raise(alice, Array(11).fill({ catalogueItemId: cat.Mouse, quantity: 1, reason: 'need it' }))).status).toBe(400);
    expect((await raise(alice, items(), { requesterId: ids.bob })).status).toBe(404);
    expect((await raise(admin, items(), { requesterId: ids.bob })).body.request).toMatchObject({ requester: { name: 'Bob Saifee' } });
  });

  test('approve / reject per item → OPEN; the requester is told; Assign queue picks it up', async () => {
    const sr = (await raise(alice, items())).body.request;
    const [o365, headset, other] = sr.items;
    expect((await alice.post('/R-1001/items/decide', { decisions: [{ itemId: o365.id, decision: 'approve' }] })).status).toBe(404);
    expect((await eng1.post('/R-1001/items/decide', { decisions: [{ itemId: o365.id, decision: 'approve' }] })).status).toBe(404);
    expect((await admin.post('/R-1001/items/decide', { decisions: [{ itemId: other.id, decision: 'reject' }] })).status).toBe(400);
    expect((await admin.post('/R-1001/items/decide', { decisions: [{ itemId: '999', decision: 'approve' }] })).status).toBe(400);

    let r = (await admin.post('/R-1001/items/decide', { decisions: [{ itemId: o365.id, decision: 'approve' }] })).body.request;
    expect(r.status).toBe('PENDING_APPROVAL');
    expect((await admin.post('/R-1001/items/decide', { decisions: [{ itemId: o365.id, decision: 'reject', note: 'changed my mind' }] })).status).toBe(409);
    r = (
      await admin.post('/R-1001/items/decide', {
        decisions: [
          { itemId: headset.id, decision: 'approve', note: 'One from store, one ordered' },
          { itemId: other.id, decision: 'reject', note: 'The hall already has one' },
        ],
      })
    ).body.request;
    expect(r.status).toBe('OPEN');
    expect(r.items.map((i) => [i.status, i.decidedBy])).toEqual([['APPROVED', 'Qusai'], ['APPROVED', 'Qusai'], ['REJECTED', 'Qusai']]);
    expect(r.items[2].decisionNote).toBe('The hall already has one');
    expect(r.events.map((e) => e.type)).toEqual(['created', 'item_approved', 'item_approved', 'item_rejected', 'status']);
    expect(r.events[4].data).toMatchObject({ action: 'approved', approved: 2, rejected: 1 });
    expect((await alice.notes()).body.notifications[0]).toMatchObject({ title: 'R-1001: 2 approved, 1 not approved' });
    expect((await admin.get('/queue/assign')).body.requests.map((x) => x.number)).toEqual(['R-1001']);
    expect((await admin.get('/counts')).body.counts).toMatchObject({ approvals: 0, assignQueue: 1 });
  });

  test('all items rejected → REJECTED; or the whole request rejected while waiting', async () => {
    const sr = (await raise(alice, items().slice(0, 1))).body.request;
    const r = (await admin.post('/R-1001/items/decide', { decisions: [{ itemId: sr.items[0].id, decision: 'reject', note: 'No licence left' }] })).body.request;
    expect(r).toMatchObject({ status: 'REJECTED', rejectionNote: 'None of the items were approved.' });
    expect((await alice.notes()).body.notifications[0]).toMatchObject({ title: 'R-1001 was not approved' });

    await raise(alice, items());
    expect((await admin.post('/R-1002/actions/assign', { engineerId: ids.eng1 })).status).toBe(409);
    expect((await admin.post('/R-1002/actions/reject', { note: 'Duplicate of R-1001' })).body.request.status).toBe('REJECTED');
  });

  test('deliver: assets handed to the requester, software with a note; last delivery → Delivered; then closed', async () => {
    const sr = (await raise(alice, items())).body.request;
    const [o365, headset, other] = sr.items;
    await admin.post('/R-1001/items/decide', {
      decisions: [{ itemId: o365.id, decision: 'approve' }, { itemId: headset.id, decision: 'approve' }, { itemId: other.id, decision: 'reject', note: 'Not needed' }],
    });
    await admin.post('/R-1001/actions/assign', { engineerId: ids.eng1 });
    expect((await eng1.post(`/R-1001/items/${o365.id}/deliver`, { note: 'done' })).status).toBe(409); // not started
    expect((await eng2.post(`/R-1001/items/${o365.id}/deliver`, { note: 'done' })).status).toBe(404); // not theirs
    await eng1.post('/R-1001/actions/start');
    expect((await eng1.get('/R-1001')).body.request.permissions).toMatchObject({ canDeliverItems: true, actions: expect.not.arrayContaining(['resolve']) });
    expect((await eng1.post('/R-1001/actions/resolve', { note: 'all done' })).status).toBe(409);

    // Physical: assets or an explanation; only in-store assets; not more than asked; rejected item can't be delivered.
    expect((await eng1.post(`/R-1001/items/${headset.id}/deliver`, {})).status).toBe(400);
    expect((await eng1.post(`/R-1001/items/${headset.id}/deliver`, { assetTags: ['HS-03'] })).status).toBe(409);
    expect((await eng1.post(`/R-1001/items/${headset.id}/deliver`, { assetTags: ['HS-01', 'HS-02', 'HS-03'] })).status).toBe(400);
    expect((await eng1.post(`/R-1001/items/${other.id}/deliver`, { note: 'x' })).status).toBe(409);
    expect((await eng1.post(`/R-1001/items/${o365.id}/deliver`, { assetTags: ['HS-01'] })).status).toBe(400);

    let r = (await eng1.post(`/R-1001/items/${headset.id}/deliver`, { assetTags: ['hs-01', 'HS-02'], note: 'Both handed over at desk' })).body.request;
    expect(r.status).toBe('IN_PROGRESS');
    expect(r.items[1]).toMatchObject({ status: 'DELIVERED', deliveredBy: 'Eng One', assets: [{ tag: 'HS-01' }, { tag: 'HS-02' }] });
    expect((await alice.mine()).body.assets.map((a) => a.tag)).toEqual(['HS-01', 'HS-02']);
    const ev = (await pool.query(`SELECT e.note, e.data FROM asset_events e JOIN assets a ON a.id = e.asset_id WHERE a.asset_tag = 'HS-01'`)).rows[0];
    expect(ev).toMatchObject({ note: 'Delivered for R-1001', data: { request: 'R-1001', to: { id: ids.alice } } });
    expect((await pool.query(`SELECT edited_in_atom_at IS NOT NULL AS edited FROM assets WHERE asset_tag = 'HS-01'`)).rows[0].edited).toBe(true);
    expect((await alice.notes()).body.notifications[0]).toMatchObject({ title: 'R-1001: Headset delivered' });

    r = (await eng1.post(`/R-1001/items/${o365.id}/deliver`, { note: 'Licence sent to your email' })).body.request;
    expect(r).toMatchObject({ status: 'RESOLVED', resolution: 'All approved items delivered.' });
    expect((await eng1.post(`/R-1001/items/${o365.id}/deliver`, { note: 'again' })).status).toBe(409);
    expect((await alice.notes()).body.notifications[0]).toMatchObject({ title: 'R-1001 is delivered' });
    expect((await admin.get('/queue/assign?view=to_close')).body.requests.map((x) => x.number)).toEqual(['R-1001']);
    expect((await admin.post('/R-1001/actions/close')).body.request.status).toBe('CLOSED');
  });
});
