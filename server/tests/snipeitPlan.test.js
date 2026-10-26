// Phase 8: CSV reader + Snipe-IT mapping rules (pure, no DB).
const { parseCsv, parseRows } = require('../utils/csv');
const { mapCategory, mapStatus, parsePlace, parseDate } = require('../modules/inventory/snipeitPlan');

describe('CSV reader', () => {
  test('quotes, doubled quotes, commas and line breaks inside quotes, CRLF, BOM', () => {
    const text = '﻿a,b,c\r\n"x, y","he said ""hi""","line1\nline2"\r\n1,,3';
    expect(parseRows(text)).toEqual([['a', 'b', 'c'], ['x, y', 'he said "hi"', 'line1\nline2'], ['1', '', '3']]);
  });

  test('values stay text (serials and phone numbers are never turned into numbers)', () => {
    const { records } = parseCsv('Serial,Mobile\n000123,919820000001\n9.18E+11,');
    expect(records).toEqual([{ Serial: '000123', Mobile: '919820000001' }, { Serial: '9.18E+11', Mobile: '' }]);
  });

  test('duplicate headers get .1 / .2 like the Snipe-IT export; row numbers count the header', () => {
    const r = parseCsv('Address,City,Address,Address\n1,2,3,4\n\n5,6,7,8\n');
    expect(r.headers).toEqual(['Address', 'City', 'Address.1', 'Address.2']);
    expect(r.rowNumbers).toEqual([2, 3]); // the blank line is dropped
  });

  test('an unclosed quote is an error', () => {
    expect(() => parseRows('a\n"oops')).toThrow(/unclosed quote/);
  });
});

describe('Snipe-IT mapping', () => {
  test('categories: duplicates merged, spellings fixed, others kept', () => {
    expect(mapCategory('Keyboard-Mouse Combo')).toMatchObject({ name: 'Keyboard Mouse Combo', changed: true });
    expect(mapCategory('TV  TORLLEY')).toMatchObject({ name: 'TV Trolley', changed: true });
    expect(mapCategory('Solid State Drive ')).toMatchObject({ name: 'Solid State Drive', changed: false });
    expect(mapCategory('Decoder')).toMatchObject({ name: 'Decoder', changed: false });
    expect(mapCategory('  ')).toBeNull();
  });

  test('status rules', () => {
    expect(mapStatus('Ready to Deploy (deployable)', false)).toMatchObject({ status: 'IN_STORE', note: null });
    expect(mapStatus('Ready to Deploy (deployed)', true)).toMatchObject({ status: 'IN_USE' });
    expect(mapStatus('Deployed (deployable)', false)).toMatchObject({ status: 'IN_USE' });
    expect(mapStatus('Archived (archived)', true)).toMatchObject({ status: 'RETIRED' });
    expect(mapStatus('Pending (deployed)', true)).toMatchObject({ status: 'IN_REPAIR' });
    expect(mapStatus('Mustafa bs Badri (deployable)', false)).toMatchObject({ status: 'IN_STORE', note: 'Snipe-IT status: Mustafa bs Badri' });
  });

  test('places: rooms as written, cubicle letters, building/floor only when the text says so', () => {
    expect(parsePlace('1615-c')).toMatchObject({ roomNo: '1615', cubicle: 'C', building: null });
    expect(parsePlace('ROOM NO. 1406')).toMatchObject({ roomNo: '1406' });
    expect(parsePlace('PRINTER ROOM (1002)')).toMatchObject({ roomNo: '1002' });
    expect(parsePlace('Rabvat 11th Floor 3111')).toMatchObject({ roomNo: '3111', building: 'Rabvat', floor: '11th' });
    expect(parsePlace('Maskan 2nd Floor 2021')).toMatchObject({ floor: '2nd', building: 'Maskan' });
    expect(parsePlace('Maskan 3rd Floor 2031')).toMatchObject({ floor: '3rd' });
    expect(parsePlace('IT Store Room')).toMatchObject({ roomNo: null, building: null, floor: null });
    expect(parsePlace('FQ-Confrence Room')).toMatchObject({ name: 'FQ-Conference Room', snipeName: 'FQ-Confrence Room' });
    expect(parsePlace('')).toBeNull();
  });

  test('dates: DD-MM-YYYY (Snipe-IT) or YYYY-MM-DD; impossible dates rejected', () => {
    expect(parseDate('05-11-2022 00:00')).toBe('2022-11-05');
    expect(parseDate('2023-02-02')).toBe('2023-02-02');
    expect(parseDate('')).toBeNull();
    expect(parseDate('31-02-2023 00:00')).toBeUndefined();
    expect(parseDate('Nov 5 2022')).toBeUndefined();
  });
});
