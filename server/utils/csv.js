// Small RFC 4180 CSV reader (no dependency). Handles quoted fields, "" inside quotes, commas and
// line breaks inside quotes, CRLF / LF, a UTF-8 BOM, and a missing final newline.
// Every value stays TEXT exactly as written — nothing is turned into a number, so serials and
// phone numbers are never mangled (the problem Excel causes).

const MAX_BYTES = 20 * 1024 * 1024;

// text → array of rows, each an array of strings.
function parseRows(input) {
  let text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  if (text.length > MAX_BYTES) throw new Error('CSV file is too large.');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (inQuotes) throw new Error('CSV file has an unclosed quote.');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Drop completely empty lines.
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

// text → { headers, records: [{ header: value }], rowNumbers } (rowNumbers = line in the file,
// header = 1). Duplicate header names get ".1", ".2" … like Snipe-IT's export does.
function parseCsv(input) {
  const rows = parseRows(input);
  if (!rows.length) return { headers: [], records: [], rowNumbers: [] };
  const seen = new Map();
  const headers = rows[0].map((h) => {
    const name = String(h).trim();
    const n = seen.get(name) || 0;
    seen.set(name, n + 1);
    return n ? `${name}.${n}` : name;
  });
  const records = [];
  const rowNumbers = [];
  for (let r = 1; r < rows.length; r += 1) {
    const rec = {};
    headers.forEach((h, j) => {
      rec[h] = rows[r][j] ?? '';
    });
    records.push(rec);
    rowNumbers.push(r + 1);
  }
  return { headers, records, rowNumbers };
}

// Value for a CSV cell we write ourselves (always quoted when needed).
function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = { parseCsv, parseRows, csvCell, MAX_BYTES };
