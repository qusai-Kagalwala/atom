import http from './http';

export const listCategories = () => http.get('/requests/categories').then((r) => r.data.categories);
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
