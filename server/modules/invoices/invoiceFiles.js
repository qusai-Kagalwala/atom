// Invoice files (ATOM_Decisions.md §11): PDF, JPG, PNG or WebP, up to 10 MB.
//   - The duplicate check uses SHA-256 of the ORIGINAL bytes (before any processing).
//   - PDFs are stored exactly as uploaded (checked to really be a PDF).
//   - Images are re-encoded to WebP, max 3000 px, high quality (text must stay readable);
//     re-encoding drops all metadata (EXIF incl. GPS).
//   - Stored under ATTACHMENT_DIR/invoices/<invoiceId>/<uuid>.<pdf|webp>, never in the web root.
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const { config } = require('../../config/env');
const { HttpError } = require('../../utils/httpError');

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_SIDE = 3000;
const ACCEPTED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp']);
const TYPE_MSG = 'Invoices must be a PDF, JPG, PNG or WebP file.';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 20, fieldSize: 20 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ACCEPTED_MIME.has(file.mimetype)) return cb(new HttpError(400, TYPE_MSG, 'bad_file_type'));
    return cb(null, true);
  },
});

// Express middleware for the single "file" field, with friendly errors.
function invoiceFileField(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(400, 'The invoice must be 10 MB or smaller.', 'file_too_large'));
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new HttpError(400, 'Upload one invoice file at a time.', 'too_many_files'));
    }
    return next(new HttpError(400, 'Could not read the upload.', 'bad_upload'));
  });
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// A real PDF starts with "%PDF-" within its first 1 KB (the spec allows a little junk before it).
const looksLikePdf = (buffer) => buffer.subarray(0, 1024).includes('%PDF-');

// { buffer, mimetype } → { sha256, buffer, mimeType, ext }. Throws 400 if it isn't what it claims.
async function processInvoiceFile(file) {
  if (!file?.buffer?.length) throw new HttpError(400, 'Choose the invoice file.', 'no_file');
  const hash = sha256(file.buffer);

  if (file.mimetype === 'application/pdf') {
    if (!looksLikePdf(file.buffer)) throw new HttpError(400, 'This file is not a valid PDF.', 'bad_pdf');
    return { sha256: hash, buffer: file.buffer, mimeType: 'application/pdf', ext: 'pdf' };
  }

  let meta;
  try {
    meta = await sharp(file.buffer, { failOn: 'error' }).metadata();
  } catch {
    throw new HttpError(400, 'This file could not be read as an image.', 'bad_image');
  }
  if (!IMAGE_FORMATS.has(meta.format)) throw new HttpError(400, TYPE_MSG, 'bad_file_type');
  if (!meta.width || !meta.height || meta.width * meta.height > 80_000_000) {
    throw new HttpError(400, 'This image is too large to process.', 'bad_image');
  }
  const out = await sharp(file.buffer, { failOn: 'error' })
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer();
  return { sha256: hash, buffer: out, mimeType: 'image/webp', ext: 'webp' };
}

function dirFor(invoiceId) {
  if (!/^\d+$/.test(String(invoiceId))) throw new Error('Bad invoice id');
  return path.join(config.attachmentDir, 'invoices', String(invoiceId));
}

const newStoredName = (ext) => `${crypto.randomUUID()}.${ext}`;

async function writeFile(invoiceId, storedName, buffer) {
  const dir = dirFor(invoiceId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, storedName), buffer, { flag: 'wx' });
}

async function removeFile(invoiceId, storedName) {
  await fs.rm(filePath(invoiceId, storedName), { force: true }).catch(() => {});
}

// Absolute path of a stored file, refusing anything that escapes the folder.
function filePath(invoiceId, storedName) {
  if (!/^[0-9a-f-]{36}\.(pdf|webp)$/.test(storedName)) throw new Error('Bad stored name');
  return path.join(dirFor(invoiceId), storedName);
}

module.exports = {
  invoiceFileField,
  processInvoiceFile,
  newStoredName,
  writeFile,
  removeFile,
  filePath,
  sha256,
  MAX_BYTES,
};
