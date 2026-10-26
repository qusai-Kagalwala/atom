// Super Admin user management rules (ATOM_Decisions.md §2, §6–§8; Phase 5 decisions 24 Oct 2026).
//   - Every change runs in one transaction under one advisory lock, so two Super Admins can't
//     race each other (e.g. both removing the "second-last" Super Admin at the same time).
//   - You can't remove your own Super Admin role, remove the last active Super Admin, remove
//     anyone's only role, or deactivate yourself / the last active Super Admin.
//   - Service-unit tags only for users holding Engineer; removing Engineer removes their tags.
//   - Name / email / mobile editable for imported (legacy) and manual users only — synced users'
//     details come from the Idarah view.
//   - Super Admin password reset: employee-ID users only; the Super Admin types the new password.
//   - Every change is logged (status → user_status_log, everything else → user_change_log).
//   - Role removal, deactivation and password reset drop the user's live (Socket.IO) connections
//     after the commit; reconnecting re-runs the full session check (Phase 13).
const pool = require('../../db/pool');
const repo = require('./users.repo');
const passwordsRepo = require('../auth/passwords.repo');
const unitsRepo = require('../serviceUnits/serviceUnits.repo');
const { HttpError, notFound } = require('../../utils/httpError');
const realtime = require('../../realtime');
const { locationLabel } = require('../sync/hrPlan');

const LOCK_KEY = 727303; // user administration
const ROLES = ['EMPLOYEE', 'ENGINEER', 'SUPER_ADMIN'];
const MIN_PASSWORD = 8;

const bad = (message, code) => new HttpError(400, message, code);

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_KEY]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function mustGetUser(db, id) {
  if (!/^\d{1,18}$/.test(String(id))) throw notFound();
  const user = await repo.getUser(db, id);
  if (!user) throw notFound();
  return user;
}

// ---------- shape for the API (never includes a password) ----------
function toSummary(u) {
  return {
    id: String(u.id),
    loginType: u.login_type,
    itsNumber: u.its_number || null,
    employeeId: u.employee_id || null,
    name: u.name || (u.employee_id ? `Employee ${u.employee_id}` : null),
    hasName: Boolean(u.name),
    nameArabic: u.name_arabic || null,
    email: u.email || null,
    source: u.source,
    isActive: u.is_active,
    roles: u.roles || [],
    departments: u.departments || [],
  };
}

function historyText(h) {
  const d = h.detail || {};
  switch (h.action) {
    case 'activated':
    case 'deactivated':
      return h.action === 'activated' ? 'Activated' : 'Deactivated';
    case 'created':
      return 'Account created';
    case 'role_granted':
      return `Role granted: ${d.role}`;
    case 'role_removed':
      return `Role removed: ${d.role}${d.unitsRemoved?.length ? ` (service units untagged: ${d.unitsRemoved.join(', ')})` : ''}`;
    case 'unit_tagged':
      return `Tagged to ${d.unit}`;
    case 'unit_untagged':
      return `Untagged from ${d.unit}`;
    case 'profile_updated':
      if (d.source === 'contacts import') return `Contact details added from the HR sheet: ${(d.fields || []).join(', ')}`;
      return `Details edited: ${(d.fields || []).join(', ')}`;
    case 'password_reset':
      if (h.detail?.mustChange) return 'Password reset by a Super Admin (must change at next sign-in)';
      return 'Password reset by a Super Admin';
    default:
      return h.action;
  }
}

function byLabel(h) {
  // The reason says which sync ("Added by HR sync", "No longer in Idarah view", …).
  if (h.source === 'sync') return /\bHR\b/.test(h.reason || '') ? 'HR sync' : 'Idarah sync';
  if (h.source === 'import') return 'Employee-ID import';
  if (h.source === 'seed') return 'Dev seed';
  if (h.detail?.source === 'contacts import') return 'Contacts import';
  return h.by_name || (h.by_employee_id ? `Employee ${h.by_employee_id}` : h.by_its) || 'Super Admin';
}

