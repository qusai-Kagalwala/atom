// Local FAQ matching for typed problems (pure, no DB, no tokens spent).
// Scores each FAQ on: keyword phrases, the item (with a few aliases), the sub-item words, keyword
// words, and the question in the user's language. Small typos are forgiven (edit distance).
//   → { kind: 'answer', faqId, hits } | { kind: 'choices', hits } | { kind: 'none', hits }
const STOP = new Set(
  ('a an the my mine is are was were be been am it its i me we our you your to of in on at for and or but so with ' +
    'what whats should do does did how please pls plz help problem issue issues have has had this that there here ' +
    'can could would will get got any some very also just still other others sir madam hi hello dear').split(' ')
);

// The JSON's item names are short or oddly written ("C.p.u", "Monitor / LCD/ LED"); these add the
// words people actually type.
const ITEM_ALIASES = {
  'c.p.u': ['cpu', 'computer', 'pc', 'desktop', 'system'],
  'monitor / lcd/ led': ['monitor', 'lcd', 'led', 'screen', 'display'],
  lan: ['lan', 'network', 'internet', 'ethernet'],
  officestation: ['officestation', 'thin', 'client', 'terminal'],
  mic: ['mic', 'microphone', 'mike'],
  headphones: ['headphone', 'headset', 'earphone'],
  intercom: ['intercom', 'phone', 'telephone', 'extension'],
  handset: ['handset', 'phone', 'receiver'],
  ups: ['ups', 'inverter'],
  'pen drive': ['pen', 'pendrive', 'flash'],
  'usb port': ['usb', 'port'],
  'anti virus': ['antivirus', 'anti', 'virus'],
  'google chrome': ['chrome', 'google'],
  'acrobat pdf maker': ['acrobat', 'pdf', 'maker'],
  acrobat: ['acrobat', 'adobe', 'pdf', 'reader'],
  'ms power point': ['powerpoint', 'power', 'point', 'ppt'],
  'ms word': ['word', 'msword'],
  'ms excel': ['excel'],
  'ms access': ['access'],
  'ms visio': ['visio'],
  'support log app.': ['support', 'log'],
  'idarah application': ['idarah'],
  'malaf application': ['malaf'],
  'rf scanner': ['rf', 'handheld'],
  'barcode scanner': ['barcode'],
};

