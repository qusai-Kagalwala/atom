// Upload limits for ticket photos (multer layer). No DB, no disk.
const express = require('express');
const request = require('supertest');
const { photosField } = require('../modules/requests/attachments');
const { HttpError } = require('../utils/httpError');

function app() {
  const a = express();
  a.post('/up', photosField, (req, res) => res.json({ n: req.files.length, title: req.body.title }));
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ code: err.code, message: err.message });
    return res.status(500).end();
  });
  return a;
}

const small = Buffer.alloc(1024, 1);

it('accepts up to 5 JPG/PNG/WebP files and keeps text fields', async () => {
  let r = request(app()).post('/up').field('title', 'Printer');
  for (let i = 0; i < 5; i += 1) r = r.attach('photos', small, { filename: `${i}.png`, contentType: 'image/png' });
  const res = await r;
  expect(res.body).toEqual({ n: 5, title: 'Printer' });
});

it('rejects a 6th file', async () => {
  let r = request(app()).post('/up');
  for (let i = 0; i < 6; i += 1) r = r.attach('photos', small, { filename: `${i}.png`, contentType: 'image/png' });
  expect((await r).body.code).toBe('too_many_files');
});

it('rejects files over 10 MB', async () => {
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
  const res = await request(app()).post('/up').attach('photos', big, { filename: 'big.jpg', contentType: 'image/jpeg' });
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ code: 'file_too_large', message: 'Each photo must be 10 MB or smaller.' });
});

it.each([
  ['clip.mp4', 'video/mp4'],
  ['voice.m4a', 'audio/mp4'],
  ['doc.pdf', 'application/pdf'],
  ['anim.gif', 'image/gif'],
])('rejects %s (%s) — images only', async (name, type) => {
  const res = await request(app()).post('/up').attach('photos', small, { filename: name, contentType: type });
  expect(res.body.code).toBe('bad_file_type');
});

it('rejects photos under any other field name', async () => {
  const res = await request(app()).post('/up').attach('file', small, { filename: 'a.png', contentType: 'image/png' });
  expect(res.body.code).toBe('too_many_files');
});
