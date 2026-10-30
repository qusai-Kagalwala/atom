import http from './http';

// Super Admin only (global).
export const listUsers = (params) => http.get('/users', { params }).then((r) => r.data);
export const getUser = (id) => http.get(`/users/${id}`).then((r) => r.data.user);
export const createUser = (body) => http.post('/users', body).then((r) => r.data.user);
export const updateUser = (id, body) => http.patch(`/users/${id}`, body).then((r) => r.data.user);
// Admin: { companyId }. Staff: { companyId, occupationId }.
export const grantRole = (id, role, { companyId, occupationId } = {}) =>
  http.post(`/users/${id}/roles`, { role, companyId: companyId || null, occupationId: occupationId || null }).then((r) => r.data.user);
export const removeRole = (id, role) => http.delete(`/users/${id}/roles/${role}`).then((r) => r.data.user);
export const setUserStatus = (id, active, reason) =>
  http.post(`/users/${id}/status`, { active, reason }).then((r) => r.data.user);
export const resetUserPassword = (id, newPassword, requireChange = true) =>
  http.post(`/users/${id}/password`, { newPassword, requireChange }).then((r) => r.data);

// Companies (AVIT, Siyanaat, Tanzeem).
export const listServiceUnits = () => http.get('/service-units').then((r) => r.data.serviceUnits);

// job: 'idarah' (Idarah view) | 'hr' (HR employee list, Phase 3.1)
export const listSyncRuns = (job = 'idarah', limit = 20) =>
  http.get('/sync/runs', { params: { job, limit } }).then((r) => r.data.runs);
export const listOldAccounts = () => http.get('/sync/old-accounts').then((r) => r.data);
// Resolves with the run result for success / blocked / busy / failed alike (they are all "answers").
export const runSync = (job, force) =>
  http
    .post(`/sync/${job}`, { force })
    .then((r) => r.data)
    .catch((err) => {
      if (err.response?.data?.status) return err.response.data;
      throw err;
    });
// Support Log item lists (step B). options: { companies, keepAtomEdits, force, preview }.
export const runItemsSync = (options) =>
  http
    .post('/sync/items', options)
    .then((r) => r.data)
    .catch((err) => {
      if (err.response?.data?.status) return err.response.data;
      throw err;
    });
