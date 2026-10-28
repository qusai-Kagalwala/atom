// Browser storage for the ATOM session. ATOM-specific keys only — Awraaq shares this domain,
// so never reuse its keys. Every access is wrapped: storage can be blocked or throw.
const TOKEN_KEY = 'atom_token';
const USER_KEY = 'atom_user';
// Last role per company (and with no company: the Super Admin console), last company — per device.
const lastRoleKey = (userId, companyId) => `atom_last_role_${userId}${companyId ? `_${companyId}` : ''}`;
const lastCompanyKey = (userId) => `atom_last_company_${userId}`;

function read(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — session lasts until the tab closes */
  }
}

export function getToken() {
  return read(TOKEN_KEY);
}

export function getStoredUser() {
  try {
    return JSON.parse(read(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

export function saveSession(token, user) {
  write(TOKEN_KEY, token);
  write(USER_KEY, JSON.stringify(user));
}

// Replaces only the token (e.g. after a password change; the user is unchanged).
export function saveToken(token) {
  write(TOKEN_KEY, token);
}

export function saveUser(user) {
  write(USER_KEY, JSON.stringify(user));
}

// Keeps the last-used role and company (they're per device, on purpose).
export function clearSession() {
  write(TOKEN_KEY, null);
  write(USER_KEY, null);
}

export function getLastRole(userId, companyId) {
  return userId ? read(lastRoleKey(userId, companyId)) : null;
}

export function setLastRole(userId, role, companyId) {
  if (userId) write(lastRoleKey(userId, companyId), role);
}

export function getLastCompany(userId) {
  return userId ? read(lastCompanyKey(userId)) : null;
}

export function setLastCompany(userId, companyId) {
  if (userId) write(lastCompanyKey(userId), companyId || null);
}
