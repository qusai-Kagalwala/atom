// Phase 11 invoices on real PostgreSQL + real files (temp ATTACHMENT_DIR). eJamaat mocked.
// Runs ONLY when TEST_DATABASE_URL points at a database whose name ends in "_test".
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

maybe('invoices on real PostgreSQL', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const request = require('supertest');
  const sharp = require('sharp');
  const pool = require('../../db/pool');
  const ejamaat = require('../../services/ejamaatClient');
  const { config } = require('../../config/env');
  const { runMigrations } = require('../../db/migrate');
  const { createApp } = require('../../app');

  let app;
  let tmpDir;
  const ids = {};
  let cat;

  const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  const PDF2 = Buffer.from('%PDF-1.4\n% second invoice\n%%EOF\n');
  let JPG;

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

  const as = (token) => {
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return {
      raise: (b) => auth(request(app).post('/Atom/api/requests')).send(b),
      act: (n, a, b = {}) => auth(request(app).post(`/Atom/api/requests/${n}/actions/${a}`)).send(b),
      ticket: (n) => auth(request(app).get(`/Atom/api/requests/${n}`)),
      upload: (buf, name, type, fields = {}) => {
        let r = auth(request(app).post('/Atom/api/invoices'));
        for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
        return buf ? r.attach('file', buf, { filename: name, contentType: type }) : r;
      },
      list: (qs = '') => auth(request(app).get(`/Atom/api/invoices${qs}`)),
      get: (n) => auth(request(app).get(`/Atom/api/invoices/${n}`)),
      file: (n) => auth(request(app).get(`/Atom/api/invoices/${n}/file`)).buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      }),
      patch: (n, b) => auth(request(app).patch(`/Atom/api/invoices/${n}`)).send(b),
      link: (n, nums) => auth(request(app).post(`/Atom/api/invoices/${n}/links`)).send({ requestNumbers: nums }),
      unlink: (n, t, reason) => auth(request(app).post(`/Atom/api/invoices/${n}/links/${t}/unlink`)).send({ reason }),
    };
  };

  let admin;
  let alice;
  let eng1;
  let eng2;
  let eng1AsEmployee;

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      await runMigrations(c, { log: () => {} });
    } finally {
      c.release();
    }
    JPG = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#ffffff' } })
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-gps-owner' } } })
      .jpeg()
      .toBuffer();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atom-inv-'));
    config.attachmentDir = tmpDir;
    await pool.query(`TRUNCATE invoice_links, invoices, notifications, request_attachments, request_events, requests,
                      user_change_log, user_service_units, user_posts, user_status_log, user_roles,
                      password_reset_tokens, users RESTART IDENTITY CASCADE`);
    await pool.query(`SELECT setval('request_number_seq', 1001, false)`);
    await pool.query(`SELECT setval('invoice_number_seq', 1001, false)`);
    ejamaat.authenticate.mockReset().mockResolvedValue({ success: true });
    app = createApp();

    ids.admin = await addUser('30328701', 'Qusai', ['EMPLOYEE', 'SUPER_ADMIN']);
    ids.alice = await addUser('40000001', 'Alice Hamid', ['EMPLOYEE']);
    ids.eng1 = await addUser('40000003', 'Eng One', ['EMPLOYEE', 'ENGINEER']);
    ids.eng2 = await addUser('40000004', 'Eng Two', ['EMPLOYEE', 'ENGINEER']);
    const avit = (await pool.query(`SELECT id FROM service_units WHERE code='AVIT'`)).rows[0].id;
    for (const e of [ids.eng1, ids.eng2]) {
      await pool.query('INSERT INTO user_service_units (user_id, service_unit_id) VALUES ($1, $2)', [e, avit]);
    }
    cat = String((await pool.query(`SELECT id FROM categories WHERE name='Printer / Scanner'`)).rows[0].id);

    admin = as(await login('30328701', 'SUPER_ADMIN'));
    alice = as(await login('40000001'));
    eng1 = as(await login('40000003', 'ENGINEER'));
    eng2 = as(await login('40000004', 'ENGINEER'));
    eng1AsEmployee = as(await login('40000003', 'EMPLOYEE'));

    // T-1001 → eng1, T-1002 → eng2, T-1003 unassigned
    for (const title of ['Keyboard broken', 'Monitor flickers', 'Headset']) {
      await alice.raise({ title, description: 'x', categoryId: cat });
    }
    await admin.act('T-1001', 'assign', { engineerId: ids.eng1 });
    await admin.act('T-1002', 'assign', { engineerId: ids.eng2 });
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('Super Admin uploads a PDF linked to three tickets: INV-1001, stored as-is, internal timeline events', async () => {
    const res = await admin.upload(PDF, 'bill.pdf', 'application/pdf', {
      supplier: 'Lamington Road Computers',
      reference: 'LRC/2026/118',
      invoiceDate: '2026-10-20',
      requestNumbers: 'T-1001, T-1002, 1003',
    });
    expect(res.status).toBe(201);
    expect(res.body.added).toEqual(['T-1001', 'T-1002', 'T-1003']);
    expect(res.body.invoice).toMatchObject({
      number: 'INV-1001', supplier: 'Lamington Road Computers', reference: 'LRC/2026/118',
      invoiceDate: '2026-10-20', fileType: 'pdf', linkCount: 3, linked: ['T-1001', 'T-1002', 'T-1003'],
      fileUrl: '/invoices/INV-1001/file',
    });

    const [{ stored_name: stored, id }] = (await pool.query('SELECT id, stored_name FROM invoices')).rows;
    expect(fs.readFileSync(path.join(tmpDir, 'invoices', String(id), stored)).equals(PDF)).toBe(true);

    const file = await admin.file('INV-1001');
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-security-policy']).toMatch(/sandbox/);
    expect(file.headers['content-disposition']).toBe('inline; filename="INV-1001.pdf"');
    expect(file.body.equals(PDF)).toBe(true);

    // Ticket page: the assigned engineer and Super Admin see the invoice + timeline; the requester sees neither.
    const asEng = (await eng1.ticket('T-1001')).body.request;
    expect(asEng.invoices.map((i) => i.number)).toEqual(['INV-1001']);
    expect(asEng.events.some((e) => e.type === 'invoice_linked' && e.data.invoiceNumber === 'INV-1001' && e.isInternal)).toBe(true);
    expect(asEng.permissions).toMatchObject({ canLinkInvoices: true, canUnlinkInvoices: false });
    const asReq = (await alice.ticket('T-1001')).body.request;
    expect(asReq.invoices).toBeUndefined();
    expect(JSON.stringify(asReq)).not.toContain('INV-1001');
  });

  test('images are re-encoded to WebP (metadata gone), max 3000 px', async () => {
    const res = await eng1.upload(JPG, 'photo.jpg', 'image/jpeg', { requestNumbers: 'T-1001' });
    expect(res.status).toBe(201);
    expect(res.body.invoice.fileType).toBe('image');
    const file = await eng1.file('INV-1001');
    expect(file.headers['content-type']).toBe('image/webp');
    const meta = await sharp(file.body).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1200);
    expect(meta.exif).toBeUndefined();
    expect(file.body.includes('secret-gps-owner')).toBe(false);
  });

  test('duplicate file → 409 with the existing number; resend with linkExisting links it instead', async () => {
    await admin.upload(PDF, 'bill.pdf', 'application/pdf', { requestNumbers: 'T-1002' });

    const dup = await eng1.upload(PDF, 'same-bill.pdf', 'application/pdf', { requestNumbers: 'T-1001' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'duplicate', duplicate: { number: 'INV-1001' } });
    expect(dup.body.message).toBe('This invoice already exists (INV-1001). Link it instead?');
    expect(dup.body.duplicate.supplier).toBeUndefined(); // eng1 can't see it yet: no details leaked
    expect((await pool.query('SELECT count(*)::int AS n FROM invoices')).rows[0].n).toBe(1);
    expect(fs.readdirSync(path.join(tmpDir, 'invoices'))).toEqual(['1']); // no stray file

    const linked = await eng1.upload(PDF, 'same-bill.pdf', 'application/pdf', { requestNumbers: 'T-1001', linkExisting: 'true' });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ linkedExisting: true, added: ['T-1001'] });
    // eng1 now sees it, but only their own ticket among the links.
    expect(linked.body.invoice.linked).toEqual(['T-1001']);
    expect(linked.body.invoice.otherLinks).toBe(1);
    expect((await admin.get('INV-1001')).body.invoice.linked).toEqual(['T-1001', 'T-1002']);

    // linkExisting needs at least one ticket.
    expect((await eng1.upload(PDF, 'x.pdf', 'application/pdf', { linkExisting: 'true' })).body.code).toBe('no_requests');
  });

  test('scope: engineers see their uploads + invoices on their assigned work; others 404; non-engineers 404 everywhere', async () => {
    await admin.upload(PDF, 'a.pdf', 'application/pdf', { requestNumbers: 'T-1002' }); // INV-1001 on eng2's ticket
    await eng1.upload(PDF2, 'b.pdf', 'application/pdf'); // INV-1002, eng1's own upload, unlinked

    expect((await eng1.list()).body.invoices.map((i) => i.number)).toEqual(['INV-1002']);
    expect((await eng2.list()).body.invoices.map((i) => i.number)).toEqual(['INV-1001']);
    expect((await admin.list()).body.total).toBe(2);

    expect((await eng1.get('INV-1001')).status).toBe(404);
    expect((await eng1.file('INV-1001')).status).toBe(404);
    expect((await eng2.get('INV-1002')).status).toBe(404);

    for (const who of [alice, eng1AsEmployee]) {
      expect((await who.list()).status).toBe(404);
      expect((await who.get('INV-1001')).status).toBe(404);
      expect((await who.file('INV-1001')).status).toBe(404);
      expect((await who.upload(PDF2, 'c.pdf', 'application/pdf')).status).toBe(404);
    }
    expect((await request(app).get('/Atom/api/invoices')).status).toBe(401);
  });

  test('linking: engineers only to their assigned tickets; any status; already-linked reported, not duplicated', async () => {
    expect((await eng1.upload(PDF, 'a.pdf', 'application/pdf', { requestNumbers: 'T-1002' })).status).toBe(404); // not theirs
    expect((await pool.query('SELECT count(*)::int AS n FROM invoices')).rows[0].n).toBe(0); // nothing half-saved
    expect(fs.existsSync(path.join(tmpDir, 'invoices')) ? fs.readdirSync(path.join(tmpDir, 'invoices')) : []).toEqual([]);

    await eng1.upload(PDF, 'a.pdf', 'application/pdf');
    expect((await eng1.link('INV-1001', ['T-1003'])).status).toBe(404); // unassigned ticket
    expect((await eng1.link('INV-1001', ['T-1001'])).body.added).toEqual(['T-1001']);
    expect((await eng1.link('INV-1001', ['T-1001'])).body).toMatchObject({ added: [], already: ['T-1001'] });

    // Closed tickets can still get invoices (they often arrive after the job).
    await eng1.act('T-1001', 'start');
    await eng1.act('T-1001', 'resolve', { note: 'Replaced it' });
    await admin.act('T-1001', 'close');
    await admin.upload(PDF2, 'late.pdf', 'application/pdf', { requestNumbers: 'T-1001' });
    expect((await admin.ticket('T-1001')).body.request.invoices.map((i) => i.number)).toEqual(['INV-1001', 'INV-1002']);

    expect((await admin.link('INV-1001', [])).body.code).toBe('no_requests');
    expect((await admin.link('INV-1001', ['abc'])).body.code).toBe('bad_requests');
    expect((await admin.link('INV-1001', Array.from({ length: 21 }, (_, i) => `T-${2000 + i}`))).body.code).toBe('too_many_requests');
  });

  test('unlink: Super Admin only, reason required, history kept; re-linking adds a new row', async () => {
    await admin.upload(PDF, 'a.pdf', 'application/pdf', { requestNumbers: 'T-1001' });
    expect((await eng1.unlink('INV-1001', 'T-1001', 'wrong ticket')).status).toBe(404);
    expect((await admin.unlink('INV-1001', 'T-1001', 'x')).body.code).toBe('reason_required');

    const res = await admin.unlink('INV-1001', 'T-1001', 'Belongs to another ticket');
    expect(res.status).toBe(200);
    expect(res.body.invoice.linkCount).toBe(0);
    expect(res.body.invoice.links[0]).toMatchObject({
      request: { number: 'T-1001' }, unlinkReason: 'Belongs to another ticket', unlinkedBy: { name: 'Qusai' },
    });
    expect((await admin.unlink('INV-1001', 'T-1001', 'again')).status).toBe(404); // nothing active to end

    const t = (await admin.ticket('T-1001')).body.request;
    expect(t.invoices).toEqual([]);
    expect(t.events.find((e) => e.type === 'invoice_unlinked')).toMatchObject({ note: 'Belongs to another ticket', isInternal: true });
    // eng1 lost sight of it (only link gone, not the uploader).
    expect((await eng1.get('INV-1001')).status).toBe(404);

    await admin.link('INV-1001', ['T-1001']);
    expect((await pool.query('SELECT count(*)::int AS n FROM invoice_links')).rows[0].n).toBe(2);
    expect((await admin.get('INV-1001')).body.invoice.links.map((l) => Boolean(l.unlinkedAt))).toEqual([true, false]);
  });

  test('search and filters: INV number, ticket number, supplier, reference; linked / unlinked', async () => {
    await admin.upload(PDF, 'a.pdf', 'application/pdf', { supplier: 'Lamington Road', reference: 'LR-55', requestNumbers: 'T-1002' });
    await admin.upload(PDF2, 'b.pdf', 'application/pdf', { supplier: 'Croma 100%_off' });
    const nums = async (qs) => (await admin.list(qs)).body.invoices.map((i) => i.number);

    expect(await nums('?q=INV-1002')).toEqual(['INV-1002']);
    expect(await nums('?q=1001')).toEqual(['INV-1001']);
    expect(await nums('?q=T-1002')).toEqual(['INV-1001']);
    expect(await nums('?q=lamington')).toEqual(['INV-1001']);
    expect(await nums('?q=LR-55')).toEqual(['INV-1001']);
    expect(await nums('?q=100%25_')).toEqual(['INV-1002']); // % and _ are literal
    expect(await nums('?q=%25')).toEqual(['INV-1002']);
    expect(await nums('?linked=linked')).toEqual(['INV-1001']);
    expect(await nums('?linked=unlinked')).toEqual(['INV-1002']);
    expect(await nums('')).toEqual(['INV-1002', 'INV-1001']); // newest first
    expect((await admin.list('?linked=maybe')).status).toBe(400);
  });

  test('labels: validated; editable by Super Admin or the uploader only', async () => {
    expect((await eng1.upload(PDF, 'a.pdf', 'application/pdf', { invoiceDate: '2026-02-30' })).body.code).toBe('bad_date');
    expect((await eng1.upload(PDF, 'a.pdf', 'application/pdf', { supplier: 'x'.repeat(121) })).body.code).toBe('bad_supplier');
    await eng1.upload(PDF, 'a.pdf', 'application/pdf', { requestNumbers: 'T-1001' });

    const edited = await eng1.patch('INV-1001', { supplier: 'Vijay Sales', invoiceDate: '2026-10-01' });
    expect(edited.body.invoice).toMatchObject({ supplier: 'Vijay Sales', invoiceDate: '2026-10-01', reference: null });
    expect((await admin.patch('INV-1001', { reference: 'VS-9' })).body.invoice).toMatchObject({ supplier: 'Vijay Sales', reference: 'VS-9' });
    expect((await admin.patch('INV-1001', { supplier: '' })).body.invoice.supplier).toBeNull();

    // Another engineer assigned to a linked ticket can see it but not edit it.
    await admin.act('T-1001', 'assign', { engineerId: ids.eng2 });
    await admin.link('INV-1001', ['T-1002']);
    expect((await eng2.get('INV-1001')).body.invoice.permissions).toMatchObject({ canEdit: false, canLink: true, canUnlink: false });
    expect((await eng2.patch('INV-1001', { supplier: 'Hack' })).status).toBe(404);
  });

  test('file checks: wrong type, fake PDF, broken image, too large, missing file', async () => {
    expect((await admin.upload(Buffer.from('hello'), 'a.txt', 'text/plain')).body.code).toBe('bad_file_type');
    expect((await admin.upload(Buffer.from('not a pdf at all'), 'a.pdf', 'application/pdf')).body.code).toBe('bad_pdf');
    expect((await admin.upload(Buffer.from('nope'), 'a.png', 'image/png')).body.code).toBe('bad_image');
    expect((await admin.upload(Buffer.alloc(10 * 1024 * 1024 + 1, 0x25), 'big.pdf', 'application/pdf')).body.code).toBe('file_too_large');
    expect((await admin.upload(null, null, null, { supplier: 'x' })).body.code).toBe('no_file');
    expect((await pool.query('SELECT count(*)::int AS n FROM invoices')).rows[0].n).toBe(0);
  });
});

if (!enabled) {
  test('invoices integration tests skipped (set TEST_DATABASE_URL to a *_test database)', () => {
    expect(enabled).toBe(false);
  });
}
