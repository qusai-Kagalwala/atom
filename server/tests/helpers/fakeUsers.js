// In-memory stand-in for the users / user_roles / password_reset_tokens queries used by
// modules/auth/*.repo.js. Answers by matching the distinctive part of each SQL statement.
// pool.connect() returns a client sharing the same data (BEGIN/COMMIT/ROLLBACK are recorded only).

function createFakeUsers() {
  const users = new Map();
  const roles = new Map(); // userId -> Set(role)
  const tokens = [];
  const txLog = [];
  let nextId = 1;
  let nextTokenId = 1;

  const ROLE_ORDER = ['EMPLOYEE', 'ENGINEER', 'SUPER_ADMIN'];

  function add(user, userRoles = ['EMPLOYEE']) {
    const id = String(nextId++);
    users.set(id, {
      id,
      login_type: user.login_type,
      its_number: user.its_number ?? null,
      employee_id: user.employee_id ?? null,
      name: user.name ?? null,
      email: user.email ?? null,
      legacy_password: user.legacy_password ?? null,
      is_active: user.is_active ?? true,
    });
    roles.set(id, new Set(userRoles));
    return id;
  }

  const find = (pred) => [...users.values()].find(pred) || null;

  async function query(sql, params = []) {
    const text = String(sql).trim();

    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) {
      txLog.push(text);
      return { rows: [] };
    }

    if (text.includes("login_type = 'EMPLOYEE_ID' AND employee_id")) {
      const u = find((x) => x.login_type === 'EMPLOYEE_ID' && x.employee_id === params[0]);
      return {
        rows: u ? [{ id: u.id, is_active: u.is_active, legacy_password: u.legacy_password, email: u.email }] : [],
      };
    }

    if (text.includes("login_type = 'ITS' AND its_number")) {
      const u = find((x) => x.login_type === 'ITS' && x.its_number === params[0]);
      return { rows: u ? [{ id: u.id, is_active: u.is_active }] : [] };
    }

    if (text.includes('array_agg(r.role::text')) {
      const u = users.get(String(params[0]));
      if (!u) return { rows: [] };
      const { legacy_password, ...rest } = u; // eslint-disable-line no-unused-vars
      const granted = ROLE_ORDER.filter((r) => roles.get(u.id).has(r));
      return { rows: [{ ...rest, roles: granted }] };
    }

    if (text.startsWith('SELECT legacy_password')) {
      const u = users.get(String(params[0]));
      return { rows: u && u.login_type === 'EMPLOYEE_ID' ? [{ legacy_password: u.legacy_password }] : [] };
    }

    if (text.startsWith('UPDATE users SET legacy_password')) {
      const u = users.get(String(params[0]));
      if (!u || u.login_type !== 'EMPLOYEE_ID') return { rowCount: 0, rows: [] };
      u.legacy_password = params[1];
      return { rowCount: 1, rows: [] };
    }

    if (text.startsWith('UPDATE password_reset_tokens SET used_at')) {
      let n = 0;
      for (const t of tokens) {
        if (t.user_id === String(params[0]) && !t.used_at) { t.used_at = new Date(); n += 1; }
      }
      return { rowCount: n, rows: [] };
    }

    if (text.startsWith('INSERT INTO password_reset_tokens')) {
      tokens.push({
        id: nextTokenId++,
        user_id: String(params[0]),
        token_hash: params[1],
        expires_at: new Date(Date.now() + params[2] * 60_000),
        used_at: null,
      });
      return { rowCount: 1, rows: [] };
    }

    if (text.includes('FROM password_reset_tokens t')) {
      const t = tokens.find(
        (x) => x.token_hash === params[0] && !x.used_at && x.expires_at > new Date()
      );
      const u = t && users.get(t.user_id);
      if (!t || !u || u.login_type !== 'EMPLOYEE_ID') return { rows: [] };
      return { rows: [{ id: t.id, user_id: t.user_id, legacy_password: u.legacy_password, is_active: u.is_active }] };
    }

    throw new Error(`fakeUsers: unhandled query: ${text.slice(0, 80)}`);
  }

  async function connect() {
    return { query, release: () => {} };
  }

  return {
    query,
    connect,
    add,
    users,
    tokens,
    txLog,
    setActive: (id, value) => { users.get(id).is_active = value; },
    removeRole: (id, role) => roles.get(id).delete(role),
    reset: () => {
      users.clear(); roles.clear(); tokens.length = 0; txLog.length = 0;
      nextId = 1; nextTokenId = 1;
    },
  };
}

module.exports = { createFakeUsers };
