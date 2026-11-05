// Jamea Internet Access (Wi-Fi passes): CSV reading and the eJamaat details mapping. No database, eJamaat SOAP mocked.
jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../services/ejamaatSoap', () => ({ callOperation: jest.fn() }));

const soap = require('../services/ejamaatSoap');
const { getMuminDetails } = require('../services/ejamaatClient');
const { readPassesCsv, parseCsvText, recipientUntil, passMessage, passEmail } = require('../modules/wifi/wifi.service');

describe('CSV', () => {
  test('a word before the column name is fine (Cisco ISE exports)', () => {
    expect(readPassesCsv(Buffer.from('Account Username,Account Password\nu1,p1\n')).rows).toEqual([{ username: 'u1', password: 'p1' }]);
  });
  test('quotes, commas inside quotes, CRLF, BOM, blank lines, other header spellings', () => {
    expect(parseCsvText('a,"b,c"\r\n"x ""y""",z\n\n')).toEqual([['a', 'b,c'], ['x "y"', 'z']]);
    const r = readPassesCsv(Buffer.from('﻿User Name,Password,Notes\r\nG1,P1,x\r\n\r\ng2,"p,2",\r\n'));
    expect(r.rows).toEqual([{ username: 'G1', password: 'P1' }, { username: 'g2', password: 'p,2' }]);
    expect(r.errors).toEqual([]);
  });
  test('errors: empty cells and duplicates (case-insensitive) are listed by row', () => {
    const r = readPassesCsv(Buffer.from('Username,Password\nA,1\na,2\nB,\n'));
    expect(r.rows).toHaveLength(1);
    expect(r.errors.map((e) => e.row)).toEqual([3, 4]);
  });
  test('wrong header is refused', () => {
    expect(() => readPassesCsv(Buffer.from('Name,Code\na,b'))).toThrow(/Username,Password/);
  });
});

describe('Jamea_MuminDetails', () => {
  beforeEach(() => soap.callOperation.mockReset());
  test('maps loosely named fields; skips Arabic / relatives; never throws', async () => {
    soap.callOperation.mockResolvedValue({ rows: [{ ITS_ID: '50000001', Fullname_Arabic: 'x', FatherName: 'Dad', Fullname: 'Outside Person', Mobile_No: '+919800000000', Email: 'out@example.com' }] });
    await expect(getMuminDetails('50000001')).resolves.toEqual({ name: 'Outside Person', mobile: '+919800000000', email: 'out@example.com' });
    expect(soap.callOperation.mock.calls[0][0]).toBe('Jamea_MuminDetails');
    soap.callOperation.mockResolvedValue({ rows: [] });
    await expect(getMuminDetails('50000001')).resolves.toBeNull();
    soap.callOperation.mockRejectedValue(new Error('down'));
    await expect(getMuminDetails('50000001')).resolves.toBeNull();
    await expect(getMuminDetails('123')).resolves.toBeNull();
  });
});

describe('what the person is told', () => {
  const given = '2026-11-05T06:00:00Z';
  test('10 days from the day it was given when the batch runs longer', () => {
    expect(recipientUntil({ assigned_at: given, expires_at: '2027-02-01T00:00:00Z' }).toISOString()).toBe('2026-11-15T06:00:00.000Z');
  });
  test('the real expiry when the batch ends sooner', () => {
    expect(recipientUntil({ assigned_at: given, expires_at: '2026-11-08T12:00:00Z' }).toISOString()).toBe('2026-11-08T12:00:00.000Z');
  });
  test('message and email: Jamea Internet Access, no other wording, 10-day date', () => {
    const p = { recipient_name: 'Ali', ssid: 'NET', username: 'u1', password: 'p1', assigned_at: given, expires_at: '2027-02-01T00:00:00Z' };
    const msg = passMessage(p);
    const mail = passEmail(p, 'AVIT');
    for (const t of [msg, mail.text, mail.html]) {
      expect(t).toContain('Jamea Internet Access');
      expect(t).not.toMatch(/gu[e]st/i);
      expect(t).toMatch(/15 Nov 2026/);
      expect(t).not.toMatch(/Feb 2027/);
    }
  });
});
