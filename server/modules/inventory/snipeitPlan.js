// Pure mapping: Snipe-IT "custom assets report" CSV → what ATOM should contain (Phase 8).
// No database access here. Decided 26 Oct 2026 (ATOM_Decisions.md §18).
//   - Matched by Asset Tag (case-insensitive). Required columns: Asset Tag, Category, Status.
//   - Categories: duplicates merged and spelling fixed (CATEGORY_FIXES); anything else kept.
//   - Status: archived → Retired · pending/undeployable → In repair · checked out or "Deployed" →
//     In use · otherwise In store. Non-standard labels (a person's or table's name) are kept in notes.
//   - Checked out to a location → that place. Checked out to a user (the generic "Admin Marol"
//     account) → In use, holder unknown, flagged.
//   - Serials destroyed by Excel (1.23E+12) → left blank and flagged "serial needs checking".
//   - Rooms kept exactly as written; a letter after the room is the cubicle (1615-C).
const crypto = require('crypto');

const REQUIRED = ['Asset Tag', 'Category', 'Status'];

// lower-cased Snipe-IT category → ATOM category (merges + spelling fixes, approved 26 Oct 2026).
const CATEGORY_FIXES = {
  'keyboard-mouse combo': 'Keyboard Mouse Combo',
  'keyboard mouse combo': 'Keyboard Mouse Combo',
  'asti-shock microphone stand': 'Anti-Shock Microphone Stand',
  'loser measurement': 'Laser Measurement',
  'wireless tansmitter': 'Wireless Transmitter',
  'classic power conditionec': 'Power Conditioner',
  'tv torlley': 'TV Trolley',
  'audio i/o box': 'Audio I/O Box',
  'network adapter': 'Network Adapter',
  'usb to lan cable': 'USB to LAN Cable',
  'vc unit': 'VC Unit',
  'pencil for ipad': 'Pencil for iPad',
  'aten usb 3.0 peripheral sharing device': 'USB Peripheral Sharing Device',
  'optoma 4k document camera': 'Document Camera',
};

// Spelling fixes in place names (the Snipe-IT text is still what re-imports match on).
const PLACE_FIXES = [[/\bconfrence\b/gi, 'Conference']];

const STANDARD_STATUS = new Set(['ready to deploy', 'deployed', 'archived', 'pending']);
const SCI_SERIAL = /^\d+(\.\d+)?E\+?\d+$/i;

const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
};
const keyOf = (v) => (clean(v) || '').toLowerCase();

function mapCategory(raw) {
  const name = clean(raw);
  if (!name) return null;
  const fixed = CATEGORY_FIXES[name.toLowerCase()];
  return { snipeName: name, name: fixed || name, changed: Boolean(fixed) && fixed !== name };
}

// "Deployed (deployed)" + checked out? → { status, label, note }
function mapStatus(raw, checkedOut) {
  const text = clean(raw) || '';
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(text);
  const label = (m ? m[1] : text).trim();
  const meta = (m ? m[2] : '').trim().toLowerCase();
  const l = label.toLowerCase();
  let status;
  if (meta === 'archived' || l === 'archived') status = 'RETIRED';
  else if (l === 'pending' || meta === 'pending' || meta === 'undeployable') status = 'IN_REPAIR';
  else if (checkedOut || l === 'deployed' || meta === 'deployed') status = 'IN_USE';
  else status = 'IN_STORE';
  const note = label && !STANDARD_STATUS.has(l) ? `Snipe-IT status: ${label}` : null;
  return { status, label, note };
}

const ORDINAL_FLOOR = /\b(\d{1,2})(?:st|nd|rd|th)\s+floor\b/i;

// Location text → place. Rooms as written; building / floor only when the text says so.
function parsePlace(raw) {
  const original = clean(raw);
  if (!original) return null;
  let name = original;
  for (const [re, to] of PLACE_FIXES) name = name.replace(re, to);

  let roomNo = null;
  let cubicle = null;
  let m;
  if ((m = /^(\d{4})-([A-Za-z0-9]{1,4})$/.exec(name))) [, roomNo, cubicle] = m;
  else if ((m = /^(\d{4})$/.exec(name))) [, roomNo] = m;
  else if ((m = /\broom\s*no\.?\s*(\d{4})\b/i.exec(name))) [, roomNo] = m;
  else if ((m = /\((\d{4})\)/.exec(name))) [, roomNo] = m;
  else if ((m = /^(\d{4})\s+\S/.exec(name))) [, roomNo] = m;
  else if ((m = /\b(\d{4})$/.exec(name))) [, roomNo] = m;
  if (cubicle) cubicle = cubicle.toUpperCase();

  let building = null;
  if (/\bmaskan\b|\bmasakin\b/i.test(name)) building = 'Maskan';
  else if (/\brabvat\b/i.test(name)) building = 'Rabvat';
  else if (/\bmahad\s+al\s+zahra\b/i.test(name)) building = 'Mahad Al Zahra';
  else if (/\bnajmi\b/i.test(name)) building = 'Najmi Building';

  const f = ORDINAL_FLOOR.exec(name);
  const floor = f ? `${Number(f[1])}${['th', 'st', 'nd', 'rd'][(Number(f[1]) % 100 > 10 && Number(f[1]) % 100 < 14) || Number(f[1]) % 10 > 3 ? 0 : Number(f[1]) % 10]}` : null;

  return { key: original.toLowerCase(), snipeName: original, name, roomNo, cubicle, building, floor };
}

