// Phase 13: Socket.IO login, rooms, pushes and disconnects — over a real socket on a random port.
// PostgreSQL is mocked (fakeUsers). Uses the client's socket.io-client; skipped if client/ isn't installed.
jest.mock('../db/pool', () => require('./helpers/fakeUsers').createFakeUsers());

const http = require('http');
const path = require('path');
const db = require('../db/pool');
const realtime = require('../realtime');
const { signSession } = require('../modules/auth/tokens');

let ioClient = null;
try {
  ioClient = require(require.resolve('socket.io-client', { paths: [path.join(__dirname, '../../client')] })).io;
} catch {
  ioClient = null;
}
const maybe = ioClient ? describe : describe.skip;

maybe('Socket.IO on a real port', () => {
  let server;
  let url;
  let ids;
  const open = [];

  beforeEach(async () => {
    db.reset();
    ids = {
      emp: db.add({ login_type: 'EMPLOYEE_ID', employee_id: '1002', legacy_password: 'x' }, ['EMPLOYEE', 'ENGINEER']),
      admin: db.add({ login_type: 'ITS', its_number: '30328701' }, ['EMPLOYEE', 'SUPER_ADMIN']),
    };
    server = http.createServer();
    realtime.attach(server, { basePath: '/Atom', recheckMs: 60_000 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    for (const s of open.splice(0)) s.disconnect();
    realtime.close();
    await new Promise((resolve) => server.close(resolve));
  });

  // Resolves with the connected socket, or rejects with the connect_error.
  function connect(token) {
    const socket = ioClient(url, {
      path: '/Atom/socket.io',
      auth: token === undefined ? {} : { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    open.push(socket);
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  }

  const next = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
  const nothing = (socket, event, ms = 150) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      socket.once(event, () => {
        clearTimeout(t);
        reject(new Error(`unexpected ${event}`));
      });
    });

  test('no token, a bad token, or a session that is no longer valid → refused with a code', async () => {
    await expect(connect()).rejects.toMatchObject({ data: { code: 'session_expired' } });
    await expect(connect('not-a-jwt')).rejects.toMatchObject({ data: { code: 'session_expired' } });

    db.setActive(ids.emp, false);
    await expect(connect(signSession(ids.emp, 'EMPLOYEE', 0))).rejects.toMatchObject({ data: { code: 'removed' } });
    db.setActive(ids.emp, true);

    await expect(connect(signSession(ids.emp, 'SUPER_ADMIN', 0))).rejects.toMatchObject({ data: { code: 'role_changed' } });

    db.users.get(ids.emp).session_version = 1;
    await expect(connect(signSession(ids.emp, 'EMPLOYEE', 0))).rejects.toMatchObject({ data: { code: 'password_changed' } });
    await expect(connect(signSession(ids.emp, 'EMPLOYEE', 1))).resolves.toBeTruthy();
  });

  test('pushes reach the right user and active role only', async () => {
    const asEmployee = await connect(signSession(ids.emp, 'EMPLOYEE', 0));
    const asEngineer = await connect(signSession(ids.emp, 'ENGINEER', 0));
    const admin = await connect(signSession(ids.admin, 'SUPER_ADMIN', 0));

    // Own-ticket notification: every socket of that user, whatever the role.
    const both = Promise.all([next(asEmployee, 'notification:new'), next(asEngineer, 'notification:new')]);
    realtime.emitToUser(ids.emp, 'notification:new', { title: 'T-1001 is closed' });
    expect((await both).map((p) => p.title)).toEqual(['T-1001 is closed', 'T-1001 is closed']);

    // Engineer notification: only the socket signed in as Engineer.
    const eng = next(asEngineer, 'notification:new');
    const notEmployee = nothing(asEmployee, 'notification:new');
    const notAdmin = nothing(admin, 'notification:new');
    realtime.emitToUserRole(ids.emp, 'ENGINEER', 'notification:new', { title: 'assigned' });
    expect((await eng).title).toBe('assigned');
    await notEmployee;
    await notAdmin;

    // Role broadcast.
    const toAdmins = next(admin, 'requests:changed');
    const notOthers = nothing(asEngineer, 'requests:changed');
    realtime.emitToRole('SUPER_ADMIN', 'requests:changed', { number: 'T-1001' });
    expect(await toAdmins).toEqual({ number: 'T-1001' });
    await notOthers;
  });

  test('disconnectUser drops all of that user\'s sockets except the one kept', async () => {
    const a = await connect(signSession(ids.emp, 'EMPLOYEE', 0));
    const b = await connect(signSession(ids.emp, 'ENGINEER', 0));
    const other = await connect(signSession(ids.admin, 'SUPER_ADMIN', 0));

    const bGone = next(b, 'disconnect');
    realtime.disconnectUser(ids.emp, { except: a.id });
    expect(await bGone).toBe('io server disconnect');
    await new Promise((r) => setTimeout(r, 50));
    expect(a.connected).toBe(true);
    expect(other.connected).toBe(true);

    const aGone = next(a, 'disconnect');
    realtime.disconnectUser(ids.emp);
    expect(await aGone).toBe('io server disconnect');
  });

  test('periodic re-check drops sessions that became invalid (e.g. deactivated by the sync)', async () => {
    const s = await connect(signSession(ids.emp, 'EMPLOYEE', 0));
    const keep = await connect(signSession(ids.admin, 'SUPER_ADMIN', 0));
    db.setActive(ids.emp, false);

    const ended = next(s, 'session:end');
    const gone = next(s, 'disconnect');
    await realtime.recheckSessions();
    expect(await ended).toEqual({ code: 'removed' });
    expect(await gone).toBe('io server disconnect');
    expect(keep.connected).toBe(true);
  });
});

if (!ioClient) {
  test('realtime wire tests skipped (client/node_modules not installed)', () => {
    expect(ioClient).toBeNull();
  });
}
