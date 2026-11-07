// Email wording per template (decided 7 Nov 2026), edited by the Super Admin in Settings → Email design.
// Four templates: Ticket, Service request, Jamea Internet Access, Password reset. Each has a subject, a
// greeting (several lines allowed, e.g. "Salaam-e-Jameel" then "{name}"), an intro and a closing line.
// The details table (ticket number, Wi-Fi network, username…) and the button stay automatic.
// Placeholders in {braces}; an unknown one is refused when saving. A line left empty because its
// placeholder had no value (no name on file) is dropped, so "Assalamu Alaikum {name}," never ends as
// "Assalamu Alaikum ,". Stored inside the email design (email_design.design.templates).

const KEYS = ['ticket', 'request', 'wifi', 'reset'];

const LABELS = {
  ticket: 'Ticket',
  request: 'Service request',
  wifi: 'Jamea Internet Access',
  reset: 'Password reset',
};

// What each template may use. {company} is the sending company (ATOM for the password reset).
const PLACEHOLDERS = {
  ticket: ['name', 'company', 'number', 'title'],
  request: ['name', 'company', 'number', 'title'],
  wifi: ['name', 'company', 'ssid', 'validUntil', 'count'],
  reset: ['name', 'minutes'],
};

// Defaults = the wording ATOM used before this was editable.
const DEFAULTS = Object.freeze({
  ticket: { subject: 'ATOM: {title}', greeting: '', intro: '', closing: '' },
  request: { subject: 'ATOM: {title}', greeting: '', intro: '', closing: '' },
  wifi: {
    subject: 'Your Jamea Internet Access — Aljamea-tus-Saifiyah',
    greeting: 'Assalamu Alaikum {name},',
    intro: 'Here are your Jamea Internet Access details for Aljamea-tus-Saifiyah.',
    closing: 'Connect to the network above, then sign in with this username and password. Please do not share it.',
  },
  reset: {
    subject: 'Reset your ATOM password',
    greeting: '',
    intro: 'We received a request to reset your ATOM password. Open the link below within {minutes} minutes to choose a new one.',
    closing: 'If you did not ask for this, you can ignore this email — your password will not change.',
  },
});

// [field, label, min, max, maxLines]
const FIELDS = [
  ['subject', 'Subject', 1, 150, 1],
  ['greeting', 'Greeting', 0, 300, 4],
  ['intro', 'Intro', 0, 1000, 12],
  ['closing', 'Closing', 0, 600, 8],
];

const copyDefaults = () => Object.fromEntries(KEYS.map((k) => [k, { ...DEFAULTS[k] }]));

// Untrusted → complete, clean templates. Missing templates / fields fall back to the defaults.
// fail(message, field) must throw; field is e.g. "templates.wifi.greeting".
function validate(input, fail) {
  const out = copyDefaults();
  if (input == null) return out;
  if (typeof input !== 'object' || Array.isArray(input)) fail('Bad email text.', 'templates');
  for (const key of KEYS) {
    const t = input[key];
    if (t == null) continue;
    if (typeof t !== 'object' || Array.isArray(t)) fail(`${LABELS[key]}: bad value.`, `templates.${key}`);
    for (const [field, label, min, max, maxLines] of FIELDS) {
      const raw = t[field] ?? DEFAULTS[key][field];
      const where = `templates.${key}.${field}`;
      if (typeof raw !== 'string') fail(`${LABELS[key]} · ${label}: bad value.`, where);
      // Keep line breaks (except in the subject); tidy spaces on each line; no more than one empty line in a row.
      let v = raw.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
      v = maxLines === 1
        ? v.replace(/\n+/g, ' ').replace(/ {2,}/g, ' ').trim()
        : v.split('\n').map((l) => l.replace(/ {2,}/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (v.length < min) fail(`${LABELS[key]} · ${label} is required.`, where);
      if (v.length > max) fail(`${LABELS[key]} · ${label}: up to ${max} characters.`, where);
      if (v.split('\n').length > maxLines) fail(`${LABELS[key]} · ${label}: up to ${maxLines} lines.`, where);
      const unknown = [...v.matchAll(/\{([^{}\s]*)\}/g)].map((m) => m[1]).filter((p) => !PLACEHOLDERS[key].includes(p));
      if (unknown.length) {
        fail(`${LABELS[key]} · ${label}: {${unknown[0]}} isn't available here. Use ${PLACEHOLDERS[key].map((p) => `{${p}}`).join(', ')}.`, where);
      }
      out[key][field] = v;
    }
  }
  return out;
}

// Fills the placeholders. Lines that only held placeholders with no value are dropped; a space left
// before punctuation by an empty value is removed ("Assalamu Alaikum ," → "Assalamu Alaikum,").
function fill(text, values = {}) {
  const lines = String(text || '').split('\n').map((line) => {
    const hadPlaceholder = /\{[^{}\s]*\}/.test(line);
    const filled = line
      .replace(/\{([^{}\s]*)\}/g, (_, p) => (values[p] == null ? '' : String(values[p])))
      .replace(/ {2,}/g, ' ')
      .replace(/ +([,.;:!?])/g, '$1')
      .trim();
    if (hadPlaceholder && !/[\p{L}\p{N}]/u.test(filled)) return null; // nothing left but punctuation
    return filled;
  });
  return lines.filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The template's texts filled for one email → { subject, greeting, intro, closing }.
function apply(templates, key, values) {
  const t = (templates && templates[key]) || DEFAULTS[key];
  return {
    subject: fill(t.subject, values).replace(/\n/g, ' ').slice(0, 200),
    greeting: fill(t.greeting, values),
    intro: fill(t.intro, values),
    closing: fill(t.closing, values),
  };
}

module.exports = { KEYS, LABELS, PLACEHOLDERS, DEFAULTS, FIELDS, validate, fill, apply, copyDefaults };
