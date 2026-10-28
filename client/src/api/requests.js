import http from './http';

export const listCategories = () => http.get('/requests/categories').then((r) => r.data.categories);
// "Where?" prefill from the department (forUserId: Super Admin raising for someone).
export const getDefaultLocation = (forUserId) =>
  http.get('/requests/default-location', { params: forUserId ? { for: forUserId } : {} }).then((r) => r.data.location);
export const listMyRequests = (params) => http.get('/requests/mine', { params }).then((r) => r.data);
export const getTicket = (number) => http.get(`/requests/${number}`).then((r) => r.data.request);

function toForm(fields, photos = []) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
  for (const p of photos) form.append('photos', p);
  return form;
}

// Photos can take a while on slow connections.
const UPLOAD = { timeout: 120000 };

export const raiseTicket = (fields, photos) => http.post('/requests', toForm(fields, photos), UPLOAD).then((r) => r.data.request);
export const addComment = (number, fields, photos) =>
  http.post(`/requests/${number}/comments`, toForm(fields, photos), UPLOAD).then((r) => r.data.request);
export const ticketAction = (number, action, body = {}) =>
  http.post(`/requests/${number}/actions/${action}`, body).then((r) => r.data.request);
export const triageTicket = (number, body) => http.patch(`/requests/${number}`, body).then((r) => r.data.request);
export const eligibleEngineers = (number) => http.get(`/requests/${number}/engineers`).then((r) => r.data.engineers);

// Photos need the login token, so they're fetched as blobs (an <img src> can't send it).
export const fetchAttachment = (url) => http.get(url, { responseType: 'blob' }).then((r) => r.data);

// Phase 7: queues and lists.
export const queueCounts = () => http.get('/requests/counts').then((r) => r.data.counts);
export const listEngineers = () => http.get('/requests/engineers').then((r) => r.data.engineers);
export const listWorkQueue = (params) => http.get('/requests/queue/work', { params }).then((r) => r.data);
export const listAssignQueue = (params) => http.get('/requests/queue/assign', { params }).then((r) => r.data);
export const listAllRequests = (params) => http.get('/requests/all', { params }).then((r) => r.data);

// Phase 9: catalogue + service requests.
export const listCatalogue = (includeInactive) =>
  http.get('/requests/catalogue', { params: includeInactive ? { includeInactive: 1 } : {} }).then((r) => r.data.items);
export const createCatalogueItem = (body) => http.post('/requests/catalogue', body).then((r) => r.data.item);
export const updateCatalogueItem = (id, body) => http.patch(`/requests/catalogue/${id}`, body).then((r) => r.data.item);
export const raiseServiceRequest = (body) => http.post('/requests/service', body).then((r) => r.data.request);
export const decideItems = (number, decisions) => http.post(`/requests/${number}/items/decide`, { decisions }).then((r) => r.data.request);
export const deliverItem = (number, itemId, body) => http.post(`/requests/${number}/items/${itemId}/deliver`, body).then((r) => r.data.request);
export const getTimeFrames = () => http.get('/requests/time-frames').then((r) => r.data.timeFrames);
