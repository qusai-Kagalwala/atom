// Plain copies of the SQL Server views in schema "src", columns generated from the view itself.
// §4 rule 1: new column → added; removed, renamed or retyped column → run stops and says which.
//   src.idarah_tafveez_current_yr  ← dbo.Vw_Idarah_Tafveez_CurrentYR   (default, Idarah sync)
//   src.user_department_details    ← dbo.Vw_User_Department_Details_New (HR staff sync)
//   src.supportlog_item_master     ← SupportLog_New.dbo.Item_Master      (items sync, named columns)
//   src.supportlog_main_item_master ← SupportLog_New.dbo.Main_Item_Master (items sync, named columns)
// Every function takes an optional mirror name (default: the Idarah mirror).
const MIRROR = 'src.idarah_tafveez_current_yr';
const HR_MIRROR = 'src.user_department_details';
const ITEM_MIRROR = 'src.supportlog_item_master';
const MAIN_ITEM_MIRROR = 'src.supportlog_main_item_master';
const MIRRORS = new Set([MIRROR, HR_MIRROR, ITEM_MIRROR, MAIN_ITEM_MIRROR]);

function mirrorName(name = MIRROR) {
  if (!MIRRORS.has(name)) throw new Error(`Unknown mirror ${name}`);
  return name;
}

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

// Our short names → the spelling PostgreSQL's format_type() returns.
function canonicalType(t) {
  const s = String(t).toLowerCase().replace(/\s+/g, ' ').trim();
  if (s === 'timestamp') return 'timestamp without time zone';
  if (s === 'timestamptz') return 'timestamp with time zone';
  return s;
}

// -> Map(column → type) or null when the table doesn't exist yet.
async function readMirrorColumns(db, name) {
  const table = mirrorName(name);
  const { rows: exists } = await db.query('SELECT to_regclass($1::text) IS NOT NULL AS ok', [table]);
  if (!exists[0].ok) return null;
  const { rows } = await db.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [table]
  );
  return new Map(rows.map((r) => [r.name, canonicalType(r.type)]));
}

// Compares the view's columns with the mirror. Pure.
// -> { problems: [string], toAdd: [{ name, pgType }], columns: [{ name, pgType }] }  (names lower-cased)
function compareColumns(sourceColumns, mirrorColumns) {
  const problems = [];
  const columns = sourceColumns.map((c) => ({ name: c.name.toLowerCase(), pgType: c.pgType }));

  const seen = new Set();
  for (const c of columns) {
    if (seen.has(c.name)) problems.push(`The view has two columns named "${c.name}" (case-insensitive).`);
    seen.add(c.name);
  }
  if (!mirrorColumns) return { problems, toAdd: problems.length ? [] : columns, columns, creating: true };

  const toAdd = [];
  for (const c of columns) {
    if (!mirrorColumns.has(c.name)) toAdd.push(c);
    else if (mirrorColumns.get(c.name) !== canonicalType(c.pgType)) {
      problems.push(`Column "${c.name}" changed type: was ${mirrorColumns.get(c.name)}, now ${canonicalType(c.pgType)}.`);
    }
  }
  for (const name of mirrorColumns.keys()) {
    if (!seen.has(name)) problems.push(`Column "${name}" is missing from the view (removed or renamed).`);
  }
  return { problems, toAdd, columns, creating: false };
}

// Inside the sync transaction: create/extend the mirror, then replace its rows.
async function loadMirror(client, { columns, toAdd, creating }, sourceRows, name) {
  const table = mirrorName(name);
  if (creating) {
    const defs = columns.map((c) => `${quoteIdent(c.name)} ${c.pgType}`).join(', ');
    await client.query(`CREATE TABLE ${table} (${defs})`);
  } else {
    for (const c of toAdd) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN ${quoteIdent(c.name)} ${c.pgType}`);
    }
  }

  await client.query(`TRUNCATE ${table}`);
  if (!sourceRows.length) return 0;

  // Source rows keep the view's original key spelling; map lower-case name → original key.
  const keyFor = new Map(Object.keys(sourceRows[0]).map((k) => [k.toLowerCase(), k]));
  const colList = columns.map((c) => quoteIdent(c.name)).join(', ');
  const perRow = columns.length;
  const chunkSize = Math.max(1, Math.floor(60000 / perRow)); // stay under pg's 65535 parameters

  for (let start = 0; start < sourceRows.length; start += chunkSize) {
    const chunk = sourceRows.slice(start, start + chunkSize);
    const params = [];
    const tuples = chunk.map((row, i) => {
      const ph = columns.map((c, j) => {
        params.push(row[keyFor.get(c.name)] ?? null);
        return `$${i * perRow + j + 1}`;
      });
      return `(${ph.join(', ')})`;
    });
    await client.query(`INSERT INTO ${table} (${colList}) VALUES ${tuples.join(', ')}`, params);
  }
  return sourceRows.length;
}

module.exports = { MIRROR, HR_MIRROR, ITEM_MIRROR, MAIN_ITEM_MIRROR, readMirrorColumns, compareColumns, loadMirror, canonicalType, quoteIdent };
