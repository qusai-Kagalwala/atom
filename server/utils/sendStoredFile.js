// Sends a stored upload (ticket photo, invoice file) read straight from disk (decided 5 Nov 2026).
// Replaces res.sendFile for these: no path re-encoding, and the real reason is logged when a file can't be
// read (missing, permissions, wrong ATTACHMENT_DIR). Caching headers are set only on success, so a failed
// load is never cached by the browser. Never logs file contents.
const fs = require('fs/promises');

async function sendStoredFile(res, filePath, headers, label = 'file') {
  let data;
  try {
    data = await fs.readFile(filePath);
  } catch (err) {
    console.error(`[ATOM] Could not read ${label} at ${filePath}: ${err.code || err.message}`);
    res.set('Cache-Control', 'no-store');
    return res.status(404).json({ message: 'Not found.' });
  }
  res.set({ ...headers, 'Content-Length': String(data.length) });
  return res.end(data);
}

module.exports = { sendStoredFile };
