// Sends a stored upload (ticket photo, invoice file).
//   source: { data, path } — data = the bytes from PostgreSQL (033, 7 Nov 2026); otherwise path = a file
//   uploaded before 033 and not yet imported, read straight from disk (no res.sendFile path re-encoding).
//   A plain path string still works. When a file can't be read the real reason is logged (missing,
//   permissions, wrong ATTACHMENT_DIR). Caching headers are set only on success, so a failed load is never
//   cached by the browser. Never logs file contents.
const fs = require('fs/promises');

// convert(buffer) → { data, type }: optional, e.g. WebP → JPEG for phones that can't show WebP.
async function sendStoredFile(res, source, headers, label = 'file', convert = null) {
  const src = typeof source === 'string' ? { path: source } : source || {};
  let data = src.data ? Buffer.from(src.data) : null;
  if (!data) {
    try {
      if (!src.path) throw Object.assign(new Error('no data and no path'), { code: 'NO_DATA' });
      data = await fs.readFile(src.path);
    } catch (err) {
      console.error(`[ATOM] Could not read ${label}${src.path ? ` at ${src.path}` : ''}: ${err.code || err.message}`);
      res.set('Cache-Control', 'no-store');
      return res.status(404).json({ message: 'Not found.' });
    }
  }
  let type = headers['Content-Type'];
  if (convert) {
    try {
      ({ data, type } = await convert(data));
    } catch (err) {
      console.error(`[ATOM] Could not convert ${label}: ${err.message}`);
      res.set('Cache-Control', 'no-store');
      return res.status(500).json({ message: 'Could not prepare the photo.' });
    }
  }
  res.set({ ...headers, 'Content-Type': type, 'Content-Length': String(data.length) });
  return res.end(data);
}

module.exports = { sendStoredFile };
