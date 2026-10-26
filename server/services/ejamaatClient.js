// eJamaat client (eJamaat Login Kit, updated with the Oct 2026 Update Kit).
// Calls go through ./ejamaatSoap.js — plain SOAP 1.1 POSTs that never download the service's
// WSDL (the ?wsdl URL returns HTTP 500). Exports and return shapes are unchanged, so
// auth.service.js needs no change.
// ATOM uses only AuthenticateEjamaatId (login) and GetMuminNewPhoto (optional photo).
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

module.exports = { authenticate, getPhoto, isSuccess };
