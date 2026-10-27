// Phase 8.2 room occupancy on real PostgreSQL: sheet → seats, My assets "at your seat", "Sits here",
// seats ending, guards, Sync now. Google Sheets and eJamaat mocked.
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

const HEADER = ['S.No', 'Building', 'Floor', 'Department', 'Room No', 'Place', 'ITS/Emp ID', 'Name', 'Intercom', 'DID No'];
const row = (room, place, id, intercom = '') => ['1', 'Admin Bldg', 'Sixth', 'Accounts', room, place, id, 'x', intercom, ''];
const sheet = (...rows) => [{ tab: 'ADMIN BLDG', rows: [['MAROL'], HEADER, ...rows] }];

maybe('room occupancy on real PostgreSQL', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const request = require('supertest');
  const pool = require('../../db/pool');
  const ejamaat = require('../../services/ejamaatClient');
  const { config } = require('../../config/env');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');
  const { runOccupancySync, readSheets } = require('../../modules/sync/occupancySync');

  let app;
  const ids = {};
  let admin;
  let alice;
  const log = () => {};
  const run = (sheets, opts = {}) => runOccupancySync({ readSource: async () => sheets, log, ...opts });

  async function addUser(its, name, roles, { employeeId } = {}) {
    const { rows } = employeeId
      ? await pool.query(`INSERT INTO users (login_type, employee_id, name, source, legacy_password) VALUES ('EMPLOYEE_ID', $1, $2, 'hr', $1) RETURNING id`, [employeeId, name])
      : await pool.query(`INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`, [its, name]);
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }
  const login = async (its, role) => (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role })).body.token;
  const as = (token) => (method, p, b) => request(app)[method](`/Atom/api${p}`).set('Authorization', `Bearer ${token}`).send(b);

  async function addAsset(tag, placeId, holder = null) {
    const { id: cat, service_unit_id: unit } = (await pool.query(`SELECT id, service_unit_id FROM asset_categories WHERE name = 'Monitor'`)).rows[0];
    await pool.query(
      `INSERT INTO assets (asset_tag, category_id, service_unit_id, place_id, holder_user_id, status, source) VALUES ($1, $2, $3, $4, $5, $6, 'atom')`,
      [tag, cat, unit, placeId, holder, holder ? 'IN_USE' : 'IN_STORE']
    );
  }
  const place = async (name, room, cubicle = null) =>
    (await pool.query('INSERT INTO places (name, room_no, cubicle) VALUES ($1, $2, $3) RETURNING id', [name, room, cubicle])).rows[0].id;

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
    await pool.query(`TRUNCATE place_occupants, asset_events, assets, asset_category_aliases, asset_categories, places,
                      user_change_log, user_service_units, user_posts, user_status_log, user_roles, password_reset_tokens, users
                      RESTART IDENTITY CASCADE`);
    await pool.query(`DELETE FROM src.sync_runs WHERE job = 'occupancy'`);
    await pool.query(`INSERT INTO asset_categories (name, service_unit_id) SELECT 'Monitor', id FROM service_units WHERE code = 'AVIT'`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    ids.admin = await addUser('30328701', 'Qusai', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);
    ids.staff = await addUser(null, 'Staff 1301', ['EMPLOYEE'], { employeeId: '1301' });
    admin = as(await login('30328701', 'SUPER_ADMIN'));
    alice = as(await login('40000001'));

    ids.p1615 = await place('Accounts 1615', '1615');
    ids.p1615C = await place('1615-C', '1615', 'C');
    ids.p1615D = await place('1615-D', '1615', 'D');
    await addAsset('MON-C', ids.p1615C);
    await addAsset('MON-D', ids.p1615D);
    await addAsset('PRN-ROOM', ids.p1615);
    await addAsset('MON-HELD', ids.p1615C, ids.admin);
  });

  test('sheet → seats; My assets shows cubicle + shared room items, not someone else’s', async () => {
    const r = await run(sheet(row('1615', 'C', '40000001', '615'), row('1615-D', '', '1301'), row('2021', 'A', '99999999'), row('Lobby', '', '1301')));
    expect(r.status).toBe('success');
    expect(r.summary.seats).toMatchObject({ seats: 2, people: 2, created: 2, ended: 0, unknownPeople: 1, unknownSample: ['99999999'], roomsWithoutPlace: 0 });
    expect(r.counts.skipped).toEqual({ no_person_id: 0, no_room: 1 });

    const mine = (await alice('get', '/inventory/mine')).body;
    expect(mine.assets).toEqual([]);
    expect(mine.seats).toEqual([{ roomNo: '1615', cubicle: 'C', building: 'Admin Bldg', floor: 'Sixth', department: 'Accounts', intercom: '615', didNo: null }]);
    expect(mine.roomAssets.map((a) => [a.tag, a.shared])).toEqual([['PRN-ROOM', true], ['MON-C', false]]);

    const asset = (await admin('get', '/inventory/assets/MON-D')).body.asset;
    expect(asset.sitsHere).toEqual([{ id: ids.staff, name: 'Staff 1301', itsNumber: null, employeeId: '1301', cubicle: 'D' }]);
    const room = (await admin('get', '/inventory/assets/PRN-ROOM')).body.asset;
    expect(room.sitsHere.map((p) => p.name)).toEqual(['Alice Hamid', 'Staff 1301']);
  });

  test('seat moves: old seat ends (kept as history), new one starts; inactive users skipped', async () => {
    await run(sheet(row('1615', 'C', '40000001'), row('1615', 'D', '1301')));
    await pool.query('UPDATE users SET is_active = FALSE WHERE id = $1', [ids.staff]);
    const r = await run(sheet(row('1615', 'D', '40000001'), row('1615', 'D', '1301')));
    expect(r.summary.seats).toMatchObject({ seats: 1, created: 1, ended: 2, inactivePeople: 1 });
    const all = (await pool.query(`SELECT user_id::text, cubicle, is_active, ended_at IS NOT NULL AS ended FROM place_occupants ORDER BY id`)).rows;
    expect(all).toEqual([
      { user_id: ids.alice, cubicle: 'C', is_active: false, ended: true },
      { user_id: ids.staff, cubicle: 'D', is_active: false, ended: true },
      { user_id: ids.alice, cubicle: 'D', is_active: true, ended: false },
    ]);
    expect((await alice('get', '/inventory/mine')).body.roomAssets.map((a) => a.tag)).toEqual(['PRN-ROOM', 'MON-D']);
  });

  test('guards: empty sheet blocked; under half blocked unless forced; rooms without a place reported', async () => {
    expect((await run(sheet())).status).toBe('blocked');
    await run(sheet(row('1615', 'C', '40000001'), row('1615', 'D', '1301'), row('9999', '', '30328701')));
    const ok = (await pool.query(`SELECT summary FROM src.sync_runs WHERE job='occupancy' AND status='success'`)).rows[0].summary;
    expect(ok.seats).toMatchObject({ roomsWithoutPlace: 1, roomSample: ['9999'] });
    const blocked = await run(sheet(row('1615', 'C', '40000001')));
    expect(blocked).toMatchObject({ status: 'blocked' });
    expect(blocked.message).toMatch(/under 50%/);
    expect((await pool.query('SELECT count(*)::int AS n FROM place_occupants WHERE is_active')).rows[0].n).toBe(3);
    expect((await run(sheet(row('1615', 'C', '40000001')), { force: true })).status).toBe('success');
    expect((await pool.query('SELECT count(*)::int AS n FROM place_occupants WHERE is_active')).rows[0].n).toBe(1);
  });

  test('CSV file instead of the Google Sheet; Google Sheet read errors are a failed run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atom-occ-'));
    const file = path.join(dir, 'sheet.csv');
    fs.writeFileSync(file, `MAROL\n${HEADER.join(',')}\n1,Admin Bldg,Sixth,Accounts,1615-C,,40000001,A,615,\n`);
    const r = await runOccupancySync({ file, log });
    expect(r).toMatchObject({ status: 'success', summary: { source: 'file', seats: { seats: 1 } } });
    fs.rmSync(dir, { recursive: true, force: true });

    config.occupancy.sheetId = 'SHEET123';
    const html = jest.fn().mockResolvedValue({ ok: true, text: async () => '<!DOCTYPE html><html>login</html>' });
    await expect(readSheets({ fetchImpl: html })).rejects.toThrow(/returned a web page/);
    const fetched = jest.fn().mockResolvedValue({ ok: true, text: async () => `x\n${HEADER.join(',')}\n1,A,B,C,1615,C,40000001,n,1,2\n` });
    const sheets = await readSheets({ fetchImpl: fetched });
    expect(fetched.mock.calls[0][0]).toBe('https://docs.google.com/spreadsheets/d/SHEET123/gviz/tq?tqx=out:csv&sheet=ADMIN%20BLDG');
    expect(sheets[0].rows[2][6]).toBe('40000001');
    const failed = await runOccupancySync({ readSource: () => readSheets({ fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 404 }) }), log });
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.message).toMatch(/HTTP 404/);
    config.occupancy.sheetId = '';
  });

  test('Sync now + runs list for Super Admin only', async () => {
    config.occupancy.sheetId = '';
    const r = await admin('post', '/sync/occupancy', {});
    expect(r.status).toBe(502);
    expect(r.body.message).toMatch(/OCCUPANCY_SHEET_ID is not set/);
    expect((await admin('get', '/sync/runs?job=occupancy')).body.runs[0]).toMatchObject({ job: 'occupancy', status: 'failed' });
    expect((await alice('post', '/sync/occupancy', {})).status).toBe(404);
  });
});
