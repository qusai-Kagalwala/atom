// Ticket photos (ATOM_Decisions.md §10): JPG / PNG / WebP only, ≤ 10 MB each before compression,
// ≤ 5 per ticket. Re-encoded with sharp to WebP, max 1600 px on the long side, ~300 KB.
// Re-encoding drops ALL metadata (EXIF incl. GPS, camera, ICC) — sharp keeps none unless asked.
// Stored in PostgreSQL (request_attachments.data, migration 033, 7 Nov 2026). Photos uploaded before that
// are read from ATTACHMENT_DIR/requests/<requestId>/<uuid>.webp until the one-time import copies them in.
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const { config } = require('../../config/env');
const { HttpError } = require('../../utils/httpError');

const MAX_FILES_PER_TICKET = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_SIDE = 1600;
const TARGET_BYTES = 300 * 1024;
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Multer: in memory (files are re-encoded, then saved in the database).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: MAX_FILES_PER_TICKET, fields: 20, fieldSize: 20 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ACCEPTED_MIME.has(file.mimetype)) {
      return cb(new HttpError(400, 'Photos must be JPG, PNG or WebP.', 'bad_file_type'));
    }
    return cb(null, true);
  },
});

// Express middleware for the "photos" field, with friendly errors.
function photosField(req, res, next) {
  upload.array('photos', MAX_FILES_PER_TICKET)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(400, 'Each photo must be 10 MB or smaller.', 'file_too_large'));
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new HttpError(400, `You can add up to ${MAX_FILES_PER_TICKET} photos.`, 'too_many_files'));
    }
    return next(new HttpError(400, 'Could not read the upload.', 'bad_upload'));
  });
}

// Buffer → { buffer, width, height } as WebP. Throws 400 if it isn't really an accepted image.
async function processImage(input) {
  let meta;
  try {
    meta = await sharp(input, { failOn: 'error' }).metadata();
  } catch {
    throw new HttpError(400, 'One of the photos could not be read as an image.', 'bad_image');
  }
  if (!ACCEPTED_FORMATS.has(meta.format)) {
    throw new HttpError(400, 'Photos must be JPG, PNG or WebP.', 'bad_file_type');
  }
  if (!meta.width || !meta.height || meta.width * meta.height > 80_000_000) {
    throw new HttpError(400, 'One of the photos is too large to process.', 'bad_image');
  }

  // Strict first. A photo cut short at the end ("premature end of JPEG" — common from phones and
  // WhatsApp) is decoded leniently instead; only a photo that can't be decoded at all is refused (7 Nov 2026).
  const encode = async (failOn) => {
    const base = () =>
      sharp(input, { failOn })
        .rotate() // apply EXIF orientation before the EXIF is dropped
        .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    let out = null;
    for (const quality of [80, 68, 55, 42]) {
      // eslint-disable-next-line no-await-in-loop
      out = await base().webp({ quality }).toBuffer({ resolveWithObject: true });
      if (out.info.size <= TARGET_BYTES) break;
    }
    return out;
  };
  let out;
  try {
    out = await encode('error');
  } catch {
    try {
      out = await encode('none');
    } catch {
      throw new HttpError(400, 'One of the photos could not be read as an image.', 'bad_image');
    }
  }
  return { buffer: out.data, width: out.info.width, height: out.info.height };
}

function dirFor(requestId) {
  if (!/^\d+$/.test(String(requestId))) throw new Error('Bad request id');
  return path.join(config.attachmentDir, 'requests', String(requestId));
}

// Re-encodes the uploads; returns rows ready for request_attachments (data = the WebP bytes). Nothing is
// written anywhere: the caller inserts them in its transaction, so a rollback leaves nothing behind.
async function prepareImages(files) {
  const out = [];
  for (const f of files) {
    // eslint-disable-next-line no-await-in-loop
    const img = await processImage(f.buffer);
    out.push({
      storedName: `${crypto.randomUUID()}.webp`, // a name for the row; nothing is written under it
      originalName: String(f.originalname || '').slice(0, 200) || null,
      mimeType: 'image/webp',
      sizeBytes: img.buffer.length,
      width: img.width,
      height: img.height,
      data: img.buffer,
    });
  }
  return out;
}

// Where a photo uploaded before 033 lives on disk, refusing anything that escapes the folder.
function filePath(requestId, storedName) {
  if (!/^[0-9a-f-]{36}\.(webp|jpg|png)$/.test(storedName)) throw new Error('Bad stored name');
  return path.join(dirFor(requestId), storedName);
}

module.exports = { photosField, processImage, prepareImages, filePath, MAX_FILES_PER_TICKET };
