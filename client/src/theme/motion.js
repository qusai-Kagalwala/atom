// The Animations choice: 'system' (follow the device's reduced-motion setting, the default), 'full' or
// 'reduced'. Kept on this device only — like the device setting it follows, it is about the person's
// comfort on this screen. public/assets/theme-init-v2.js sets the same attribute before first paint.
export const MOTION_KEY = 'atom.motion';
export const MOTION_IDS = ['system', 'full', 'reduced'];

export function readMotion() {
  try {
    const m = localStorage.getItem(MOTION_KEY);
    return MOTION_IDS.includes(m) ? m : 'system';
  } catch {
    return 'system';
  }
}

export function persistMotion(motion) {
  try {
    localStorage.setItem(MOTION_KEY, motion);
  } catch {
    /* storage blocked: the choice lasts until the page closes */
  }
}

// 'system' leaves the attribute off, so the CSS falls back to the device's setting.
export function applyMotion(motion) {
  const root = document.documentElement;
  if (motion === 'system') root.removeAttribute('data-motion');
  else root.setAttribute('data-motion', motion);
}

// True when movement is welcome right now: the explicit choice, otherwise the device's setting.
export function motionAllowed() {
  const m = document.documentElement.getAttribute('data-motion');
  if (m === 'full') return true;
  if (m === 'reduced') return false;
  return !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
