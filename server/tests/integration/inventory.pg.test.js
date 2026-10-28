// Phase 8 inventory on real PostgreSQL: Snipe-IT CSV import (preview / commit / re-import) and the
// inventory API. eJamaat mocked. Runs ONLY when TEST_DATABASE_URL names a "*_test" database.
// Optional: SNIPEIT_CSV=/path/to/export.csv also imports a real export (and re-imports it).
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

// Same columns as the real "custom assets report" (duplicate names included).
const HEADERS = ['ID', 'Company', 'Asset Name', 'Asset Tag', 'Model', 'Model No.', 'Category', 'Manufacturer', 'Serial',
  'Purchased', 'EOL', 'Order Number', 'Supplier', 'Location', 'Address', 'Address', 'City', 'State', 'Country', 'Zip',
  'Default Location', 'Address', 'Address', 'City', 'State', 'Country', 'Zip', 'Checked Out', 'Type', 'Username',
  'Employee No.', 'Manager', 'Department', 'Title', 'Status', 'Checkout Date', 'Expected Checkin Date', 'Created At',
  'Updated at', 'Deleted', 'Last Audit', 'Next Audit Date', 'Notes', 'URL', 'MAC Address', 'IP Address'];

const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
function csv(rows) {
  const lines = [HEADERS.join(',')];
  for (const r of rows) {
    const vals = HEADERS.map((h, i) => {
      // first "Address"/"City"… are the location's, second the default location's — keep empty
      if (['Address', 'City', 'State', 'Country', 'Zip'].includes(h)) return '';
      return r[h] ?? '';
    });
    vals[HEADERS.indexOf('Default Location')] = r['Default Location'] ?? '';
    lines.push(vals.map((v) => q(String(v))).join(','));
  }
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

const A = (id, tag, over = {}) => ({
  ID: String(id), Company: 'IT Department', 'Asset Tag': tag, Model: 'Generic', Category: 'Monitor',
  Manufacturer: 'Dell', Status: 'Ready to Deploy (deployable)', Location: 'IT Store Room', Purchased: '05-11-2022 00:00',
  ...over,
});

const BASE = [
  A(8, 'AJSM-PTZ-C01', { Category: 'PTZ Camera', Serial: 'H2TRA0027', Status: 'Deployed (deployed)', Location: 'MCR-Video', 'Checked Out': 'MCR-Video', Type: 'location' }),
  A(9, 'AJSM-KBM-001', { Category: 'Keyboard-Mouse Combo', Serial: 'KBM1' }),
  A(10, 'AJSM-KBM-002', { Category: 'Keyboard Mouse Combo', Serial: 'KBM2' }),
  A(11, 'AJSM-PH-001', { Category: 'IP Phone', Serial: '9.18E+11', Status: 'Deployed (deployed)', Location: '1615-C', 'Checked Out': '1615-C', Type: 'location' }),
  A(12, 'AJSM-TV-005', { Category: 'Television', Status: 'Deployed (deployed)', 'Checked Out': 'Admin Marol', Type: 'user', Location: 'AV Store Room', Notes: 'with 1 Remote,\nand a cable' }),
  A(13, 'AJSM-OLD-001', { Status: 'Archived (archived)' }),
  A(14, 'AJSM-PND-001', { Status: 'Pending (deployed)' }),
  A(15, 'AJSM-FQ-001', { Status: 'FQ-GS-Table-B (deployed)', Location: 'FQ-Confrence Room' }),
  A(16, 'AJSM-MSK-001', { Location: 'Maskan 10th Floor 2101' }),
  A(17, 'AJSM-LSR-001', { Category: 'Loser Measurement', Purchased: '31-02-2023 00:00' }),
];

maybe('inventory on real PostgreSQL', () => {
  const fs = require('fs');
  const request = require('supertest');
  const pool = require('../../db/pool');
  const { staffOf } = require('../helpers/companyPeople');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  const ids = {};
  const rows = async (sql, params) => (await pool.query(sql, params)).rows;

  async function addUser(its, name, roles) {
    const { rows: r } = await pool.query(
      `INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`,
      [its, name]
    );
    for (const role of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [r[0].id, role]);
    return String(r[0].id);
  }
  const login = async (its, role) => (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role })).body.token;
  const as = (token) => {
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return {
      get: (p) => auth(request(app).get(`/Atom/api/inventory${p}`)),
      post: (p, b) => auth(request(app).post(`/Atom/api/inventory${p}`)).send(b),
      patch: (p, b) => auth(request(app).patch(`/Atom/api/inventory${p}`)).send(b),
      import: (buf, fields = {}, name = 'export.csv') => {
        let r = auth(request(app).post('/Atom/api/inventory/import'));
        for (const [k, v] of Object.entries(fields)) r = r.field(k, String(v));
        return r.attach('file', buf, { filename: name, contentType: 'application/vnd.ms-excel' });
      },
    };
  };
  let admin;
  let eng;
  let alice;

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
    await pool.query(`TRUNCATE asset_events, asset_imports, assets, asset_category_aliases, asset_categories, places,
                      invoice_links, invoices, notifications, request_attachments, request_events, requests,
                      user_departments, user_change_log, user_service_units, user_posts, user_status_log, user_roles,
                      password_reset_tokens, users, departments RESTART IDENTITY CASCADE`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    ids.admin = await addUser('30328701', 'Qusai', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.eng = await addUser('40000003', 'Eng One', ['EMPLOYEE', 'ENGINEER']);
    await staffOf(pool, ids.eng);
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);
    // A department with the room 1615 (Phase 3.1 data) → places in room 1615 get its building/floor.
    await pool.query(`INSERT INTO departments (idarah_id, name, building, floor, room_no) VALUES ('6013', 'Culture Générale', 'Admin Bldg', 'Sixth', '1615')`);
    admin = as(await login('30328701', 'SUPER_ADMIN'));
    eng = as(await login('40000003', 'ENGINEER'));
    alice = as(await login('40000001'));
  });

  test('preview saves nothing; commit imports with every mapping rule', async () => {
    const preview = await admin.import(csv(BASE));
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      mode: 'preview', rows: 10, valid: 10, created: 10, saved: false, blocked: false,
      flagged: { serialNeedsCheck: 1, holderUnknown: 1 },
      byStatus: { IN_USE: 4, IN_STORE: 4, RETIRED: 1, IN_REPAIR: 1 },
    });
    expect(preview.body.categoryChanges).toEqual(expect.arrayContaining([
      { change: 'Keyboard-Mouse Combo → Keyboard Mouse Combo', count: 1 },
      { change: 'Loser Measurement → Laser Measurement', count: 1 },
    ]));
    expect(preview.body.warnings).toEqual([{ row: 11, tag: 'AJSM-LSR-001', reason: 'Purchase date "31-02-2023 00:00" not understood — left empty.' }]);
    expect((await rows('SELECT count(*)::int AS n FROM assets'))[0].n).toBe(0);

    const done = await admin.import(csv(BASE), { commit: true });
    expect(done.body).toMatchObject({ mode: 'commit', saved: true, created: 10, newCategories: 6, newPlaces: 6 });

    const get = async (tag) => (await admin.get(`/assets/${tag}`)).body.asset;
    expect(await get('AJSM-PTZ-C01')).toMatchObject({
      status: 'IN_USE', serial: 'H2TRA0027', category: { name: 'PTZ Camera' }, place: { name: 'MCR-Video' }, purchasedOn: '2022-11-05', source: 'snipeit',
    });
    // Duplicate categories merged into one.
    const kbm = (await admin.get('/categories')).body.categories.find((c) => c.name === 'Keyboard Mouse Combo');
    expect(kbm.assets).toBe(2);
    // Excel-destroyed serial: blank + flagged. Cubicle place enriched from the department.
    expect(await get('AJSM-PH-001')).toMatchObject({
      serial: null, serialNeedsCheck: true,
      place: { name: '1615-C', roomNo: '1615', cubicle: 'C', building: 'Admin Bldg', floor: 'Sixth', detail: 'Admin Bldg · Sixth floor · Cubicle C' }, // room is already in the name
    });
    // Checked out to the generic account: in use, holder unknown, note kept (with the multi-line Snipe-IT note).
    const tv = await get('AJSM-TV-005');
    expect(tv).toMatchObject({ status: 'IN_USE', holderUnknown: true, holder: null, place: { name: 'AV Store Room' } });
    expect(tv.notes).toBe('with 1 Remote,\nand a cable\nChecked out in Snipe-IT to "Admin Marol" — assign the real person.');
    expect((await get('AJSM-OLD-001')).status).toBe('RETIRED');
    expect((await get('AJSM-PND-001')).status).toBe('IN_REPAIR');
    const fq = await get('AJSM-FQ-001');
    expect(fq).toMatchObject({ status: 'IN_USE', notes: 'Snipe-IT status: FQ-GS-Table-B', place: { name: 'FQ-Conference Room' } });
    expect((await get('AJSM-MSK-001')).place).toMatchObject({ building: 'Maskan', floor: '10th', roomNo: '2101' });
    expect((await get('AJSM-LSR-001')).category.name).toBe('Laser Measurement');
    expect(tv.history.map((h) => h.type)).toEqual(['imported']);

    const log = (await admin.get('/imports')).body.imports;
    expect(log[0]).toMatchObject({ fileName: 'export.csv', rows: 10, summary: { created: 10 }, by: { name: 'Qusai' } });
  });

  test('re-import: identical file changes nothing; changed rows update; ATOM edits are warned about or kept', async () => {
    await admin.import(csv(BASE), { commit: true });
    const same = await admin.import(csv(BASE), { commit: true });
    expect(same.body).toMatchObject({ created: 0, updated: 0, unchanged: 10, newPlaces: 0, newCategories: 0 });

    // In ATOM: assign the "holder unknown" TV to Alice, and edit a monitor's notes.
    await admin.post('/assets/AJSM-TV-005/assign', { userId: ids.alice });
    await admin.patch('/assets/AJSM-KBM-001', { notes: 'Checked by AVIT' });

    // Snipe-IT changed one asset (moved) and added one.
    const next = BASE.map((r) => (r['Asset Tag'] === 'AJSM-KBM-002' ? { ...r, Location: 'IT Server Room' } : r));
    next.push(A(18, 'AJSM-NEW-001'));

    const keep = await admin.import(csv(next), { keepAtomEdits: true });
    expect(keep.body).toMatchObject({ created: 1, updated: 1, keptAtomEdits: 2, overwroteAtomEdits: 0, unchanged: 7, newPlaces: 1 });
    expect(keep.body.kept.sort()).toEqual(['AJSM-KBM-001', 'AJSM-TV-005']);

    const over = await admin.import(csv(next), { commit: true });
    expect(over.body).toMatchObject({ created: 1, updated: 3, overwroteAtomEdits: 2 });
    expect(over.body.overwritten.sort()).toEqual(['AJSM-KBM-001', 'AJSM-TV-005']);
    const tv = (await admin.get('/assets/AJSM-TV-005')).body.asset;
    expect(tv).toMatchObject({ holder: null, holderUnknown: true });
    expect(tv.history[0]).toMatchObject({ type: 'reimported' });
    expect(tv.history[0].data.changed).toEqual(expect.arrayContaining(['holder_unknown', 'holder_user_id']));
    expect((await admin.get('/assets/AJSM-KBM-002')).body.asset.place.name).toBe('IT Server Room');

    // Assets missing from a later file are left alone (reported).
    const fewer = await admin.import(csv(next.slice(0, 5)), {});
    expect(fewer.body.notInFileCount).toBe(6);
    expect((await rows(`SELECT count(*)::int AS n FROM assets WHERE status <> 'RETIRED'`))[0].n).toBe(10);
  });

  test('a renamed or merged category keeps catching re-imports', async () => {
    await admin.import(csv(BASE), { commit: true });
    const cats = (await admin.get('/categories')).body.categories;
    const monitor = cats.find((c) => c.name === 'Monitor');
    const ptz = cats.find((c) => c.name === 'PTZ Camera');
    expect((await admin.patch(`/categories/${monitor.id}`, { name: 'Display' })).body.category.name).toBe('Display');
    expect((await admin.post(`/categories/${ptz.id}/merge`, { intoId: monitor.id })).body).toMatchObject({ merged: 1, into: { name: 'Display' } });

    const again = await admin.import(csv(BASE), { commit: true });
    expect(again.body).toMatchObject({ newCategories: 0, created: 0 });
    expect((await admin.get('/assets/AJSM-PTZ-C01')).body.asset.category.name).toBe('Display');
    expect((await admin.get('/categories')).body.categories.map((c) => c.name)).not.toContain('PTZ Camera');
  });

  test('errors block the import unless "skip rows with errors"; bad files are refused', async () => {
    const dup = [...BASE, A(99, 'ajsm-ptz-c01\t'), A(100, '')];
    const blocked = await admin.import(csv(dup), { commit: true });
    expect(blocked.body).toMatchObject({ blocked: true, saved: false, errorCount: 2 });
    expect(blocked.body.errors.map((e) => e.reason)).toEqual(['Duplicate Asset Tag (also on row 2).', 'Asset Tag is empty.']);
    expect((await rows('SELECT count(*)::int AS n FROM assets'))[0].n).toBe(0);

    const skipped = await admin.import(csv(dup), { commit: true, skipErrors: true });
    expect(skipped.body).toMatchObject({ saved: true, created: 10 });
    expect((await rows('SELECT summary FROM asset_imports'))[0].summary.skippedErrors).toBe(2);

    expect((await admin.import(Buffer.from('a,b\n1,2'), {})).body.code).toBe('not_snipeit');
    expect((await admin.import(Buffer.from('"open'), {})).body.code).toBe('bad_csv');
    expect((await admin.import(Buffer.from('x'), {}, 'export.xlsx')).body.code).toBe('bad_file_type');
  });

  test('a tag added by hand in ATOM is never overwritten by an import', async () => {
    const cat = (await admin.post('/categories', { name: 'Monitor' })).body.category;
    expect((await admin.post('/assets', { tag: 'AJSM-KBM-001', categoryId: cat.id, model: 'Hand-made' })).status).toBe(201);
    const r = await admin.import(csv(BASE), { commit: true });
    expect(r.body).toMatchObject({ created: 9, conflictCount: 1, conflicts: ['AJSM-KBM-001'] });
    expect((await admin.get('/assets/AJSM-KBM-001')).body.asset).toMatchObject({ model: 'Hand-made', source: 'atom' });
  });

  test('asset actions: assign / return / move / status / edit, all in history; my assets', async () => {
    await admin.import(csv(BASE), { commit: true });
    const place = (await admin.post('/places', { name: 'AVIT Office', roomNo: '1008', building: 'Admin Bldg', floor: 'Ground' })).body.place;

    let a = (await admin.post('/assets/AJSM-PTZ-C01/assign', { userId: ids.alice, note: 'Joining day' })).body.asset;
    expect(a).toMatchObject({ status: 'IN_USE', holder: { name: 'Alice Hamid' }, holderUnknown: false });
    expect((await alice.get('/mine')).body.assets.map((x) => x.tag)).toEqual(['AJSM-PTZ-C01']);
    expect((await admin.post('/assets/AJSM-PTZ-C01/assign', { userId: ids.alice })).body.code).toBe('no_change');

    a = (await admin.post('/assets/AJSM-PTZ-C01/return', { placeId: place.id })).body.asset;
    expect(a).toMatchObject({ status: 'IN_STORE', holder: null, place: { name: 'AVIT Office', detail: 'Admin Bldg · Ground floor · Room 1008' } });
    expect((await alice.get('/mine')).body.assets).toEqual([]);

    expect((await admin.post('/assets/AJSM-PTZ-C01/status', { status: 'RETIRED' })).body.code).toBe('note_required');
    a = (await admin.post('/assets/AJSM-PTZ-C01/status', { status: 'RETIRED', note: 'Lens broken beyond repair' })).body.asset;
    expect(a.status).toBe('RETIRED');
    expect((await admin.post('/assets/AJSM-PTZ-C01/assign', { userId: ids.alice })).status).toBe(409);

    a = (await admin.patch('/assets/AJSM-PH-001', { serial: 'ZX81-REAL' })).body.asset;
    expect(a).toMatchObject({ serial: 'ZX81-REAL', serialNeedsCheck: false });
    expect(a.history[0]).toMatchObject({ type: 'edited', data: { fields: ['serial', 'serial_needs_check'] }, actor: { name: 'Qusai' } });
    expect(a.editedInAtomAt).toBeTruthy();

    const h = (await admin.get('/assets/AJSM-PTZ-C01')).body.asset.history.map((x) => x.type);
    expect(h).toEqual(['status', 'returned', 'assigned', 'imported']);
  });

  test('lists and filters; roles: engineers read, employees only see their own; others 404', async () => {
    await admin.import(csv(BASE), { commit: true });
    const tags = async (who, qs) => (await who.get(`/assets${qs}`)).body.assets.map((a) => a.tag);
    expect((await admin.get('/assets')).body.total).toBe(9); // retired hidden by default
    expect((await admin.get('/assets?status=all')).body.total).toBe(10);
    expect(await tags(admin, '?attention=serial')).toEqual(['AJSM-PH-001']);
    expect(await tags(admin, '?attention=holder')).toEqual(['AJSM-TV-005']);
    expect(await tags(admin, '?attention=any')).toEqual(['AJSM-PH-001', 'AJSM-TV-005']);
    expect(await tags(admin, '?room=1615')).toEqual(['AJSM-PH-001']);
    expect(await tags(admin, '?q=mcr-video')).toEqual(['AJSM-PTZ-C01']);
    expect(await tags(admin, '?q=H2TRA')).toEqual(['AJSM-PTZ-C01']);
    expect(await tags(eng, '?status=IN_REPAIR')).toEqual(['AJSM-PND-001']);
    expect((await eng.get('/assets/AJSM-TV-005')).body.asset.permissions).toEqual({ canManage: false });
    expect((await eng.get('/places?q=1615')).body.places.map((p) => p.name)).toEqual(['1615-C']);

    for (const p of ['/assets', '/assets/AJSM-TV-005', '/categories', '/places']) expect((await alice.get(p)).status).toBe(404);
    expect((await eng.post('/assets/AJSM-TV-005/assign', { userId: ids.eng })).status).toBe(404);
    expect((await eng.import(csv(BASE), { commit: true })).status).toBe(404);
    expect((await request(app).get('/Atom/api/inventory/mine')).status).toBe(401);
    expect((await admin.get('/assets?status=nope')).status).toBe(400);
  });

  test('places: edit, cubicle upper-cased, can\'t deactivate while assets are there', async () => {
    await admin.import(csv(BASE), { commit: true });
    const store = (await admin.get('/places?q=IT Store')).body.places[0];
    expect((await admin.patch(`/places/${store.id}`, { isActive: false })).body.code).toBe('place_in_use');
    const p = (await admin.patch(`/places/${store.id}`, { building: 'Admin Bldg', cubicle: 'b' })).body.place;
    expect(p).toMatchObject({ building: 'Admin Bldg', cubicle: 'B', name: 'IT Store Room' });
  });

  const realCsv = process.env.SNIPEIT_CSV;
  (realCsv ? test : test.skip)('real Snipe-IT export: imports, then re-imports with no changes', async () => {
    const buf = fs.readFileSync(realCsv);
    const first = await admin.import(buf, { commit: true, skipErrors: true });
    expect(first.body.saved).toBe(true);
    expect(first.body.created).toBe(first.body.valid);
    const second = await admin.import(buf, { commit: true, skipErrors: true });
    expect(second.body).toMatchObject({ created: 0, updated: 0, unchanged: first.body.valid });
  }, 60000);
});

if (!enabled) {
  test('inventory integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
