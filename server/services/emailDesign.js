// Email design (decided 5 Nov 2026): one look for every email, editable by the Super Admin
// (Settings → Email design). Stored as one JSON row (email_design, migration 027); every save is logged.
// Colours come from the app's own themes (Teal / Navy / Maroon) or 4 custom colours. Every value is
// checked here before it is saved or previewed; the layout escapes all text again when rendering.
const defaultPool = require('../db/pool');
const { HttpError } = require('../utils/httpError');

const HEX = /^#[0-9a-f]{6}$/i;

// Same colours as the app themes (client/src/index.css). Gold stays the accent in all three.
const PALETTES = {
  teal: { label: 'Teal', primary: '#0F5B5A', accent: '#C9A84C', background: '#FAF7F2', text: '#1A1A1A' },
  navy: { label: 'Navy', primary: '#1E3A6E', accent: '#C9A84C', background: '#F6F8FC', text: '#141A28' },
  maroon: { label: 'Maroon', primary: '#721634', accent: '#C9A84C', background: '#FCF7F8', text: '#1E1519' },
};
const STYLES = ['classic', 'minimal', 'banner'];

const DEFAULTS = Object.freeze({
  palette: 'teal',
  colors: { primary: '#0F5B5A', accent: '#C9A84C', background: '#FAF7F2', text: '#1A1A1A' },
  style: 'classic',
  title: 'ATOM',
  subtitle: 'Ticketing & Operations Manager',
  showLogo: true,
  showCompany: true,
  buttonLabel: 'Open in ATOM',
  signOff: '',
  footerText: '{company} · Aljamea-tus-Saifiyah',
  noReply: 'This is an automatic message from ATOM. Please do not reply to this email.',
  showWatermark: true,
  watermark: 'ATOM · Ticketing & Operations Manager',
});

// [field, min, max] for text fields.
const TEXTS = [
  ['title', 1, 20],
  ['subtitle', 0, 60],
  ['buttonLabel', 1, 30],
  ['signOff', 0, 80],
  ['footerText', 0, 120],
  ['noReply', 0, 160],
  ['watermark', 0, 80],
];
const FLAGS = ['showLogo', 'showCompany', 'showWatermark'];
const LABELS = {
  title: 'Header title', subtitle: 'Header subtitle', buttonLabel: 'Button text', signOff: 'Sign-off',
  footerText: 'Footer line', noReply: 'Do-not-reply line', watermark: 'Watermark',
  primary: 'Main colour', accent: 'Accent colour', background: 'Background colour', text: 'Text colour',
};

class DesignError extends HttpError {
  constructor(message, field) {
    super(400, message, 'invalid');
    this.field = field;
  }
}

