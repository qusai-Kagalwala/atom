import http from './http';

// Guest Wi-Fi passes (AVIT). Answers contain passwords — the server sends them with no-store.
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
export const resetBatch = (id) => http.post(`${base}/batches/${id}/reset`).then((r) => r.data);
export const listPasses = (id, params) => http.get(`${base}/batches/${id}/passes`, { params }).then((r) => r.data);
export const listWifiRequests = () => http.get(`${base}/requests`).then((r) => r.data.requests);
export const decideWifiRequest = (id, body) => http.post(`${base}/requests/${id}`, body).then((r) => r.data.requests);
export const getWifiSettings = () => http.get(`${base}/settings`).then((r) => r.data);
export const saveWifiSettings = (hodPosts) => http.patch(`${base}/settings`, { hodPosts }).then((r) => r.data);

// HOD (and Admin)
export const departmentView = (id) => http.get(`${base}/departments/${id}`).then((r) => r.data);
export const requestMore = (id, body) => http.post(`${base}/departments/${id}/requests`, body).then((r) => r.data);
export const assignPasses = (batchId, body) => http.post(`${base}/batches/${batchId}/assign`, body, { timeout: 120000 }).then((r) => r.data.passes);
export const unassignPass = (id) => http.post(`${base}/passes/${id}/unassign`).then((r) => r.data);
export const markWhatsapp = (id) => http.post(`${base}/passes/${id}/whatsapp`).then((r) => r.data);
export const emailPasses = (passIds) => http.post(`${base}/passes/email`, { passIds }, { timeout: 120000 }).then((r) => r.data);
