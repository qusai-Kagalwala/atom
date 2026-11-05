import shared from '@shared/themes.json';

// Names the palettes and does the browser plumbing for them. The colours themselves live in index.css
// ([data-theme] / [data-mode] blocks). public/assets/theme-init-v2.js does the same job before first
// paint (it cannot import), so keep the storage keys and ids in step with it. The allowed values are
// shared/themes.json — the server validates what it saves against the same file.
export const STORAGE_KEYS = { theme: 'atom.theme', mode: 'atom.mode' };

// Today's look: nobody sees a change until they pick something else.
export const DEFAULT_PREFS = { ...shared.default };

export const MODE_IDS = shared.modes;

// `preview` colours are only for the picker's swatches (it has to show themes you are not using).
export const THEMES = [
  {
    id: 'teal',
    label: 'Teal',
    blurb: 'The classic ATOM look',
    preview: {
      light: { bar: '#0F5B5A', page: '#FAF7F2', card: '#FFFFFF' },
      dark: { bar: '#0E4E4D', page: '#0E1616', card: '#151F1F' },
    },
  },
  {
    id: 'navy',
    label: 'Navy',
    blurb: 'Calm and corporate',
    preview: {
      light: { bar: '#1E3A6E', page: '#F6F8FC', card: '#FFFFFF' },
      dark: { bar: '#22427C', page: '#0C111D', card: '#121928' },
    },
  },
  {
    id: 'maroon',
    label: 'Maroon',
    blurb: 'Rich and traditional',
    preview: {
      light: { bar: '#721634', page: '#FCF7F8', card: '#FFFFFF' },
      dark: { bar: '#7E1C3E', page: '#180D11', card: '#211318' },
    },
  },
];

const THEME_IDS = shared.themes;

export function normalizePrefs(prefs) {
  return {
    theme: THEME_IDS.includes(prefs?.theme) ? prefs.theme : DEFAULT_PREFS.theme,
    mode: MODE_IDS.includes(prefs?.mode) ? prefs.mode : DEFAULT_PREFS.mode,
  };
}

export function readStored() {
  try {
    return normalizePrefs({
      theme: localStorage.getItem(STORAGE_KEYS.theme),
      mode: localStorage.getItem(STORAGE_KEYS.mode),
    });
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function persist(prefs) {
  try {
    localStorage.setItem(STORAGE_KEYS.theme, prefs.theme);
    localStorage.setItem(STORAGE_KEYS.mode, prefs.mode);
  } catch {
    /* storage blocked: the choice lasts until the page closes */
  }
}

export function systemPrefersDark() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveMode(mode, systemDark) {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

// Browser bars (address bar, phone bottom toolbar, installed-app bar) follow the theme: read the primary the CSS
// just resolved. The tag is REPLACED, not edited: some phone browsers ignore a changed `content` on a tag that
// already exists and stay on the first colour (the teal fallback in index.html).
function syncThemeColor() {
  const rgb = getComputedStyle(document.documentElement).getPropertyValue('--c-primary').trim().split(/\s+/).map(Number);
  if (rgb.length !== 3 || rgb.some(Number.isNaN)) return;
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  document.head.appendChild(meta);
}

export function applyTheme(theme, resolvedMode) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-mode', resolvedMode);
  syncThemeColor();
}