// Lower case, no apostrophes, words only (any script), plural "s" dropped on longer Latin words.
function words(text) {
  const s = String(text || '').normalize('NFKC').toLowerCase().replace(/['’`]/g, '');
  return (s.match(/[\p{L}\p{N}]+/gu) || []).map(stem);
}
// Light English stemming, same on both sides: printers→printer, crashing→crash, printed→print.
function stem(w) {
  if (!/^[a-z]+$/.test(w)) return w;
  // jammed → jamm → jam, running → runn → run (not "ll"/"ss": install, press).
  const undouble = (x) => (/([b-df-hj-kmnp-rtv-z])\1$/.test(x) && !/(ll|ss|zz)$/.test(x) ? x.slice(0, -1) : x);
  if (w.length > 5 && w.endsWith('ing')) return undouble(w.slice(0, -3));
  if (w.length > 5 && w.endsWith('ed')) return undouble(w.slice(0, -2));
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
const content = (text) => words(text).filter((w) => !STOP.has(w));

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}
// 1 = same word, ~0.85 = one typo in a 7-letter word, 0 = different. Short words must match exactly.
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 4 || b.length < 4) return 0;
  const d = editDistance(a, b);
  return d > 2 ? 0 : 1 - d / Math.max(a.length, b.length);
}
const bestSim = (word, vocab) => {
  let best = 0;
  for (const v of vocab) {
    const s = similarity(word, v);
    if (s > best) best = s;
    if (best === 1) break;
  }
  return best;
};
// Whole-word sequence check: is `needle` (array) inside `hay` (array)?
function containsSeq(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  outer: for (let i = 0; i <= hay.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

// faqs: [{ id, item, subItem, keywords[], questions: { en, ar, … } }]
function buildIndex(faqs) {
  const entries = faqs
    .filter((f) => !/^other$/i.test(String(f.subItem).trim())) // the "Other" catch-alls are for browsing only
    .map((f) => {
      const itemKey = String(f.item).trim().toLowerCase();
      const itemWords = [...new Set([...content(f.item), ...words((ITEM_ALIASES[itemKey] || []).join(' '))])].filter((w) => w.length > 1);
      const phrases = (f.keywords || []).map(content).filter((p) => p.length);
      return {
        id: String(f.id),
        item: f.item,
        itemWords,
        subWords: [...new Set(content(f.subItem))],
        phrases,
        keywordWords: [...new Set(phrases.flat())],
        questionWords: Object.fromEntries(Object.entries(f.questions || {}).map(([lang, q]) => [lang, new Set(content(q))])),
      };
    });
  // Rarity of each question word per language, so "मेरा" / "my" count for nothing and "माउस" a lot.
  const df = {};
  for (const e of entries) {
    for (const [lang, set] of Object.entries(e.questionWords)) {
      df[lang] = df[lang] || new Map();
      for (const w of set) df[lang].set(w, (df[lang].get(w) || 0) + 1);
    }
  }
  const n = Math.max(entries.length, 1);
  const idf = Object.fromEntries(Object.entries(df).map(([lang, m]) => [lang, new Map([...m].map(([w, c]) => [w, Math.log(n / c)]))]));
  for (const e of entries) e.idf = idf;
  return entries;
}

const ANSWER_MIN = 7;
const ANSWER_GAP = 2.5;
const CHOICE_MIN = 3;
const MAX_CHOICES = 6;
const MAX_ITEM_CHOICES = 12;

function scoreFaq(e, q, lang) {
  let score = 0;
  for (const p of e.phrases) {
    if (!containsSeq(q, p)) continue;
    score += 2 + p.length;
    // The whole question is a keyword (e.g. an FAQ made from a typed question): a clear match.
    if (p.length === q.length) score += 4;
  }

  let item = 0;
  for (const w of q) item = Math.max(item, bestSim(w, e.itemWords));
  if (item >= 0.8) score += 4 * item;

  if (e.subWords.length) {
    let hit = 0;
    for (const s of e.subWords) if (q.some((w) => similarity(w, s) >= 0.8)) hit += 1;
    score += (2 * hit) / e.subWords.length;
  }

  let kw = 0;
  for (const w of q) if (bestSim(w, e.keywordWords) >= 0.8) kw += 0.5;
  score += Math.min(kw, 2);

  const ql = e.questionWords[lang] ? lang : 'en';
  const qw = e.questionWords[ql];
  if (qw) {
    let overlap = 0;
    for (const w of q) if (qw.has(w)) overlap += e.idf[ql]?.get(w) || 0;
    score += Math.min(overlap * (ql === 'en' ? 0.25 : 0.6), ql === 'en' ? 2 : 6);
  }
  return Math.round(score * 100) / 100;
}

function match(index, text, lang = 'en') {
  const q = content(text).slice(0, 40);
  const byId = new Map(index.map((e) => [e.id, e]));
  if (!q.length) return { kind: 'none', hits: [] };
  const hits = index
    .map((e) => ({ faqId: e.id, score: scoreFaq(e, q, lang) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || String(a.faqId).localeCompare(String(b.faqId), 'en', { numeric: true }));
  const top = hits[0];
  if (!top || top.score < CHOICE_MIN) return { kind: 'none', hits: hits.slice(0, 5) };
  const second = hits[1]?.score ?? 0;
  if (top.score >= ANSWER_MIN && top.score - second >= ANSWER_GAP) return { kind: 'answer', faqId: top.faqId, hits: hits.slice(0, 5) };
  let choices = hits.filter((h) => h.score >= Math.max(CHOICE_MIN, top.score * 0.6));
  // Only the item is clear ("printer"): offer all of that item's FAQs.
  const items = new Set(choices.map((h) => byId.get(h.faqId).item));
  if (items.size === 1) {
    const item = [...items][0];
    const rest = index.filter((e) => e.item === item && !choices.some((h) => h.faqId === e.id)).map((e) => ({ faqId: e.id, score: 0 }));
    choices = [...choices, ...rest].slice(0, MAX_ITEM_CHOICES);
  } else {
    choices = choices.slice(0, MAX_CHOICES);
  }
  return { kind: 'choices', hits: choices };
}

// Saved GPT answers (Phase 12 update): a question's key = its important words, unique, sorted.
// "hall printer not working" and "printer not working in hall" → "hall not printer work".
function matchKey(text) {
  return [...new Set(content(text))].sort().join(' ').slice(0, 300);
}

// How alike two keys are (0–1): shared words / all words, a small typo counts as shared.
function keySimilarity(a, b) {
  const x = a ? a.split(' ') : [];
  const y = b ? b.split(' ') : [];
  if (!x.length || !y.length) return 0;
  let shared = 0;
  const used = new Set();
  for (const w of x) {
    const i = y.findIndex((v, k) => !used.has(k) && similarity(w, v) >= 0.85);
    if (i >= 0) {
      used.add(i);
      shared += 1;
    }
  }
  return shared / (x.length + y.length - shared);
}

module.exports = { buildIndex, match, words, content, similarity, matchKey, keySimilarity, ANSWER_MIN, CHOICE_MIN };
