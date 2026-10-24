// Phase 11: invoice input parsing and file checks (no DB).
const crypto = require('crypto');
const sharp = require('sharp');
const { parseLabels, parseRequestList, parseInvoiceNumber } = require('../modules/invoices/invoices.service');
const { processInvoiceFile, filePath } = require('../modules/invoices/invoiceFiles');

describe('parseRequestList', () => {
  test('accepts comma/space lists and JSON arrays, with or without the T-/R- prefix; dedupes', () => {
    expect(parseRequestList('T-1001, 1002  t-1003,T-1001')).toEqual(['1001', '1002', '1003']);
    expect(parseRequestList('["T-1001","R-1004"]')).toEqual(['1001', '1004']);
    expect(parseRequestList(['1001'])).toEqual(['1001']);
    expect(parseRequestList('')).toEqual([]);
    expect(parseRequestList(undefined)).toEqual([]);
  });

  test('rejects junk and more than 20', () => {
    expect(() => parseRequestList('T-1001, DROP TABLE')).toThrow(/not a ticket number/);
    expect(() => parseRequestList('[1,')).toThrow(/Choose the tickets/);
    expect(() => parseRequestList({ a: 1 })).toThrow(/Choose the tickets/);
    expect(() => parseRequestList(Array.from({ length: 21 }, (_, i) => String(1000 + i)))).toThrow(/up to 20/);
  });
});

describe('parseLabels', () => {
  test('trims, empties become null, valid dates pass', () => {
    expect(parseLabels({ supplier: '  Croma ', reference: '', note: ' ', invoiceDate: '2026-10-20' })).toEqual({
      supplier: 'Croma', reference: null, note: null, invoiceDate: '2026-10-20',
    });
    expect(parseLabels({})).toEqual({ supplier: null, reference: null, note: null, invoiceDate: null });
  });

  test('impossible, ancient or far-future dates are refused', () => {
    for (const d of ['2026-02-30', '20-10-2026', '1999-12-31', '2099-01-01', 'yesterday']) {
      expect(() => parseLabels({ invoiceDate: d })).toThrow(/valid invoice date/);
    }
  });

  test('length limits', () => {
    expect(() => parseLabels({ supplier: 'x'.repeat(121) })).toThrow(/supplier/);
    expect(() => parseLabels({ reference: 'x'.repeat(81) })).toThrow(/invoice number/);
    expect(() => parseLabels({ note: 'x'.repeat(1001) })).toThrow(/note/);
  });
});

test('parseInvoiceNumber', () => {
  expect(parseInvoiceNumber('INV-1001')).toBe('1001');
  expect(parseInvoiceNumber('inv1001')).toBe('1001');
  expect(parseInvoiceNumber('1001')).toBe('1001');
  expect(parseInvoiceNumber('T-1001')).toBeNull();
  expect(parseInvoiceNumber('../1')).toBeNull();
});

describe('processInvoiceFile', () => {
  test('PDF: kept byte-for-byte; hash is of the original', async () => {
    const pdf = Buffer.from('%PDF-1.7\n%%EOF');
    const out = await processInvoiceFile({ buffer: pdf, mimetype: 'application/pdf' });
    expect(out.buffer.equals(pdf)).toBe(true);
    expect(out).toMatchObject({ mimeType: 'application/pdf', ext: 'pdf' });
    expect(out.sha256).toBe(crypto.createHash('sha256').update(pdf).digest('hex'));
  });

  test('image: re-encoded to WebP, capped at 3000 px; hash still of the original bytes', async () => {
    const png = await sharp({ create: { width: 4000, height: 1000, channels: 3, background: '#fff' } }).png().toBuffer();
    const out = await processInvoiceFile({ buffer: png, mimetype: 'image/png' });
    expect(out).toMatchObject({ mimeType: 'image/webp', ext: 'webp' });
    expect((await sharp(out.buffer).metadata()).width).toBe(3000);
    expect(out.sha256).toBe(crypto.createHash('sha256').update(png).digest('hex'));
  });

  test('a PNG renamed to .pdf, or a PDF claiming to be an image, is refused', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
    await expect(processInvoiceFile({ buffer: png, mimetype: 'application/pdf' })).rejects.toMatchObject({ code: 'bad_pdf' });
    await expect(processInvoiceFile({ buffer: Buffer.from('%PDF-1.4'), mimetype: 'image/jpeg' })).rejects.toMatchObject({ code: 'bad_image' });
    await expect(processInvoiceFile(undefined)).rejects.toMatchObject({ code: 'no_file' });
  });
});

test('filePath refuses anything but our own stored names', () => {
  expect(() => filePath('1', '../../.env')).toThrow();
  expect(() => filePath('1/../2', `${crypto.randomUUID()}.pdf`)).toThrow();
  expect(filePath('7', '0b6a1f1e-4b8e-4a43-9d8a-7c2f0e3c9a11.pdf')).toMatch(/invoices[\\/]7[\\/]0b6a1f1e/);
});
