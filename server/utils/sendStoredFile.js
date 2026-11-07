// Sends a stored upload (ticket photo, invoice file) read straight from disk (decided 5 Nov 2026).
// Replaces res.sendFile for these: no path re-encoding, and the real reason is logged when a file can't be
// read (missing, permissions, wrong ATTACHMENT_DIR). Caching headers are set only on success, so a failed
// load is never cached by the browser. Never logs file contents.
const fs = require('fs/promises');

// convert(buffer) → { data, type }: optional, e.g. WebP → JPEG for phones that can't show WebP.
async function sendStoredFile(res, filePath, headers, label = 'file', convert = null) {
  let data;
  try {
    data = await fs.readFile(filePath);
  } catch (err) {
    console.error(`[ATOM] Could not read ${label} at ${filePath}: ${err.code || err.message}`);
    res.set('Cache-Control', 'no-store');
    return res.status(404).json({ message: 'Not found.' });
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
