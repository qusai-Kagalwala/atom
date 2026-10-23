// In-memory stand-in for the users / user_roles queries in modules/auth/users.repo.js.
// Answers by matching the distinctive part of each SQL statement.

function createFakeUsers() {
  const users = new Map();
  const roles = new Map(); // userId -> Set(role)
  let nextId = 1;

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
    const text = String(sql);

    if (text.includes("login_type = 'EMPLOYEE_ID' AND employee_id")) {
      const u = find((x) => x.login_type === 'EMPLOYEE_ID' && x.employee_id === params[0]);
      return { rows: u ? [{ id: u.id, is_active: u.is_active, legacy_password: u.legacy_password }] : [] };
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

    throw new Error(`fakeUsers: unhandled query: ${text.slice(0, 80)}`);
  }

  return {
    query,
    add,
    users,
    setActive: (id, value) => { users.get(id).is_active = value; },
    removeRole: (id, role) => roles.get(id).delete(role),
    reset: () => { users.clear(); roles.clear(); nextId = 1; },
  };
}

module.exports = { createFakeUsers };
