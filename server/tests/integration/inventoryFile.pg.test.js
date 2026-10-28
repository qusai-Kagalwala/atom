// Inventory export → edit → import back, on real PostgreSQL. eJamaat mocked.
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

maybe('inventory export / import on real PostgreSQL', () => {
  const ExcelJS = require('exceljs');
  const request = require('supertest');
  const pool = require('../../db/pool');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  let admin;
  let eng;
  const ids = {};

  async function addUser(its, name, roles) {
    const { rows } = await pool.query(`INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`, [its, name]);
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }
  const login = async (its, role) => (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role })).body.token;
  const binary = (r) =>
    r.buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  const exportFile = (token, qs = '') => binary(request(app).get(`/Atom/api/inventory/export${qs}`).set('Authorization', `Bearer ${token}`));
  const importFile = (buf, fields = {}) => {
    let r = request(app).post('/Atom/api/inventory/import-file').set('Authorization', `Bearer ${admin}`);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', buf, { filename: 'inventory.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  };
  async function workbook(buf) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    return wb;
  }
  const col = (ws, header) => {
    let n = null;
    ws.getRow(1).eachCell((c, i) => {
      if (String(c.value) === header) n = i;
    });
    return n;
  };
  const rowOf = (ws, tag) => {
    let found = null;
    ws.eachRow((r, i) => {
      if (i > 1 && String(r.getCell(1).value) === tag) found = r;
    });
    return found;
  };

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
    await pool.query(`TRUNCATE inventory_exports, asset_imports, request_item_assets, place_occupants, asset_events, assets, asset_category_aliases,
                      asset_categories, places, user_change_log, user_service_units, user_posts, user_status_log, user_roles,
                      password_reset_tokens, users RESTART IDENTITY CASCADE`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();
    ids.admin = await addUser('30328701', 'Qusai', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);
    await addUser('40000003', 'Eng One', ['EMPLOYEE', 'ENGINEER']);
    admin = await login('30328701', 'SUPER_ADMIN');
    eng = await login('40000003', 'ENGINEER');
    const avit = (await pool.query(`SELECT id FROM service_units WHERE code='AVIT'`)).rows[0].id;
    const mon = (await pool.query(`INSERT INTO asset_categories (name, service_unit_id) VALUES ('Monitor', $1) RETURNING id`, [avit])).rows[0].id;
    await pool.query(`INSERT INTO asset_categories (name, service_unit_id) VALUES ('Projector', $1)`, [avit]);
    const p = (await pool.query(`INSERT INTO places (name, room_no, cubicle) VALUES ('1615-C', '1615', 'C') RETURNING id`)).rows[0].id;
    await pool.query(
      `INSERT INTO assets (asset_tag, name, category_id, service_unit_id, place_id, serial, status, holder_user_id, source, purchased_on)
       VALUES ('AJSM-MON-01', 'Dell 24', $1, $2, $3, '000123', 'IN_USE', $4, 'snipeit', '2023-02-02'),
              ('AJSM-MON-02', 'Dell 22', $1, $2, NULL, NULL, 'IN_STORE', NULL, 'atom', NULL)`,
      [mon, avit, p, ids.alice]
    );
    await pool.query(`UPDATE assets SET updated_at = now() - interval '1 hour'`);
  });

  test('export: Super Admin only; text cells; read-only columns; About sheet', async () => {
    expect((await exportFile(eng)).status).toBe(404);
    const res = await exportFile(admin);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="ATOM-inventory-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    const wb = await workbook(res.body);
    const ws = wb.getWorksheet('Inventory');
    expect(ws.rowCount).toBe(3);
    const r = rowOf(ws, 'AJSM-MON-01');
    expect(r.getCell(col(ws, 'Serial')).value).toBe('000123');
    expect(r.getCell(col(ws, 'Room')).value).toBe('1615');
    expect(r.getCell(col(ws, 'Assigned to (read only)')).value).toBe('Alice Hamid');
    expect(r.getCell(col(ws, 'Serial')).numFmt).toBe('@');
    expect(wb.getWorksheet('About').state).toBe('hidden');
    expect((await pool.query('SELECT rows FROM inventory_exports')).rows).toEqual([{ rows: 2 }]);
    // Filters apply.
    const one = await workbook((await exportFile(admin, '?q=MON-02')).body);
    expect(one.getWorksheet('Inventory').rowCount).toBe(2);
  });

  test('import: preview, then apply edits + new tag + new place; read-only columns ignored; history written', async () => {
    const wb = await workbook((await exportFile(admin)).body);
    const ws = wb.getWorksheet('Inventory');
    const r1 = rowOf(ws, 'AJSM-MON-01');
    r1.getCell(col(ws, 'Model')).value = 'P2422H';
    r1.getCell(col(ws, 'Serial')).value = '';
    r1.getCell(col(ws, 'Cubicle')).value = 'D';
    r1.getCell(col(ws, 'Assigned to (read only)')).value = 'Someone else';
    const r2 = rowOf(ws, 'AJSM-MON-02');
    r2.getCell(col(ws, 'Category')).value = 'projector';
    ws.addRow(['AJSM-NEW-01', 'Epson EB', 'Projector']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const preview = (await importFile(buf)).body;
    expect(preview).toMatchObject({ committed: false, rows: 3, updated: 2, created: 1, unchanged: 0, clears: 1, newPlaces: 1, errors: [] });
    expect(preview.changes.find((c) => c.tag === 'AJSM-MON-01').fields).toEqual([
      { field: 'Model', from: null, to: 'P2422H' },
      { field: 'Serial', from: '000123', to: null },
      { field: 'Place', to: 'Room 1615 · Cubicle D' },
    ]);
    expect((await pool.query(`SELECT model FROM assets WHERE asset_tag = 'AJSM-MON-01'`)).rows[0].model).toBeNull();

    const done = (await importFile(buf, { commit: 'true' })).body;
    expect(done).toMatchObject({ committed: true, updated: 2, created: 1 });
    const a = (await pool.query(
      `SELECT a.model, a.serial, a.holder_user_id::text, a.edited_in_atom_at IS NOT NULL AS edited, p.room_no, p.cubicle
         FROM assets a LEFT JOIN places p ON p.id = a.place_id WHERE asset_tag = 'AJSM-MON-01'`
    )).rows[0];
    expect(a).toEqual({ model: 'P2422H', serial: null, holder_user_id: ids.alice, edited: true, room_no: '1615', cubicle: 'D' });
    expect((await pool.query(`SELECT c.name FROM assets a JOIN asset_categories c ON c.id = a.category_id WHERE asset_tag = 'AJSM-MON-02'`)).rows[0].name).toBe('Projector');
    expect((await pool.query(`SELECT status, source FROM assets WHERE asset_tag = 'AJSM-NEW-01'`)).rows[0]).toEqual({ status: 'IN_STORE', source: 'atom' });
    const ev = (await pool.query(`SELECT e.type, e.note FROM asset_events e JOIN assets a ON a.id = e.asset_id WHERE a.asset_tag = 'AJSM-MON-01'`)).rows;
    expect(ev).toEqual([{ type: 'edited', note: 'Updated from inventory file' }]);
    expect((await pool.query(`SELECT kind, rows FROM asset_imports`)).rows).toEqual([{ kind: 'atom_file', rows: 3 }]);

    // Same file again: nothing to change (the new tag now exists and matches).
    const again = (await importFile(buf)).body;
    expect(again).toMatchObject({ updated: 0, created: 0 });
  });

  test('changed in ATOM after the export → skipped unless overwrite; new tags can be refused; errors block', async () => {
    const wb = await workbook((await exportFile(admin)).body);
    const ws = wb.getWorksheet('Inventory');
    rowOf(ws, 'AJSM-MON-01').getCell(col(ws, 'Notes')).value = 'From the shared file';
    ws.addRow(['AJSM-NEW-02', 'X', 'Projector']);
    ws.addRow(['AJSM-BAD-01', 'Y', 'Toaster']);
    ws.addRow(['AJSM-BAD-02', 'Z', 'Monitor', '', '', '', '', '', '', '31-31-2023']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await pool.query(`UPDATE assets SET name = 'Edited in ATOM meanwhile' WHERE asset_tag = 'AJSM-MON-01'`);

    const p = (await importFile(buf, { allowNew: 'false' })).body;
    expect(p.changedSinceExport.map((x) => x.tag)).toEqual(['AJSM-MON-01']);
    expect(p.newSkipped).toEqual(['AJSM-NEW-02']);
    expect(p.errors.map((e) => [e.tag, e.message])).toEqual([
      ['AJSM-BAD-01', 'Unknown category "Toaster".'],
      ['AJSM-BAD-02', 'Enter the purchase date as YYYY-MM-DD.'],
    ]);
    expect((await importFile(buf, { commit: 'true' })).status).toBe(400);
    const ok = (await importFile(buf, { commit: 'true', skipErrors: 'true', overwrite: 'true', allowNew: 'false' })).body;
    expect(ok).toMatchObject({ committed: true, updated: 1, created: 0 });
    expect((await pool.query(`SELECT name, notes FROM assets WHERE asset_tag = 'AJSM-MON-01'`)).rows[0]).toEqual({ name: 'Dell 24', notes: 'From the shared file' });
  });

  test('wrong files are refused', async () => {
    const res = (buf, name = 'x.xlsx') =>
      request(app).post('/Atom/api/inventory/import-file').set('Authorization', `Bearer ${admin}`).attach('file', buf, { filename: name });
    expect((await res(Buffer.from('a,b'), 'x.csv')).status).toBe(400);
    expect((await res(Buffer.from('not a zip'))).body.code).toBe('bad_file');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1').addRow(['a']);
    expect((await res(Buffer.from(await wb.xlsx.writeBuffer()))).body.code).toBe('bad_file');
    const wb2 = new ExcelJS.Workbook();
    wb2.addWorksheet('Inventory').addRow(['Asset tag', 'Name']);
    expect((await res(Buffer.from(await wb2.xlsx.writeBuffer()))).body.code).toBe('bad_columns');
    const t = await login('40000003', 'ENGINEER');
    expect((await request(app).post('/Atom/api/inventory/import-file').set('Authorization', `Bearer ${t}`).attach('file', Buffer.from('x'), { filename: 'x.xlsx' })).status).toBe(404);
  });
});