// ---------- colour helpers ----------
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
// t = 0 → a, t = 1 → b
const mix = (a, b, t) => toHex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// Untrusted input → a complete, clean design. Throws DesignError (400) with the field.
// strict = false (live preview only): skip the readability checks so a bad colour can be seen before saving.
function validate(input, { strict = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DesignError('Bad design.', null);
  const out = { ...DEFAULTS, colors: { ...DEFAULTS.colors } };

  const palette = input.palette ?? DEFAULTS.palette;
  if (palette !== 'custom' && !PALETTES[palette]) throw new DesignError('Choose a colour set.', 'palette');
  out.palette = palette;
  if (palette === 'custom') {
    const c = input.colors || {};
    for (const k of ['primary', 'accent', 'background', 'text']) {
      if (typeof c[k] !== 'string' || !HEX.test(c[k].trim())) throw new DesignError(`${LABELS[k]}: use a colour like #0F5B5A.`, k);
      out.colors[k] = c[k].trim().toUpperCase();
    }
    // Readability: white button text on the main colour; text on the background.
    if (strict && contrast(out.colors.primary, '#FFFFFF') < 4.5) throw new DesignError('Main colour is too light for white text on the button — choose a darker one.', 'primary');
    if (strict && contrast(out.colors.text, out.colors.background) < 7) throw new DesignError('Text colour is too close to the background — it would be hard to read.', 'text');
    if (strict && contrast('#FFFFFF', out.colors.background) > 1.25) throw new DesignError('Background colour should be a very light shade.', 'background');
  } else {
    const { label, ...colors } = PALETTES[palette];
    out.colors = colors;
  }

  const style = input.style ?? DEFAULTS.style;
  if (!STYLES.includes(style)) throw new DesignError('Choose a style.', 'style');
  out.style = style;

  for (const [k, min, max] of TEXTS) {
    const v = input[k] ?? DEFAULTS[k];
    if (typeof v !== 'string') throw new DesignError(`${LABELS[k]}: bad value.`, k);
    const s = v.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (s.length < min) throw new DesignError(`${LABELS[k]} is required.`, k);
    if (s.length > max) throw new DesignError(`${LABELS[k]}: up to ${max} characters.`, k);
    out[k] = s;
  }
  for (const k of FLAGS) {
    const v = input[k] ?? DEFAULTS[k];
    if (typeof v !== 'boolean') throw new DesignError('Bad value.', k);
    out[k] = v;
  }
  return out;
}

// Design → everything the layout needs (derived shades included).
function resolve(design = DEFAULTS) {
  const { primary, accent, background, text } = design.colors;
  return {
    ...design,
    c: {
      primary,
      primaryDark: mix(primary, '#000000', 0.25),
      primarySoft: mix(primary, '#FFFFFF', 0.9),
      onPrimarySoft: mix('#FFFFFF', primary, 0.22),
      accent,
      accentInk: mix(accent, '#000000', 0.45),
      accentSoft: mix(accent, '#FFFFFF', 0.82),
      background,
      card: '#FFFFFF',
      line: mix(background, text, 0.12),
      ink: text,
      ink2: mix(text, background, 0.3),
      ink3: mix(text, background, 0.48),
      faint: mix(text, background, 0.62),
    },
  };
}

// ---------- storage (30 s cache per server process) ----------
let cache = null;
let cachedAt = 0;
const TTL = 30_000;

async function current(db = defaultPool) {
  if (cache && Date.now() - cachedAt < TTL) return cache;
  try {
    const { rows } = await db.query('SELECT design FROM email_design WHERE id = 1');
    cache = rows[0] ? validate(rows[0].design) : { ...DEFAULTS, colors: { ...DEFAULTS.colors } };
  } catch {
    // Table missing (migration not run yet) or a stored value no longer valid: fall back to the default.
    cache = { ...DEFAULTS, colors: { ...DEFAULTS.colors } };
  }
  cachedAt = Date.now();
  return cache;
}

async function save(user, input, db = defaultPool, kind = 'save') {
  const design = validate(input);
  await db.query(
    `INSERT INTO email_design (id, design, updated_by, updated_at) VALUES (1, $1::jsonb, $2::bigint, now())
     ON CONFLICT (id) DO UPDATE SET design = EXCLUDED.design, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(design), user.id]
  );
  await db.query('INSERT INTO email_design_log (kind, design, actor_id) VALUES ($1::text, $2::jsonb, $3::bigint)', [kind, JSON.stringify(design), user.id]);
  cache = design;
  cachedAt = Date.now();
  return design;
}

const reset = (user, db = defaultPool) => save(user, DEFAULTS, db, 'reset');

async function history(db = defaultPool, limit = 5) {
  const { rows } = await db.query(
    `SELECT l.kind, l.created_at, u.name AS by_name
       FROM email_design_log l LEFT JOIN users u ON u.id = l.actor_id
      ORDER BY l.id DESC LIMIT $1::int`,
    [limit]
  );
  return rows.map((r) => ({ kind: r.kind, at: r.created_at, by: r.by_name || null }));
}

const clearCache = () => {
  cache = null;
  cachedAt = 0;
};

module.exports = { DEFAULTS, PALETTES, STYLES, validate, resolve, current, save, reset, history, clearCache, contrast, DesignError };
