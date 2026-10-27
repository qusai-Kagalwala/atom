// FAQ bank: reading the FAQ JSON file and the rules shared by import and editing (pure, no DB).
const crypto = require('crypto');

const LANGS = ['en', 'ar', 'hi', 'gu'];
const MAX_STEPS = 15;
const MAX_TEXT = 600;

const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const cleanList = (list, max = MAX_STEPS) =>
  (Array.isArray(list) ? list : []).map(clean).filter(Boolean).slice(0, max).map((s) => s.slice(0, MAX_TEXT));

// Ticket category for an FAQ: by item first, then by FAQ category (agreed 27 Oct 2026).
const ITEM_CATEGORY = [
  [/printer|scanner|toner/i, 'Printer / Scanner'],
  [/monitor|lcd|led|projector|display|screen/i, 'Projector / Display'],
  [/speaker|headphone|mic/i, 'Audio / Mic / Speakers'],
  [/cctv/i, 'CCTV'],
  [/username|password/i, 'Email / Account'],
];
const FAQ_CATEGORY = {
  hardware: 'Computer / Laptop',
  software: 'Software',
  network: 'Network / Internet',
  telecommunication: 'Telephone / Intercom',
  'printer toner': 'Printer / Scanner',
};
function ticketCategoryName(category, item) {
  for (const [re, name] of ITEM_CATEGORY) if (re.test(item || '')) return name;
  return FAQ_CATEGORY[clean(category).toLowerCase()] || 'Other';
}

// { en: { question, steps[], raise_ticket } , … } — English is required, other languages optional.
function normaliseAnswers(answers) {
  const out = {};
  for (const lang of LANGS) {
    const a = answers?.[lang];
    if (!a) continue;
    const question = clean(a.question).slice(0, MAX_TEXT);
    if (!question) continue;
    out[lang] = { question, steps: cleanList(a.steps), raise_ticket: clean(a.raise_ticket).slice(0, MAX_TEXT) };
  }
  return out;
}

// One FAQ (from the file or the edit form) → the stored shape, or { error }.
function normaliseFaq(raw) {
  const category = clean(raw.category).slice(0, 60);
  const item = clean(raw.item).slice(0, 80);
  const subItem = clean(raw.sub_item ?? raw.subItem).slice(0, 120);
  if (!category || !item || !subItem) return { error: 'Category, item and sub-item are required.' };
  const answers = normaliseAnswers(raw.answers);
  if (!answers.en) return { error: 'The English question is required.' };
  const keywords = [...new Set(cleanList(raw.keywords, 30).map((k) => k.toLowerCase().slice(0, 80)))];
  return {
    category,
    item,
    subItem,
    keywords,
    directTicket: raw.direct_ticket === true || raw.directTicket === true,
    answers,
    detailsEn: cleanList(raw.diy_detailed_en ?? raw.detailsEn),
    ticketInfo: cleanList(raw.info_to_include_in_ticket ?? raw.ticketInfo, 10).map((s) => s.slice(0, 120)),
  };
}

const hashFaq = (f) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([f.category, f.item, f.subItem, f.keywords, f.directTicket, f.answers, f.detailsEn, f.ticketInfo]))
    .digest('hex');

// The whole file → { faqs: [{ itemId, ...faq, hash }], content, errors: [{ index, itemId, message }] }
function parseFaqFile(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    return { fatal: 'This is not a valid JSON file.' };
  }
  if (!data || !Array.isArray(data.faqs)) return { fatal: 'The file has no "faqs" list.' };

  const faqs = [];
  const errors = [];
  const seen = new Set();
  data.faqs.forEach((raw, index) => {
    const itemId = Number(raw?.item_id);
    if (!Number.isInteger(itemId) || itemId < 1 || itemId >= 100000) {
      errors.push({ index, itemId: raw?.item_id ?? null, message: 'item_id must be a whole number from 1 to 99999.' });
      return;
    }
    if (seen.has(itemId)) {
      errors.push({ index, itemId, message: 'Duplicate item_id.' });
      return;
    }
    seen.add(itemId);
    const f = normaliseFaq(raw || {});
    if (f.error) {
      errors.push({ index, itemId, message: f.error });
      return;
    }
    faqs.push({ itemId, ...f, hash: hashFaq(f) });
  });

  const languages = (Array.isArray(data.languages) ? data.languages : [])
    .filter((l) => LANGS.includes(l?.code))
    .map((l) => ({ code: l.code, name: clean(l.name), nativeName: clean(l.native_name) || clean(l.name), direction: l.direction === 'rtl' ? 'rtl' : 'ltr' }));
  const uiText = {};
  for (const [key, byLang] of Object.entries(data.ui_text || {})) {
    if (!/^[a-z_]{1,40}$/.test(key) || typeof byLang !== 'object' || !byLang) continue;
    uiText[key] = {};
    for (const lang of LANGS) if (byLang[lang]) uiText[key][lang] = clean(byLang[lang]).slice(0, 200);
  }
  const guidelines = {};
  for (const lang of LANGS) {
    const g = cleanList(data.general_guidelines?.[lang], 10);
    if (g.length) guidelines[lang] = g;
  }
  return { faqs, errors, content: { languages, uiText, guidelines } };
}

module.exports = { LANGS, clean, ticketCategoryName, normaliseFaq, hashFaq, parseFaqFile };