// "05-11-2022 00:00" (DD-MM-YYYY) or "2022-11-05" → "2022-11-05"; null when empty; undefined when bad.
function parseDate(raw) {
  const s = clean(raw);
  if (!s) return null;
  let y;
  let mo;
  let d;
  let m;
  if ((m = /^(\d{2})-(\d{2})-(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s))) [, d, mo, y] = m;
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(s))) [, y, mo, d] = m;
  else return undefined;
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d) return undefined;
  return `${y}-${mo}-${d}`;
}

// What decides "unchanged" on a re-import.
function fingerprint(a) {
  const fields = [a.name, a.categorySnipeName, a.manufacturer, a.model, a.modelNo, a.serial, a.serialNeedsCheck,
    a.macAddress, a.ipAddress, a.purchasedOn, a.orderNumber, a.supplier, a.status, a.placeKey, a.holderUnknown, a.notes,
    a.snipeitId];
  return crypto.createHash('sha1').update(JSON.stringify(fields)).digest('hex');
}

// { headers, records, rowNumbers } (utils/csv parseCsv) → plan
function buildSnipeitPlan({ headers, records, rowNumbers }) {
  const missing = REQUIRED.filter((h) => !headers.includes(h));
  if (missing.length) {
    return { fatal: `This doesn't look like a Snipe-IT assets export: missing column(s) ${missing.join(', ')}.` };
  }

  const assets = [];
  const errors = [];
  const warnings = [];
  const places = new Map();
  const categories = new Map(); // ATOM name → Set(snipe names)
  const categoryChanges = new Map(); // "from → to" → count
  const seenTags = new Map();
  const serials = new Map();

  records.forEach((r, i) => {
    const row = rowNumbers[i];
    const tag = clean(r['Asset Tag']);
    if (!tag) return errors.push({ row, tag: '(blank)', reason: 'Asset Tag is empty.' });
    if (tag.length > 60) return errors.push({ row, tag, reason: 'Asset Tag is longer than 60 characters.' });
    const tagKey = tag.toUpperCase();
    if (seenTags.has(tagKey)) return errors.push({ row, tag, reason: `Duplicate Asset Tag (also on row ${seenTags.get(tagKey)}).` });
    seenTags.set(tagKey, row);

    const cat = mapCategory(r.Category);
    if (!cat) return errors.push({ row, tag, reason: 'Category is empty.' });
    if (!categories.has(cat.name)) categories.set(cat.name, new Set());
    categories.get(cat.name).add(cat.snipeName);
    if (cat.changed) {
      const k = `${cat.snipeName} → ${cat.name}`;
      categoryChanges.set(k, (categoryChanges.get(k) || 0) + 1);
    }

    const checkoutType = keyOf(r.Type);
    const checkedOutTo = clean(r['Checked Out']);
    const st = mapStatus(r.Status, Boolean(checkoutType && checkedOutTo));
    if (!clean(r.Status)) return errors.push({ row, tag, reason: 'Status is empty.' });

    // Where it is: the checkout location, else the current location, else the default location.
    const where = (checkoutType === 'location' && checkedOutTo) || clean(r.Location) || clean(r['Default Location']);
    const place = parsePlace(where);
    if (place && !places.has(place.key)) places.set(place.key, place);

    const notes = [clean(r.Notes) ? String(r.Notes).trim() : null, st.note];
    let holderUnknown = false;
    if (checkoutType === 'user' && st.status !== 'RETIRED') {
      holderUnknown = true;
      notes.push(`Checked out in Snipe-IT to "${checkedOutTo || 'a user'}" — assign the real person.`);
    }

    let serial = clean(r.Serial);
    let serialNeedsCheck = false;
    if (serial && SCI_SERIAL.test(serial)) {
      serial = null;
      serialNeedsCheck = true;
    }
    if (serial) {
      const sk = serial.toUpperCase();
      if (serials.has(sk)) warnings.push({ row, tag, reason: `Same serial as ${serials.get(sk)}.` });
      else serials.set(sk, tag);
    }

    const purchasedOn = parseDate(r.Purchased);
    if (purchasedOn === undefined) warnings.push({ row, tag, reason: `Purchase date "${clean(r.Purchased)}" not understood — left empty.` });

    const snipeitId = /^\d{1,9}$/.test(clean(r.ID) || '') ? Number(clean(r.ID)) : null;

    const asset = {
      row,
      tag,
      name: clean(r['Asset Name']),
      categoryName: cat.name,
      categorySnipeName: cat.snipeName,
      manufacturer: clean(r.Manufacturer),
      model: clean(r.Model),
      modelNo: clean(r['Model No.']),
      serial,
      serialNeedsCheck,
      macAddress: clean(r['MAC Address']),
      ipAddress: clean(r['IP Address']),
      purchasedOn: purchasedOn || null,
      orderNumber: clean(r['Order Number']),
      supplier: clean(r.Supplier),
      status: st.status,
      placeKey: place ? place.key : null,
      holderUnknown,
      notes: notes.filter(Boolean).join('\n') || null,
      snipeitId,
    };
    asset.hash = fingerprint(asset);
    assets.push(asset);
    return undefined;
  });

  return {
    assets,
    errors,
    warnings,
    places: [...places.values()],
    categories: [...categories.entries()].map(([name, snipe]) => ({ name, snipeNames: [...snipe] })),
    categoryChanges: [...categoryChanges.entries()].map(([change, count]) => ({ change, count })),
    counts: {
      rows: records.length,
      valid: assets.length,
      serialNeedsCheck: assets.filter((a) => a.serialNeedsCheck).length,
      holderUnknown: assets.filter((a) => a.holderUnknown).length,
      byStatus: assets.reduce((m, a) => ({ ...m, [a.status]: (m[a.status] || 0) + 1 }), {}),
    },
  };
}

module.exports = { buildSnipeitPlan, mapCategory, mapStatus, parsePlace, parseDate, fingerprint, CATEGORY_FIXES, REQUIRED };
