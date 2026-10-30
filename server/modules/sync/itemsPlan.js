// Support Log Item_Master → what each company gets (companies step B, decided 28–30 Oct 2026). Pure.
//   Company_Id 1 → AVIT      problem list, items placed under AVIT's own ticket categories
//   Company_Id 2 → SIYANAAT  problem list, the Support Log categories (Electrical, Carpentry, …)
//   Company_Id 3 → TANZEEM   request catalogue: price, pack size (Qty_Multiples), stock (Qty × pack)
// Clean-up: spaces trimmed, first letter capitalised, "( 2)" → "(2)", "Other_X" → "Other",
// "Stationary" → "Stationery". Same Category > Item > Sub_Item twice in a company → the first
// (lowest Item_Id) is kept, the rest reported. Tag 1 = switched off (hidden), Tag 0 = active.
const crypto = require('crypto');
const { ticketCategoryName } = require('../assistant/faqData');

const COMPANY_BY_ID = { 1: 'AVIT', 2: 'SIYANAAT', 3: 'TANZEEM' };
const CODES = ['AVIT', 'SIYANAAT', 'TANZEEM'];
const SERVICE_GROUPS = new Set(['courier service', 'gate pass slip']); // Tanzeem: services, no stock
const CATEGORY_FIX = { stationary: 'Stationery' };
// Siyanaat categories created by the sync get these occupations (an Admin can change them).
const DEFAULT_OCCUPATION = {
  electrical: 'Electrician',
  carpentry: 'Carpenter',
  plumbing: 'Plumber',
  sanitation: 'Plumber',
  'air conditioning/refrigeration': 'AC Technician',
  mechanical: 'Mechanic',
  cleaning: 'Housekeeping',
  'pest control': 'Pest Control',
  colour: 'Painter',
};

const text = (v) => {
  if (v == null) return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.toUpperCase() === 'NULL' ? '' : s;
};
const nice = (v, max = 80) => {
  let s = text(v).replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  if (/^other_/i.test(s)) s = 'Other';
  if (s) s = s[0].toUpperCase() + s.slice(1);
  return s.slice(0, max);
};
const int = (v) => {
  const n = Number(text(v));
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const money = (v) => {
  const n = Number(text(v));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const hashOf = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');
const key = (...parts) => parts.map((p) => p.toLowerCase()).join(' > ');

function categoryName(raw) {
  const c = nice(raw, 60);
  return CATEGORY_FIX[c.toLowerCase()] || c;
}

// rows: Item_Master rows (any key spelling of the named columns). companies: codes to plan for.
// → { counts: { sourceRows, validRows, skippedRows }, companies: { CODE: { … } }, skipped: { reason: n } }
function buildItemsPlan(rows, { companies = CODES } = {}) {
  const wanted = new Set(companies);
  const skipped = { other_company: 0, not_selected: 0 };
  const per = {};
  for (const code of CODES) {
    if (wanted.has(code)) per[code] = { rows: 0, valid: 0, inactive: 0, duplicates: [], errors: [], entries: [] };
  }
  const get = (row, name) => row[name] ?? row[name.toLowerCase()];

  const sorted = [...rows].sort((a, b) => int(get(a, 'Item_Id')) - int(get(b, 'Item_Id')));
  const seen = new Map(); // code → Set(key)
  for (const row of sorted) {
    const code = COMPANY_BY_ID[int(get(row, 'Company_Id'))];
    if (!code) {
      skipped.other_company += 1;
      continue;
    }
    if (!per[code]) {
      skipped.not_selected += 1;
      continue;
    }
    const c = per[code];
    c.rows += 1;
    const legacyId = int(get(row, 'Item_Id'));
    const group = categoryName(get(row, 'Category'));
    const item = nice(get(row, 'Item'));
    const sub = nice(get(row, 'Sub_Item'));
    if (!legacyId || !group || !item) {
      c.errors.push({ legacyId: legacyId || null, message: 'Item_Id, Category and Item are required.' });
      continue;
    }
    const k = key(group, item, sub);
    if (!seen.has(code)) seen.set(code, new Set());
    if (seen.get(code).has(k)) {
      c.duplicates.push({ legacyId, name: [group, item, sub].filter(Boolean).join(' > ') });
      continue;
    }
    seen.get(code).add(k);
    const active = text(get(row, 'Tag')) !== '1' && get(row, 'Tag') !== true;
    if (!active) c.inactive += 1;
    c.valid += 1;

    if (code === 'TANZEEM') {
      const kind = SERVICE_GROUPS.has(group.toLowerCase()) ? 'service' : 'supply';
      const qty = Math.max(0, int(get(row, 'Qty')));
      const mult = int(get(row, 'Qty_Multiples'));
      const packSize = mult > 0 ? mult : 1;
      let name;
      if (item === 'Other') name = `Other (${group})`;
      else if (!sub || sub.toLowerCase() === item.toLowerCase()) name = item;
      else name = `${item} — ${sub}`;
      const e = {
        legacyId,
        group,
        name: name.slice(0, 120),
        kind,
        price: money(get(row, 'Price')),
        packSize,
        stock: kind === 'supply' ? qty * packSize : null,
        active,
      };
      e.hash = hashOf([e.group, e.name, e.kind, e.price, e.packSize, e.stock, e.active]);
      c.entries.push(e);
    } else {
      const category = code === 'AVIT' ? ticketCategoryName(group, item) : group;
      const e = { legacyId, sourceCategory: group, category, item, problem: sub || 'Other', active };
      e.hash = hashOf([e.category, e.item, e.problem, e.active]);
      c.entries.push(e);
    }
  }

  // Tanzeem: catalogue names must be unique among active items — add the legacy id when two clash.
  if (per.TANZEEM) {
    const used = new Set();
    for (const e of per.TANZEEM.entries) {
      if (!e.active) continue;
      const k = e.name.toLowerCase();
      if (used.has(k)) {
        e.name = `${e.name.slice(0, 110)} (#${e.legacyId})`;
        e.hash = hashOf([e.group, e.name, e.kind, e.price, e.packSize, e.stock, e.active]);
      }
      used.add(e.name.toLowerCase());
    }
  }

  const validRows = Object.values(per).reduce((n, c) => n + c.valid, 0);
  const skippedRows = Object.values(per).reduce((n, c) => n + c.duplicates.length + c.errors.length, 0) + skipped.other_company;
  return { counts: { sourceRows: rows.length, validRows, skippedRows }, companies: per, skipped };
}

// Per-company guard: 0 usable rows is always blocked; under 50% of the last good run for that
// company is blocked unless forced.
function checkCompanyGuard(code, valid, lastGood, force) {
  if (valid === 0) return { ok: false, reason: `${code}: Item_Master has no usable rows for this company. Old data kept.` };
  if (lastGood && valid < lastGood * 0.5 && !force) {
    return { ok: false, reason: `${code}: only ${valid} rows, under 50% of the last good run (${lastGood}). Old data kept. Run with force to accept.` };
  }
  return { ok: true };
}

module.exports = { buildItemsPlan, checkCompanyGuard, COMPANY_BY_ID, CODES, DEFAULT_OCCUPATION, nice, categoryName };
