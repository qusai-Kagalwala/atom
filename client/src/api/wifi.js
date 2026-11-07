import http from './http';

// Jamea Internet Access — Wi-Fi passes (AVIT). Answers contain passwords — the server sends them with no-store.
const base = '/wifi';
export const getWifiMe = () => http.get(`${base}/me`).then((r) => r.data); // { isAdmin, hodDepartments }
export const lookupIts = (its) => http.get(`${base}/lookup`, { params: { its } }).then((r) => r.data);

// Admin
export const listBatches = () => http.get(`${base}/batches`).then((r) => r.data.batches);
export const getBatch = (id) => http.get(`${base}/batches/${id}`).then((r) => r.data); // { batch, departments }
export function uploadBatch(file, fields) {
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.append(k, String(v)));
  form.append('file', file);
  return http.post(`${base}/batches`, form, { timeout: 120000 }).then((r) => r.data);
}
export const allocate = (id, items) => http.post(`${base}/batches/${id}/allocate`, { items }).then((r) => r.data);
// Move unused passes from one department to another (toDepartmentId null = back to the unallocated pool).
export const movePasses = (id, body) => http.post(`${base}/batches/${id}/move`, body).then((r) => r.data);
export const resetBatch = (id) => http.post(`${base}/batches/${id}/reset`).then((r) => r.data);
export const listPasses = (id, params) => http.get(`${base}/batches/${id}/passes`, { params }).then((r) => r.data);
export const listWifiRequests = () => http.get(`${base}/requests`).then((r) => r.data.requests);
export const decideWifiRequest = (id, body) => http.post(`${base}/requests/${id}`, body).then((r) => r.data.requests);
export const getWifiSettings = () => http.get(`${base}/settings`).then((r) => r.data);
// HOD access (Super Admin): grant / revoke for one or more departments; clear = back to the Idarah post.
export const setHodAccess = (body) => http.put(`${base}/settings/hods`, body).then((r) => r.data);
export const clearHodAccess = (userId, departmentId) => http.delete(`${base}/settings/hods/${userId}/${departmentId}`).then((r) => r.data);
export const saveWifiSettings = (hodPosts) => http.patch(`${base}/settings`, { hodPosts }).then((r) => r.data);

// HOD (and Admin)
export const departmentView = (id) => http.get(`${base}/departments/${id}`).then((r) => r.data);
export const requestMore = (id, body) => http.post(`${base}/departments/${id}/requests`, body).then((r) => r.data);
export const assignPasses = (batchId, body) => http.post(`${base}/batches/${batchId}/assign`, body, { timeout: 120000 }).then((r) => r.data.passes);
// Passes given together (2+ in one Give) are taken back together only (7 Nov 2026).
export const unassignGroup = (groupId) => http.post(`${base}/groups/${groupId}/unassign`).then((r) => r.data);
export const unassignPass = (id) => http.post(`${base}/passes/${id}/unassign`).then((r) => r.data);
export const markWhatsapp = (id) => http.post(`${base}/passes/${id}/whatsapp`).then((r) => r.data);
export const emailPasses = (passIds) => http.post(`${base}/passes/email`, { passIds }, { timeout: 120000 }).then((r) => r.data);
