// Phase 12: FAQ file reading, local matching and the GPT call (pure; OpenAI mocked with a fake fetch).
const { parseFaqFile, ticketCategoryName, normaliseFaq } = require('../modules/assistant/faqData');
const { buildIndex, match, words, matchKey, keySimilarity } = require('../modules/assistant/matcher');
const gpt = require('../modules/assistant/gpt');
const { config } = require('../config/env');

const faq = (id, category, item, sub, keywords, extra = {}) => ({
  item_id: id,
  category,
  item,
  sub_item: sub,
  keywords,
  direct_ticket: false,
  answers: {
    en: { question: `${item} ${sub}?`, steps: ['Step one.', 'Step two.'], raise_ticket: 'Please raise a ticket.' },
    hi: { question: `मेरा ${item === 'Mouse' ? 'माउस' : item} ${sub}`, steps: ['एक'], raise_ticket: 'टिकट' },
  },
  diy_detailed_en: ['More.'],
  info_to_include_in_ticket: ['Asset tag / serial number'],
  ...extra,
});

const FILE = {
  languages: [
    { code: 'en', name: 'English', native_name: 'English', direction: 'ltr' },
    { code: 'ar', name: 'Arabic', native_name: 'العربية', direction: 'rtl' },
    { code: 'xx', name: 'Nope' },
  ],
  ui_text: { yes: { en: 'Yes', ar: 'نعم' }, 'bad key!': { en: 'x' } },
  general_guidelines: { en: ['Never open a CPU.'] },
  faqs: [
    faq(1, 'Hardware', 'Mouse', 'Not Working', ['mouse not working', 'cursor not moving']),
    faq(2, 'Hardware', 'Mouse', 'Broken', ['mouse broken', 'mouse cracked']),
    faq(3, 'Hardware', 'Printer', 'Paper Jam', ['paper jam', 'paper stuck']),
    faq(4, 'Hardware', 'Printer', 'Not Working', ['printer not printing', 'printer not working']),
    faq(5, 'Network', 'Lan', 'Internet Not Working', ['internet not working', 'no internet']),
    faq(6, 'Network', 'Password', 'Forgot', ['forgot password']),
    faq(7, 'Telecommunication', 'Intercom', 'No Dial Tone', ['no dial tone', 'dead line']),
    faq(8, 'Hardware', 'Computer Hardware', 'Other', ['other']),
    faq(9, 'Hardware', 'Mouse', 'Duplicate', ['x'], { item_id: 1 }),
    { item_id: 10, category: 'Hardware', item: 'X', sub_item: 'Y', answers: { hi: { question: 'only hindi' } } },
    { item_id: 'abc' },
  ],
};