async function getUserDetail(id, db = pool) {
  const u = await mustGetUser(db, id);
  const [roles, units, posts, hrDepartments, history] = await Promise.all([
    repo.getRoles(db, id),
    repo.getServiceUnits(db, id),
    repo.getPosts(db, id),
    repo.getHrDepartments(db, id),
    repo.getHistory(db, id),
  ]);
  return {
    ...toSummary({ ...u, roles }),
    mobile: u.mobile || null,
    createdAt: u.created_at,
    // Synced users' details come from their source view (Idarah or HR list).
    editable: u.source !== 'idarah' && u.source !== 'hr',
    mustChangePassword: u.login_type === 'EMPLOYEE_ID' ? Boolean(u.must_change_password) : false,
    serviceUnits: units.map((s) => ({ id: String(s.id), code: s.code, name: s.name, isActive: s.is_active })),
    posts: posts.map((p) => ({
      department: p.department,
      departmentArabic: p.department_arabic,
      post: p.post || null,
      postTbq: p.post_tbq || null,
      isActive: p.is_active,
    })),
    hrDepartments: hrDepartments.map((d) => ({
      department: d.department,
      departmentArabic: d.department_arabic,
      location: locationLabel({ building: d.building, floor: d.floor, roomNo: d.room_no }),
      isActive: d.is_active,
    })),
    history: history.map((h) => ({
      at: h.created_at,
      kind: h.kind,
      action: h.action,
      text: historyText(h),
      reason: h.reason || null,
      by: byLabel(h),
    })),
  };
}

async function listUsers(filters) {
  const { rows, total } = await repo.listUsers(pool, filters);
  return { users: rows.map(toSummary), total };
}

// ---------- create ----------
async function createUser(input, actor) {
  const loginType = input.loginType;
  const itsNumber = loginType === 'ITS' ? String(input.itsNumber || '').trim() : null;
  const employeeId = loginType === 'EMPLOYEE_ID' ? String(input.employeeId || '').trim() : null;

  if (loginType === 'ITS' && !/^\d{8}$/.test(itsNumber)) throw bad('ITS number must be exactly 8 digits.', 'bad_its');
  if (loginType === 'EMPLOYEE_ID') {
    if (!/^\d{1,7}$/.test(employeeId)) throw bad('Employee ID must be 1–7 digits.', 'bad_employee_id');
    if (typeof input.password !== 'string' || input.password.length < MIN_PASSWORD) {
      throw bad(`Password must be at least ${MIN_PASSWORD} characters.`, 'too_short');
    }
  }

  return inTransaction(async (db) => {
    if (await repo.idTaken(db, { itsNumber, employeeId })) {
      throw new HttpError(409, `${loginType === 'ITS' ? 'ITS number' : 'Employee ID'} is already in ATOM.`, 'exists');
    }
    const id = await repo.insertUser(db, {
      loginType,
      itsNumber,
      employeeId,
      password: loginType === 'EMPLOYEE_ID' ? input.password : null,
      name: input.name,
      email: input.email,
      mobile: input.mobile,
    });
    await repo.addRole(db, id, 'EMPLOYEE', actor.id);
    await repo.logChange(db, id, 'created', { loginType }, actor.id);
    await repo.logStatus(db, id, true, 'Created by Super Admin', actor.id);
    return getUserDetail(id, db);
  });
}

// ---------- profile ----------
async function updateProfile(id, fields, actor) {
  return inTransaction(async (db) => {
    const u = await mustGetUser(db, id);
    if (u.source === 'idarah') {
      throw bad('Details of synced users come from the Idarah view and can\'t be edited here.', 'synced_read_only');
    }
    const changed = Object.keys(fields).filter((k) => (fields[k] ?? null) !== (u[k] ?? null));
    if (changed.length) {
      await repo.updateProfile(db, id, fields);
      await repo.logChange(db, id, 'profile_updated', { fields: changed }, actor.id);
    }
    return getUserDetail(id, db);
  });
}

// ---------- roles ----------
async function grantRole(id, role, actor) {
  if (!ROLES.includes(role)) throw bad('Unknown role.', 'bad_role');
  return inTransaction(async (db) => {
    await mustGetUser(db, id);
    if (await repo.addRole(db, id, role, actor.id)) {
      await repo.logChange(db, id, 'role_granted', { role }, actor.id);
    }
    return getUserDetail(id, db);
  });
}

async function removeRole(id, role, actor) {
  if (!ROLES.includes(role)) throw bad('Unknown role.', 'bad_role');
  return inTransaction(async (db) => {
    const u = await mustGetUser(db, id);
    const roles = await repo.getRoles(db, id);
    if (!roles.includes(role)) return getUserDetail(id, db); // already gone — nothing to do

    if (roles.length === 1) {
      throw bad('Every user keeps at least one role. Deactivate the user instead.', 'only_role');
    }
    if (role === 'SUPER_ADMIN') {
      if (String(id) === String(actor.id)) throw bad('You can\'t remove your own Super Admin role.', 'own_super_admin');
      if (u.is_active && (await repo.countActiveSuperAdmins(db)) <= 1) {
        throw bad('This is the last active Super Admin. Grant Super Admin to someone else first.', 'last_super_admin');
      }
    }

    await repo.removeRole(db, id, role);
    const detail = { role };
    if (role === 'ENGINEER') {
      const removed = await repo.removeAllUnitTags(db, id);
      if (removed.length) detail.unitsRemoved = removed;
    }
    await repo.logChange(db, id, 'role_removed', detail, actor.id);
    return getUserDetail(id, db);
  }).then((result) => {
    realtime.disconnectUser(id);
    return result;
  });
}

