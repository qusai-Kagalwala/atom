// Ticket photos (ATOM_Decisions.md §10): JPG / PNG / WebP only, ≤ 10 MB each before compression,
// ≤ 5 per ticket. Re-encoded with sharp to WebP, max 1600 px on the long side, ~300 KB.
// Re-encoding drops ALL metadata (EXIF incl. GPS, camera, ICC) — sharp keeps none unless asked.
// Stored under ATTACHMENT_DIR/requests/<requestId>/<uuid>.webp, never inside the web root.
const crypto = require('crypto');
const fs = require('fs/promises');
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

// Multer: in memory (files are re-encoded before anything touches the disk).
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

  const base = () =>
    sharp(input, { failOn: 'error' })
      .rotate() // apply EXIF orientation before the EXIF is dropped
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });

  let out = null;
  for (const quality of [80, 68, 55, 42]) {
    // eslint-disable-next-line no-await-in-loop
    out = await base().webp({ quality }).toBuffer({ resolveWithObject: true });
    if (out.info.size <= TARGET_BYTES) break;
  }
  return { buffer: out.data, width: out.info.width, height: out.info.height };
}

function dirFor(requestId) {
  if (!/^\d+$/.test(String(requestId))) throw new Error('Bad request id');
  return path.join(config.attachmentDir, 'requests', String(requestId));
}

// Writes processed files; returns rows ready for request_attachments. Caller deletes on rollback.
async function storeImages(requestId, files) {
  const dir = dirFor(requestId);
  await fs.mkdir(dir, { recursive: true });
  const stored = [];
  try {
    for (const f of files) {
      // eslint-disable-next-line no-await-in-loop
      const img = await processImage(f.buffer);
      const storedName = `${crypto.randomUUID()}.webp`;
      // eslint-disable-next-line no-await-in-loop
      await fs.writeFile(path.join(dir, storedName), img.buffer, { flag: 'wx' });
      stored.push({
        storedName,
        originalName: String(f.originalname || '').slice(0, 200) || null,
        mimeType: 'image/webp',
        sizeBytes: img.buffer.length,
        width: img.width,
        height: img.height,
      });
    }
    return stored;
  } catch (err) {
    await removeStored(requestId, stored);
    throw err;
  }
}

async function removeStored(requestId, stored) {
  const dir = dirFor(requestId);
  await Promise.all(stored.map((s) => fs.rm(path.join(dir, s.storedName), { force: true }).catch(() => {})));
}

// Absolute path of a stored file, refusing anything that escapes the folder.
function filePath(requestId, storedName) {
  if (!/^[0-9a-f-]{36}\.(webp|jpg|png)$/.test(storedName)) throw new Error('Bad stored name');
  return path.join(dirFor(requestId), storedName);
}

module.exports = { photosField, processImage, storeImages, removeStored, filePath, MAX_FILES_PER_TICKET };
