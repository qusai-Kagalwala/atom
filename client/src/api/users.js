import http from './http';

// Super Admin only.
export const listUsers = (params) => http.get('/users', { params }).then((r) => r.data);
export const getUser = (id) => http.get(`/users/${id}`).then((r) => r.data.user);
export const createUser = (body) => http.post('/users', body).then((r) => r.data.user);
export const updateUser = (id, body) => http.patch(`/users/${id}`, body).then((r) => r.data.user);
export const grantRole = (id, role) => http.post(`/users/${id}/roles`, { role }).then((r) => r.data.user);
export const removeRole = (id, role) => http.delete(`/users/${id}/roles/${role}`).then((r) => r.data.user);
export const tagUnit = (id, serviceUnitId) =>
  http.post(`/users/${id}/service-units`, { serviceUnitId: Number(serviceUnitId) }).then((r) => r.data.user);
export const untagUnit = (id, serviceUnitId) =>
  http.delete(`/users/${id}/service-units/${serviceUnitId}`).then((r) => r.data.user);
export const setUserStatus = (id, active, reason) =>
  http.post(`/users/${id}/status`, { active, reason }).then((r) => r.data.user);
export const resetUserPassword = (id, newPassword) =>
  http.post(`/users/${id}/password`, { newPassword }).then((r) => r.data);

export const listServiceUnits = () => http.get('/service-units').then((r) => r.data.serviceUnits);

export const listSyncRuns = (limit = 20) => http.get('/sync/runs', { params: { limit } }).then((r) => r.data.runs);
// Resolves with the run result for success / blocked / busy / failed alike (they are all "answers").
export const runIdarahSync = (force) =>
  http
    .post('/sync/idarah', { force })
    .then((r) => r.data)
    .catch((err) => {
      if (err.response?.data?.status) return err.response.data;
      throw err;
    });
