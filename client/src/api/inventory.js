import http from './http';

const base = '/inventory';
const enc = encodeURIComponent;

export const listAssets = (params) => http.get(`${base}/assets`, { params }).then((r) => r.data);
export const getAsset = (tag) => http.get(`${base}/assets/${enc(tag)}`).then((r) => r.data.asset);
export const createAsset = (body) => http.post(`${base}/assets`, body).then((r) => r.data.asset);
export const updateAsset = (tag, body) => http.patch(`${base}/assets/${enc(tag)}`, body).then((r) => r.data.asset);
export const assetAction = (tag, action, body) => http.post(`${base}/assets/${enc(tag)}/${action}`, body).then((r) => r.data.asset);
export const myAssets = () => http.get(`${base}/mine`).then((r) => r.data.assets);

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
