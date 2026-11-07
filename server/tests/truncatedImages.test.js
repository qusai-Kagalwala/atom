// A JPEG cut short at the end ("VipsJpeg: premature end of JPEG image" — seen on production 7 Nov 2026 for a
// phone photo) is still accepted, decoded leniently; a file that isn't an image at all is still refused (400).
const sharp = require('sharp');
const { processImage } = require('../modules/requests/attachments');
const { processInvoiceFile } = require('../modules/invoices/invoiceFiles');

let cut;
beforeAll(async () => {
  const full = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#c86428' } }).jpeg({ quality: 90 }).toBuffer();
  cut = full.subarray(0, Math.floor(full.length * 0.7));
  // The case itself: a strict decode fails on it.
  await expect(sharp(cut, { failOn: 'error' }).webp().toBuffer()).rejects.toThrow(/premature end/);
});

test('ticket photo: a cut-off JPEG becomes a WebP (1600 px), not a server error', async () => {
  const out = await processImage(cut);
  expect(out.width).toBe(1600);
  expect((await sharp(out.buffer).metadata()).format).toBe('webp');
});

test('invoice image: a cut-off JPEG becomes a WebP', async () => {
  const out = await processInvoiceFile({ buffer: cut, mimetype: 'image/jpeg' });
  expect(out).toMatchObject({ mimeType: 'image/webp', ext: 'webp' });
});

test('not an image at all: still 400 bad_image', async () => {
  const junk = Buffer.concat([cut.subarray(0, 4), Buffer.alloc(500, 7)]);
  await expect(processImage(junk)).rejects.toMatchObject({ status: 400, code: 'bad_image' });
  await expect(processInvoiceFile({ buffer: junk, mimetype: 'image/jpeg' })).rejects.toMatchObject({ status: 400, code: 'bad_image' });
});
