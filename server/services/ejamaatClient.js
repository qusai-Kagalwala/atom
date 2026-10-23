// eJamaat SOAP client (from the eJamaat Login Kit).
// Changes for ATOM: reads config/env, call timeouts, resets the cached client after a failure,
// no profile lookup at login (name/email come from the Idarah sync).
// SECURITY: never log the password, the app key or the request arguments.
const soap = require('soap');
const { config } = require('../config/env');

let clientPromise = null;

function getClient() {
  const { soapUrl, appKey, timeoutMs } = config.ejamaat;
  if (!soapUrl || !appKey) {
    return Promise.reject(new Error('EJAMAAT_SOAP_URL and EJAMAAT_APP_KEY are not set'));
  }
  if (!clientPromise) {
    clientPromise = soap.createClientAsync(soapUrl, { wsdl_options: { timeout: timeoutMs } }).catch((err) => {
      clientPromise = null; // retry WSDL fetch on the next call
      throw err;
    });
  }
  return clientPromise;
}

// eJamaat answers "1" = correct ITS + password, "2" = wrong. Anything else = failure (fail closed).
const isSuccess = (raw) => String(raw ?? '').trim() === '1';

// -> { success: boolean }. Throws only when eJamaat can't be reached (caller returns 502).
async function authenticate(itsNumber, password) {
  const client = await getClient();
  const [response] = await client.AuthenticateEjamaatIdAsync(
    { EjamaatId: parseInt(itsNumber, 10), Password: password, strKey: config.ejamaat.appKey },
    { timeout: config.ejamaat.timeoutMs }
  );
  return { success: isSuccess(response?.AuthenticateEjamaatIdResult) };
}

// Profile photo as a data URL, or null. Optional; callers cache the result.
async function getPhoto(itsNumber) {
  try {
    const client = await getClient();
    const [response] = await client.GetMuminNewPhotoAsync(
      { EjamaatId: parseInt(itsNumber, 10), strKey: config.ejamaat.appKey },
      { timeout: config.ejamaat.timeoutMs }
    );
    const base64 = response?.GetMuminNewPhotoResult ?? '';
    return base64 ? `data:image/jpeg;base64,${base64}` : null;
  } catch (err) {
    console.warn(`eJamaat photo lookup failed for ${itsNumber}: ${err.message}`);
    return null;
  }
}

module.exports = { authenticate, getPhoto, isSuccess };