// ---------- service-unit tags ----------
async function tagUnit(id, unitId, actor) {
  return inTransaction(async (db) => {
    await mustGetUser(db, id);
    const unit = await unitsRepo.getServiceUnit(unitId);
    if (!unit) throw notFound();
    if (!(await repo.getRoles(db, id)).includes('ENGINEER')) {
      throw bad('Only users with the Engineer role can be tagged to a service unit.', 'not_engineer');
    }
    if (await repo.addUnitTag(db, id, unit.id, actor.id)) {
      await repo.logChange(db, id, 'unit_tagged', { unit: unit.code }, actor.id);
    }
    return getUserDetail(id, db);
  });
}

async function untagUnit(id, unitId, actor) {
  return inTransaction(async (db) => {
    await mustGetUser(db, id);
    const unit = await unitsRepo.getServiceUnit(unitId);
    if (!unit) throw notFound();
    if (await repo.removeUnitTag(db, id, unit.id)) {
      await repo.logChange(db, id, 'unit_untagged', { unit: unit.code }, actor.id);
    }
    return getUserDetail(id, db);
  });
}

// ---------- activate / deactivate ----------
async function setStatus(id, active, reason, actor) {
  const why = String(reason ?? '').trim();
  if (why.length < 3) throw bad('Enter a reason (at least 3 characters).', 'reason_required');
  if (why.length > 500) throw bad('Keep the reason under 500 characters.', 'reason_too_long');

  return inTransaction(async (db) => {
    const u = await mustGetUser(db, id);
    if (u.is_active === active) {
      throw bad(active ? 'This user is already active.' : 'This user is already inactive.', 'no_change');
    }
    if (!active) {
      if (String(id) === String(actor.id)) throw bad('You can\'t deactivate yourself.', 'self_deactivate');
      const roles = await repo.getRoles(db, id);
      if (roles.includes('SUPER_ADMIN') && (await repo.countActiveSuperAdmins(db)) <= 1) {
        throw bad('This is the last active Super Admin and can\'t be deactivated.', 'last_super_admin');
      }
    }
    await repo.setActive(db, id, active);
    await repo.logStatus(db, id, active, why, actor.id);
    // Phase 10 adds: on deactivation, flag the user's assets "to recover".
    return getUserDetail(id, db);
  }).then((result) => {
    if (!active) realtime.disconnectUser(id);
    return result;
  });
}

// ---------- password reset (employee-ID users) ----------
// requireChange (default true): the user must choose their own password at the next sign-in.
// The password may be the employee ID only when requireChange is on (the "first password" pattern).
async function resetPassword(id, newPassword, actor, { requireChange = true } = {}) {
  if (typeof newPassword !== 'string' || newPassword.length > 256) {
    throw bad('Password must be at most 256 characters.', 'too_long');
  }

  return inTransaction(async (db) => {
    const u = await mustGetUser(db, id);
    if (u.login_type !== 'EMPLOYEE_ID') {
      throw bad('ITS users sign in through eJamaat; their password can\'t be set in ATOM.', 'its_user');
    }
    const isEmployeeId = newPassword === u.employee_id;
    if (isEmployeeId && !requireChange) {
      throw bad('The Employee ID can only be a temporary password. Tick "must change at next sign-in".', 'employee_id_password');
    }
    if (!isEmployeeId && newPassword.length < MIN_PASSWORD) {
      throw bad(`Password must be at least ${MIN_PASSWORD} characters (or the Employee ID as a temporary password).`, 'too_short');
    }
    await passwordsRepo.setEmployeePassword(id, newPassword, db, { mustChange: requireChange });
    await passwordsRepo.expireResetTokens(id, db);
    await repo.logChange(db, id, 'password_reset', requireChange ? { mustChange: true } : null, actor.id);
    return { message: 'Password reset. The user is signed out everywhere — tell them their new password.' };
  }).then((result) => {
    realtime.disconnectUser(id);
    return result;
  });
}

module.exports = {
  listUsers,
  getUserDetail,
  createUser,
  updateProfile,
  grantRole,
  removeRole,
  tagUnit,
  untagUnit,
  setStatus,
  resetPassword,
  MIN_PASSWORD,
};
