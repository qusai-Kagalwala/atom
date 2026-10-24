import http from './http';

const UPLOAD = { timeout: 120000 };

export const listInvoices = (params) => http.get('/invoices', { params }).then((r) => r.data);
export const getInvoice = (number) => http.get(`/invoices/${number}`).then((r) => r.data.invoice);
export const updateInvoice = (number, body) => http.patch(`/invoices/${number}`, body).then((r) => r.data.invoice);
export const linkInvoice = (number, requestNumbers) =>
  http.post(`/invoices/${number}/links`, { requestNumbers }).then((r) => r.data);
export const unlinkInvoice = (number, requestNumber, reason) =>
  http.post(`/invoices/${number}/links/${requestNumber}/unlink`, { reason }).then((r) => r.data.invoice);

// → { invoice, added, already, created? , linkedExisting? }.
// A duplicate file rejects with error.response.status 409 and data.duplicate = { number, … }.
export function uploadInvoice(fields, file) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
  form.append('file', file);
  return http.post('/invoices', form, UPLOAD).then((r) => r.data);
}

// Invoice files need the login token, so they're fetched as blobs.
export const fetchInvoiceFile = (url) => http.get(url, { responseType: 'blob', timeout: 60000 }).then((r) => r.data);
