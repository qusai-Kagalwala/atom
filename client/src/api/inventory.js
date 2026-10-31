import http from './http';

const base = '/inventory';
const enc = encodeURIComponent;

export const listAssets = (params) => http.get(`${base}/assets`, { params }).then((r) => r.data);
export const getAsset = (tag) => http.get(`${base}/assets/${enc(tag)}`).then((r) => r.data.asset);
export const createAsset = (body) => http.post(`${base}/assets`, body).then((r) => r.data.asset);
export const updateAsset = (tag, body) => http.patch(`${base}/assets/${enc(tag)}`, body).then((r) => r.data.asset);
export const assetAction = (tag, action, body) => http.post(`${base}/assets/${enc(tag)}/${action}`, body).then((r) => r.data.asset);
export const myAssets = () => http.get(`${base}/mine`).then((r) => r.data); // { assets, seats, roomAssets }

export const listAssetCategories = () => http.get(`${base}/categories`).then((r) => r.data.categories);
export const createAssetCategory = (name) => http.post(`${base}/categories`, { name }).then((r) => r.data.category);
export const renameAssetCategory = (id, name) => http.patch(`${base}/categories/${id}`, { name }).then((r) => r.data.category);
export const mergeAssetCategory = (id, intoId) => http.post(`${base}/categories/${id}/merge`, { intoId }).then((r) => r.data);

export const listPlaces = (params) => http.get(`${base}/places`, { params }).then((r) => r.data);
export const createPlace = (body) => http.post(`${base}/places`, body).then((r) => r.data.place);
export const updatePlace = (id, body) => http.patch(`${base}/places/${id}`, body).then((r) => r.data.place);

// Snipe-IT CSV: preview (commit false) or import. Large file → long timeout.
export function importSnipeit(file, { commit = false, keepAtomEdits = false, skipErrors = false } = {}) {
  const form = new FormData();
  form.append('commit', String(commit));
  form.append('keepAtomEdits', String(keepAtomEdits));
  form.append('skipErrors', String(skipErrors));
  form.append('file', file);
  return http.post(`${base}/import`, form, { timeout: 300000 }).then((r) => r.data);
}
export const listImports = () => http.get(`${base}/imports`).then((r) => r.data.imports);

// Inventory file (Super Admin): export the filtered list as .xlsx, edit it, import it back.
export async function exportInventory(params) {
  const r = await http.get(`${base}/export`, { params, responseType: 'blob', timeout: 300000 });
  const name = /filename="([^"]+)"/.exec(r.headers['content-disposition'] || '')?.[1] || 'ATOM-inventory.xlsx';
  const url = URL.createObjectURL(r.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { name, rows: Number(r.headers['x-atom-rows']) || null };
}
export function importInventoryFile(file, { commit = false, overwrite = false, allowNew = true, skipErrors = false } = {}) {
  const form = new FormData();
  form.append('commit', String(commit));
  form.append('overwrite', String(overwrite));
  form.append('allowNew', String(allowNew));
  form.append('skipErrors', String(skipErrors));
  form.append('file', file);
  return http.post(`${base}/import-file`, form, { timeout: 300000 }).then((r) => r.data);
}

// Onboarding / offboarding (Phase 10, company Admin)
export const searchInventoryPeople = (q) => http.get(`${base}/people`, { params: { q } }).then((r) => r.data.people);
export const personEquipment = (id) => http.get(`${base}/people/${id}`).then((r) => r.data); // { person, assets }
export const receiveFromPerson = (id, body) => http.post(`${base}/people/${id}/receive`, body).then((r) => r.data);
export const listToRecover = () => http.get(`${base}/to-recover`).then((r) => r.data); // { people, total }
