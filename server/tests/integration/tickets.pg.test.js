// Tickets end-to-end on real PostgreSQL + real sharp + real files (HTTP → service → SQL → disk).
// eJamaat mocked. Runs ONLY when TEST_DATABASE_URL points at a database whose name ends in "_test".
const os = require('os');
const path = require('path');
const fs = require('fs');

const URL_ENV = process.env.TEST_DATABASE_URL || '';
let parsed = null;
try {
  parsed = new URL(URL_ENV);
} catch {
  /* not set */
}
const enabled = Boolean(parsed && /_test$/.test(parsed.pathname.slice(1)));
const ATTACH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atom-attach-'));

if (enabled) {
  process.env.PG_HOST = parsed.hostname;
  process.env.PG_PORT = parsed.port || '5432';
  process.env.PG_DATABASE = parsed.pathname.slice(1);
  process.env.PG_USER = decodeURIComponent(parsed.username);
  process.env.PG_PASSWORD = decodeURIComponent(parsed.password);
  process.env.ATTACHMENT_DIR = ATTACH_DIR;
}

jest.mock('../../services/ejamaatClient', () => ({ authenticate: jest.fn(), getPhoto: jest.fn() }));

const maybe = enabled ? describe : describe.skip;

maybe('tickets on real PostgreSQL', () => {
  const request = require('supertest');
  const sharp = require('sharp');
  const pool = require('../../db/pool');
  const ejamaat = require('../../services/ejamaatClient');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  let jpegWithGps;
  let png;
  const ids = {};
  let categoryId;
  let avitId;
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  async function addUser(its, name, roles) {
    const { rows } = await pool.query(
      `INSERT INTO users (login_type, its_number, name, source) VALUES ('ITS', $1, $2, 'manual') RETURNING id`,
      [its, name]
    );
    const id = String(rows[0].id);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, r]);
    return id;
  }

  const login = async (its, role) =>
    (await request(app).post('/Atom/api/auth/login').send({ identifier: its, password: 'x', role })).body.token;

  function client(token) {
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return {
      get: (p) => auth(request(app).get(`/Atom/api/requests${p}`)),
      post: (p, b) => auth(request(app).post(`/Atom/api/requests${p}`)).send(b),
      patch: (p, b) => auth(request(app).patch(`/Atom/api/requests${p}`)).send(b),
      act: (n, action, b = {}) => auth(request(app).post(`/Atom/api/requests/${n}/actions/${action}`)).send(b),
      raise: (fields, photos = []) => {
        let r = auth(request(app).post('/Atom/api/requests'));
        for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
        for (const [buf, name, type] of photos) r = r.attach('photos', buf, { filename: name, contentType: type });
        return r;
      },
      comment: (n, fields, photos = []) => {
        let r = auth(request(app).post(`/Atom/api/requests/${n}/comments`));
        for (const [k, v] of Object.entries(fields)) r = r.field(k, String(v));
        for (const [buf, name, type] of photos) r = r.attach('photos', buf, { filename: name, contentType: type });
        return r;
      },
      file: (url) => auth(request(app).get(`/Atom/api${url}`)).buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      }),
    };
  }

  let admin;
  let alice; // employee (requester)
  let bob; // another employee
  let eng; // engineer
  let engAsEmployee;

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: () => {} });
    } finally {
      c.release();
    }
    jpegWithGps = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 120, b: 40 } } })
      .jpeg({ quality: 90 })
      .withExif({ IFD0: { Make: 'SecretCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '19/1 7/1 0/1' } })
      .toBuffer();
    png = await sharp({ create: { width: 800, height: 600, channels: 3, background: 'blue' } }).png().toBuffer();
  });

  afterAll(async () => {
    await pool.end();
    fs.rmSync(ATTACH_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE request_attachments, request_events, requests, user_change_log, user_service_units,
                      user_posts, user_status_log, user_roles, password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query(`SELECT setval('request_number_seq', 1001, false)`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();

    ids.admin = await addUser('30328701', 'Qusai', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.alice = await addUser('40000001', 'Alice', ['EMPLOYEE']);
    ids.bob = await addUser('40000002', 'Bob', ['EMPLOYEE']);
    ids.eng = await addUser('40000003', 'Engineer Eng', ['EMPLOYEE', 'ENGINEER']);
    avitId = (await q(`SELECT id FROM service_units WHERE code = 'AVIT'`))[0].id;
    categoryId = String((await q(`SELECT id FROM categories WHERE name = 'Printer / Scanner'`))[0].id);
    await pool.query('INSERT INTO user_service_units (user_id, service_unit_id) VALUES ($1, $2)', [ids.eng, avitId]);

    admin = client(await login('30328701'));
    alice = client(await login('40000001'));
    bob = client(await login('40000002'));
    eng = client(await login('40000003', 'ENGINEER'));
    engAsEmployee = client(await login('40000003', 'EMPLOYEE'));
  });

  const base = () => ({ title: 'Printer jams', description: 'The 2nd floor printer jams on every page.', categoryId, location: 'Library, 2nd floor' });

  test('raise with photos: T-1001, compressed WebP, EXIF/GPS gone, files on disk', async () => {
    const res = await alice.raise(base(), [[jpegWithGps, 'IMG_0001.jpg', 'image/jpeg'], [png, 'shot.png', 'image/png']]);
    expect(res.status).toBe(201);
    const t = res.body.request;
    expect(t).toMatchObject({ number: 'T-1001', status: 'OPEN', priority: 'NORMAL', category: 'Printer / Scanner', location: 'Library, 2nd floor' });
    expect(t.requester).toMatchObject({ id: ids.alice, name: 'Alice' });
    expect(t.attachments).toHaveLength(2);
    expect(t.attachments[0]).toMatchObject({ width: 1600, height: 1067, originalName: 'IMG_0001.jpg' });
    expect(t.events.map((e) => e.type)).toEqual(['created']);

    const img = await alice.file(t.attachments[0].url);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    const meta = await sharp(img.body).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 1600 });
    expect(meta.exif).toBeUndefined();
    expect(img.body.includes(Buffer.from('SecretCam'))).toBe(false);

    const onDisk = fs.readdirSync(path.join(ATTACH_DIR, 'requests', t.id));
    expect(onDisk).toHaveLength(2);
    expect(onDisk.every((f) => /^[0-9a-f-]{36}\.webp$/.test(f))).toBe(true);
  });

  test('scope: another employee gets 404 for the ticket and its photo; lists are per person', async () => {
    const t = (await alice.raise(base(), [[png, 'a.png', 'image/png']])).body.request;
    expect((await bob.get(`/${t.number}`)).status).toBe(404);
    expect((await bob.file(t.attachments[0].url)).status).toBe(404);
    expect((await eng.get(`/${t.number}`)).status).toBe(404); // not assigned yet
    expect((await alice.get('/T-9999')).status).toBe(404);
    expect((await alice.get('/../../etc')).status).toBe(404);

    expect((await alice.get('/mine')).body).toMatchObject({ total: 1 });
    expect((await bob.get('/mine')).body).toMatchObject({ total: 0 });
  });

  test('validation: category, title, priority (High / Normal / Low only), file types', async () => {
    expect((await alice.raise({ ...base(), categoryId: '999' })).body.code).toBe('bad_category');
    expect((await alice.raise({ ...base(), title: 'x' })).body.code).toBe('bad_title');
    expect((await alice.raise({ ...base(), priority: 'URGENT' })).body.code).toBe('bad_priority');
    expect((await alice.raise({ ...base(), priority: 'HIGH' })).status).toBe(201);
    expect((await admin.raise({ ...base(), priority: 'LOW' })).status).toBe(201);

    const gif = await sharp({ create: { width: 5, height: 5, channels: 3, background: 'red' } }).gif().toBuffer();
    expect((await alice.raise(base(), [[gif, 'x.gif', 'image/gif']])).body.code).toBe('bad_file_type');
    // Lies about its type: says JPEG, isn't an image. Nothing may be saved.
    const before = (await q('SELECT count(*)::int AS n FROM requests'))[0].n;
    const fake = await alice.raise(base(), [[png, 'ok.png', 'image/png'], [Buffer.from('not an image'), 'evil.jpg', 'image/jpeg']]);
    expect(fake.body.code).toBe('bad_image');
    expect((await q('SELECT count(*)::int AS n FROM requests'))[0].n).toBe(before);
    expect((await q('SELECT count(*)::int AS n FROM request_attachments'))[0].n).toBe(0);
  });

  test('at most 5 photos per ticket, across the ticket and its comments', async () => {
    const six = Array.from({ length: 6 }, (_, i) => [png, `p${i}.png`, 'image/png']);
    expect((await alice.raise(base(), six)).body.code).toBe('too_many_files');

    const t = (await alice.raise(base(), six.slice(0, 4))).body.request;
    expect(t.permissions).toMatchObject({ canAddPhotos: true, photosLeft: 1 });
    expect((await alice.comment(t.number, { note: 'two more' }, six.slice(0, 2))).body.message).toBe('You can add 1 more photo to this ticket.');
    const ok = await alice.comment(t.number, { note: 'one more' }, six.slice(0, 1));
    expect(ok.body.request.attachments).toHaveLength(5);
    expect(ok.body.request.permissions.canAddPhotos).toBe(false);
  });

  test('raise for someone else: Super Admin only; both see it', async () => {
    expect((await alice.raise({ ...base(), requesterId: ids.bob })).status).toBe(404);
    const t = (await admin.raise({ ...base(), requesterId: ids.bob })).body.request;
    expect(t).toMatchObject({ raisedForSomeoneElse: true, requester: { id: ids.bob }, raisedBy: { id: ids.admin } });
    expect((await bob.get(`/${t.number}`)).status).toBe(200);
    expect((await bob.get('/mine')).body.total).toBe(1);
    expect((await admin.get('/mine')).body.total).toBe(1);
  });

  test('full lifecycle with role checks, internal notes and the "waiting for you" reply', async () => {
    const t = (await alice.raise(base())).body.request;
    const n = t.number;

    // assign: Super Admin only; engineer must be tagged to AVIT
    expect((await eng.act(n, 'assign', { engineerId: ids.eng })).status).toBe(404);
    expect((await admin.act(n, 'assign', { engineerId: ids.bob })).body.code).toBe('bad_engineer');
    const assigned = await admin.act(n, 'assign', { engineerId: ids.eng });
    expect(assigned.body.request).toMatchObject({ status: 'ASSIGNED', assignedEngineer: { id: ids.eng } });
    expect((await admin.get(`/${n}/engineers`)).body.engineers.map((e) => e.name)).toEqual(['Engineer Eng']);
    expect((await alice.get(`/${n}/engineers`)).status).toBe(404);

    // engineer acting as Employee can't work it (access follows the active role)
    expect((await engAsEmployee.act(n, 'start')).status).toBe(404);
    expect((await eng.act(n, 'start')).body.request.status).toBe('IN_PROGRESS');
    expect((await eng.act(n, 'start')).status).toBe(409); // moved on

    // internal note: hidden from the requester, photo too
    const note = await eng.comment(n, { note: 'Fuser looks worn', internal: true }, [[png, 'fuser.png', 'image/png']]);
    const internalPhoto = note.body.request.attachments.find((a) => a.isInternal);
    expect(internalPhoto).toBeTruthy();
    const seenByAlice = (await alice.get(`/${n}`)).body.request;
    expect(seenByAlice.events.some((e) => e.isInternal)).toBe(false);
    expect(seenByAlice.attachments).toHaveLength(0);
    expect((await alice.file(internalPhoto.url)).status).toBe(404);
    expect((await alice.comment(n, { note: 'x', internal: true })).body.code).toBe('no_internal');

    // waiting for you → requester replies → back to in progress
    expect((await eng.act(n, 'wait_user', { note: 'Which tray?' })).body.request.status).toBe('WAITING_FOR_USER');
    const reply = await alice.comment(n, { note: 'Tray 2' });
    expect(reply.body.request.status).toBe('IN_PROGRESS');

    // resolve needs a note; close is Super Admin only
    expect((await eng.act(n, 'resolve')).body.code).toBe('note_required');
    expect((await eng.act(n, 'resolve', { note: 'Replaced the fuser unit.' })).body.request).toMatchObject({ status: 'RESOLVED', resolution: 'Replaced the fuser unit.' });
    expect((await eng.act(n, 'close')).status).toBe(404);
    expect((await admin.act(n, 'close')).body.request.status).toBe('CLOSED');

    // final: no comments, no actions, no reopening
    expect((await alice.comment(n, { note: 'thanks' })).status).toBe(409);
    expect((await admin.act(n, 'reject', { note: 'too late' })).status).toBe(409);

    const timeline = (await admin.get(`/${n}`)).body.request.events.map((e) => `${e.type}:${e.toStatus || ''}`);
    expect(timeline).toEqual([
      'created:OPEN', 'assigned:ASSIGNED', 'status:IN_PROGRESS', 'comment:', 'status:WAITING_FOR_USER',
      'comment:', 'status:IN_PROGRESS', 'status:RESOLVED', 'status:CLOSED',
    ]);
    const row = (await q('SELECT resolved_at, closed_at, assigned_at FROM requests WHERE number = 1001'))[0];
    expect(row.resolved_at && row.closed_at && row.assigned_at).toBeTruthy();
  });

  test('reject: Super Admin only, note required, from any open stage', async () => {
    const t = (await alice.raise(base())).body.request;
    expect((await admin.act(t.number, 'reject')).body.code).toBe('note_required');
    expect((await alice.act(t.number, 'reject', { note: 'not needed' })).status).toBe(404);
    const r = await admin.act(t.number, 'reject', { note: 'Duplicate of T-1000' });
    expect(r.body.request).toMatchObject({ status: 'REJECTED', rejectionNote: 'Duplicate of T-1000' });
  });

  test('triage: Super Admin changes priority and category; logged; others 404', async () => {
    const t = (await alice.raise(base())).body.request;
    const other = String((await q(`SELECT id FROM categories WHERE name = 'Software'`))[0].id);
    expect((await alice.patch(`/${t.number}`, { priority: 'HIGH' })).status).toBe(404);
    const r = await admin.patch(`/${t.number}`, { priority: 'HIGH', categoryId: other });
    expect(r.body.request).toMatchObject({ priority: 'HIGH', category: 'Software' });
    expect(r.body.request.events.slice(-2).map((e) => e.data)).toEqual([
      { from: 'NORMAL', to: 'HIGH' },
      { from: 'Printer / Scanner', to: 'Software' },
    ]);
  });

  test('two engineers clicking at once: one wins, the other gets 409', async () => {
    const t = (await alice.raise(base())).body.request;
    await admin.act(t.number, 'assign', { engineerId: ids.eng });
    const [a, b] = await Promise.all([eng.act(t.number, 'start'), admin.act(t.number, 'start')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await q(`SELECT count(*)::int AS n FROM request_events WHERE type='status'`))[0].n).toBe(1);
  });

  test('a deactivated engineer cannot be assigned', async () => {
    const t = (await alice.raise(base())).body.request;
    await pool.query('UPDATE users SET is_active = FALSE WHERE id = $1', [ids.eng]);
    expect((await admin.act(t.number, 'assign', { engineerId: ids.eng })).body.code).toBe('bad_engineer');
  });
});

if (!enabled) {
  test('ticket integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
