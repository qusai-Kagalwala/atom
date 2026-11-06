// "Turn on notifications on this device" — offered first thing after every sign-in (6 Nov 2026) when the
// device can show them and they aren't on yet. "Not now" hides it until the next sign-in.
const KEY = 'atom.pushPrompt';

export function markPushPrompt() {
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    /* storage blocked: no prompt */
  }
}

export function pushPromptPending() {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function clearPushPrompt() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