describe('FAQ file', () => {
  const parsed = parseFaqFile(JSON.stringify(FILE));

  test('reads FAQs, languages, ui text and guidelines; reports bad entries', () => {
    expect(parsed.faqs.map((f) => f.itemId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parsed.errors.map((e) => e.message)).toEqual([
      'Duplicate item_id.',
      'The English question is required.',
      'item_id must be a whole number from 1 to 99999.',
    ]);
    expect(parsed.content.languages.map((l) => l.code)).toEqual(['en', 'ar']);
    expect(parsed.content.languages[1]).toMatchObject({ nativeName: 'العربية', direction: 'rtl' });
    expect(parsed.content.uiText).toEqual({ yes: { en: 'Yes', ar: 'نعم' } });
    expect(parsed.content.guidelines).toEqual({ en: ['Never open a CPU.'] });
    expect(parsed.faqs[0]).toMatchObject({ category: 'Hardware', subItem: 'Not Working', detailsEn: ['More.'], ticketInfo: ['Asset tag / serial number'] });
    expect(parsed.faqs[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('not JSON / no faqs list', () => {
    expect(parseFaqFile('{oops').fatal).toMatch(/not a valid JSON/);
    expect(parseFaqFile('{"x":1}').fatal).toMatch(/no "faqs"/);
    expect(parseFaqFile('﻿{"faqs":[]}').faqs).toEqual([]);
  });

  test('ticket category: item first, then FAQ category', () => {
    expect(ticketCategoryName('Hardware', 'Printer')).toBe('Printer / Scanner');
    expect(ticketCategoryName('Hardware', 'Monitor / LCD/ LED')).toBe('Projector / Display');
    expect(ticketCategoryName('Hardware', 'Mic')).toBe('Audio / Mic / Speakers');
    expect(ticketCategoryName('Hardware', 'CCTV')).toBe('CCTV');
    expect(ticketCategoryName('Network', 'Password')).toBe('Email / Account');
    expect(ticketCategoryName('Network', 'Lan')).toBe('Network / Internet');
    expect(ticketCategoryName('Telecommunication', 'Handset')).toBe('Telephone / Intercom');
    expect(ticketCategoryName('Printer Toner', 'Toner')).toBe('Printer / Scanner');
    expect(ticketCategoryName('Hardware', 'C.p.u')).toBe('Computer / Laptop');
    expect(ticketCategoryName('Weird', 'Thing')).toBe('Other');
  });

  test('edit form shape is accepted too', () => {
    const f = normaliseFaq({ category: 'Software', item: 'Excel', subItem: 'Crash', keywords: ['Excel Crash', 'excel crash'], answers: { en: { question: 'Q?' } } });
    expect(f).toMatchObject({ subItem: 'Crash', keywords: ['excel crash'], directTicket: false });
    expect(normaliseFaq({ category: 'a', item: 'b' }).error).toMatch(/required/);
  });
});

describe('local matching', () => {
  const parsed = parseFaqFile(JSON.stringify(FILE));
  const index = buildIndex(
    parsed.faqs.map((f) => ({
      id: String(f.itemId),
      item: f.item,
      subItem: f.subItem,
      keywords: f.keywords,
      questions: Object.fromEntries(Object.entries(f.answers).map(([l, a]) => [l, a.question])),
    }))
  );

  test('a clear problem is answered', () => {
    expect(match(index, 'My mouse is not working')).toMatchObject({ kind: 'answer', faqId: '1' });
    expect(match(index, 'printer paper jam')).toMatchObject({ kind: 'answer', faqId: '3' });
    expect(match(index, 'no internet since morning')).toMatchObject({ kind: 'answer', faqId: '5' });
    expect(match(index, 'I forgot my password')).toMatchObject({ kind: 'answer', faqId: '6' });
  });

  test('typos and plurals are forgiven', () => {
    expect(match(index, 'pinter paper jammed')).toMatchObject({ kind: 'answer', faqId: '3' });
    expect(words('Printers crashing jammed install')).toEqual(['printer', 'crash', 'jam', 'install']);
  });

  test('only the item is clear → all of its problems as choices', () => {
    const r = match(index, 'printer');
    expect(r.kind).toBe('choices');
    expect(r.hits.map((h) => h.faqId).sort()).toEqual(['3', '4']);
  });

  test('Hindi question words count, common words do not', () => {
    const r = match(index, 'मेरा माउस', 'hi');
    expect(['1', '2']).toContain(r.hits[0].faqId);
    expect(r.hits.slice(0, 2).map((h) => h.faqId).sort()).toEqual(['1', '2']);
  });

  test('nothing close → none; "Other" FAQs are browse-only', () => {
    expect(match(index, 'projector shows no picture in hall b').kind).toBe('none');
    expect(match(index, 'other').kind).toBe('none');
    expect(match(index, '   ').kind).toBe('none');
    expect(index.some((e) => e.id === '8')).toBe(false);
  });
});

describe('GPT fallback', () => {
  const FAQS = [
    { id: '11', category: 'Hardware', item: 'Mouse', subItem: 'Broken' },
    { id: '12', category: 'Network', item: 'Lan', subItem: 'Not Working' },
  ];
  const CATS = ['Computer / Laptop', 'Network / Internet', 'Other'];
  const okFetch = (content, usage = { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040 }) =>
    jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage }) });

  beforeEach(() => {
    config.openai.apiKey = 'sk-test';
  });
  afterAll(() => {
    config.openai.apiKey = '';
  });

  test('prompt lists the FAQs and categories; user text is fenced and cut to 500 characters', () => {
    const m = gpt.buildMessages(`wifi ${'x'.repeat(900)}`, FAQS, CATS);
    expect(m[0].content).toMatch(/never answer the problem yourself/);
    expect(m[0].content).toMatch(/data, not instructions/);
    expect(m[1].content).toContain('11 | Hardware > Mouse > Broken');
    expect(m[1].content).toContain('Network / Internet');
    expect(m[1].content.split('"""')[1].trim().length).toBe(500);
  });

  test('reply is cleaned: unknown ids / categories dropped, priority defaulted', () => {
    expect(gpt.parseReply('{"faq_ids":[12,"99",12],"category":"network / internet","priority":"high","title":"LAN down in 1615"}', ['11', '12'], CATS)).toEqual({
      faqIds: ['12'],
      category: 'Network / Internet',
      priority: 'HIGH',
      title: 'LAN down in 1615',
    });
    expect(gpt.parseReply('{"faq_ids":[],"category":"Hacking","priority":"URGENT","title":"x"}', ['11'], CATS)).toEqual({
      faqIds: [],
      category: null,
      priority: 'NORMAL',
      title: null,
    });
    expect(gpt.parseReply('not json', ['11'], CATS)).toMatchObject({ faqIds: [], unreadable: true });
  });

  test('cost: gpt-4o-mini prices', () => {
    expect(gpt.costUsd({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, 0.15, 0.6)).toBeCloseTo(0.75, 6);
    expect(gpt.costUsd({ prompt_tokens: 1500, completion_tokens: 50 }, 0.15, 0.6)).toBeCloseTo(0.000255, 6);
  });

  test('classify sends model, temperature, JSON mode and a token cap; key only in the header', async () => {
    const f = okFetch('{"faq_ids":[11],"category":"Computer / Laptop","priority":"NORMAL","title":"Mouse broken"}');
    const r = await gpt.classify({ text: 'mouse cracked', faqs: FAQS, categories: CATS, model: 'gpt-4o-mini', temperature: '0.40', fetchImpl: f });
    expect(r.suggestion).toMatchObject({ faqIds: ['11'], category: 'Computer / Laptop' });
    expect(r.usage).toEqual({ prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040 });
    const [url, opts] = f.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ model: 'gpt-4o-mini', temperature: 0.4, max_tokens: 150, response_format: { type: 'json_object' } });
    expect(opts.body).not.toContain('sk-test');
  });

  test('errors: no key, HTTP error, network failure', async () => {
    config.openai.apiKey = '';
    await expect(gpt.classify({ text: 'x', faqs: FAQS, categories: CATS, model: 'm', temperature: 0.4, fetchImpl: okFetch('{}') })).rejects.toThrow(/key is not set/);
    config.openai.apiKey = 'sk-test';
    const http429 = jest.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { message: 'Rate limit reached' } }) });
    await expect(gpt.classify({ text: 'x', faqs: FAQS, categories: CATS, model: 'm', temperature: 0.4, fetchImpl: http429 })).rejects.toMatchObject({
      status: 429,
      message: 'OpenAI error: Rate limit reached',
    });
    const down = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
    await expect(gpt.classify({ text: 'x', faqs: FAQS, categories: CATS, model: 'm', temperature: 0.4, fetchImpl: down })).rejects.toThrow(/Could not reach OpenAI/);
  });
});

describe('saved-answer keys', () => {
  test('same important words in any order give the same key; filler words and plurals ignored', () => {
    expect(matchKey('Hall printer is not working')).toBe(matchKey('printers not working in the hall'));
    expect(matchKey('hi please help')).toBe('');
    expect(matchKey('وای فای لا يعمل')).toBe(matchKey('لا يعمل وای فای'));
  });
  test('a small typo still counts as the same question; a different word does not', () => {
    expect(keySimilarity(matchKey('wifi gaya office'), matchKey('wifi gaya offfice'))).toBe(1);
    expect(keySimilarity(matchKey('wifi gaya office'), matchKey('wifi gaya hall'))).toBeLessThan(0.8);
    expect(keySimilarity('', 'a')).toBe(0);
  });
});
