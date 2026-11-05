// Guest Wi-Fi passes: CSV reading and the eJamaat details mapping. No database, eJamaat SOAP mocked.
jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../services/ejamaatSoap', () => ({ callOperation: jest.fn() }));

const soap = require('../services/ejamaatSoap');
const { getMuminDetails } = require('../services/ejamaatClient');
const { readPassesCsv, parseCsvText } = require('../modules/wifi/wifi.service');

describe('CSV', () => {
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
    soap.callOperation.mockResolvedValue({ rows: [{ ITS_ID: '50000001', Fullname_Arabic: 'x', FatherName: 'Dad', Fullname: 'Outside Guest', Mobile_No: '+919800000000', Email: 'out@example.com' }] });
    await expect(getMuminDetails('50000001')).resolves.toEqual({ name: 'Outside Guest', mobile: '+919800000000', email: 'out@example.com' });
    expect(soap.callOperation.mock.calls[0][0]).toBe('Jamea_MuminDetails');
    soap.callOperation.mockResolvedValue({ rows: [] });
    await expect(getMuminDetails('50000001')).resolves.toBeNull();
    soap.callOperation.mockRejectedValue(new Error('down'));
    await expect(getMuminDetails('50000001')).resolves.toBeNull();
    await expect(getMuminDetails('123')).resolves.toBeNull();
  });
});
