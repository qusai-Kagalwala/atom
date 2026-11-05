// eJamaat client (eJamaat Login Kit, updated with the Oct 2026 Update Kit).
// Calls go through ./ejamaatSoap.js — plain SOAP 1.1 POSTs that never download the service's
// WSDL (the ?wsdl URL returns HTTP 500). Exports and return shapes are unchanged, so
// auth.service.js needs no change.
// ATOM uses AuthenticateEjamaatId (login), GetMuminNewPhoto (optional photo) and Jamea_MuminDetails
// (only to fill a person's details for Jamea Internet Access).
// No profile lookup at login: names and emails come from the Idarah sync (ATOM_Decisions.md §4).
// SECURITY: never log the password, the app key or an eJamaat answer.
const { config } = require('../config/env');
const { callOperation } = require('./ejamaatSoap');

const ITS_PATTERN = /^\d{8}$/;

// eJamaat answers "1" = correct ITS + password, "2" = wrong. Anything else = failure (fail closed).
const isSuccess = (raw) => String(raw ?? '').trim() === '1';

// -> { success: boolean }. Throws only when eJamaat can't be reached or answers abnormally
// (HTTP error, SOAP Fault, refused caller, timeout) — the caller returns 502.
async function authenticate(itsNumber, password) {
  const its = String(itsNumber ?? '').trim();
  if (!ITS_PATTERN.test(its)) return { success: false }; // never send junk to eJamaat
  const { text } = await callOperation('AuthenticateEjamaatId', {
    EjamaatId: its,
    Password: String(password ?? ''),
    strKey: config.ejamaat.appKey,
  });
  return { success: isSuccess(text) };
}

// Profile photo as a data URL, or null. Optional and best-effort; callers cache the result.
async function getPhoto(itsNumber) {
  const its = String(itsNumber ?? '').trim();
  if (!ITS_PATTERN.test(its)) return null;
  try {
    const { text } = await callOperation('GetMuminNewPhoto', { EjamaatId: its, strKey: config.ejamaat.appKey });
    const base64 = String(text ?? '').trim();
    return /^[A-Za-z0-9+/]+={0,2}$/.test(base64) ? `data:image/jpeg;base64,${base64}` : null;
  } catch (err) {
    console.warn(`[ATOM] Ejamaat photo lookup failed for ${its}: ${err.message}`);
    return null;
  }
}

// A person's name, mobile and email from Jamea_MuminDetails (Jamea Internet Access, 5 Nov 2026), or null.
// The answer's field names are matched loosely (they are not documented here). Best-effort: any failure
// returns null and the caller lets the person type the details. Values are never logged.
const FIELD = {
  name: [/^full_?name(_?en)?$/i, /^(mumin_?)?name(_?en)?$/i, /name/i],
  mobile: [/^mobile(_?no)?$/i, /mobile|cell/i, /phone/i],
  email: [/^e_?mail(_?id)?$/i, /mail/i],
};
function pick(row, patterns, skip = []) {
  const keys = Object.keys(row).filter((k) => !skip.some((r) => r.test(k)));
  for (const p of patterns) {
    const k = keys.find((key) => p.test(key) && String(row[key] ?? '').trim());
    if (k) return String(row[k]).trim();
  }
  return null;
}
async function getMuminDetails(itsNumber) {
  const its = String(itsNumber ?? '').trim();
  if (!ITS_PATTERN.test(its)) return null;
  try {
    const { rows } = await callOperation('Jamea_MuminDetails', { EjamaatId: its, strKey: config.ejamaat.appKey });
    const row = rows && rows[0];
    if (!row) return null;
    const name = pick(row, FIELD.name, [/arab/i, /father|mother|jamaat|jamiat|city|country|nationality/i]);
    const mobile = pick(row, FIELD.mobile);
    const email = pick(row, FIELD.email);
    if (!name && !mobile && !email) {
      console.warn(`[ATOM] Ejamaat Jamea_MuminDetails: no name/mobile/email field (fields: ${Object.keys(row).join(', ')})`);
      return null;
    }
    return { name, mobile, email };
  } catch (err) {
    console.warn(`[ATOM] Ejamaat details lookup failed: ${err.message}`);
    return null;
  }
}

module.exports = { authenticate, getPhoto, getMuminDetails, isSuccess };
