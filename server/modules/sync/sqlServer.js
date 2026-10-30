// Read-only SQL Server access for the syncs. Only these reads exist:
//   1. SELECT * FROM dbo.Vw_Idarah_Tafveez_CurrentYR     (Idarah sync)
//   2. SELECT * FROM dbo.Vw_User_Department_Details_New  (HR staff sync, Phase 3.1)
//   3. SELECT User_Id, Password FROM dbo.Login_Master    (one-time employee-ID import)
//   4. Support Log items (companies step B, 30 Oct 2026), named columns only, from the database in
//      SUPPORTLOG_DB (default SupportLog_New) on the same server and login:
//        dbo.Item_Master       Company_Id, Item_Id, Category, Item, Sub_Item, Description, Tag, Price, Qty, Qty_Multiples, M_ID
//        dbo.Main_Item_Master  Item_Id, Item, Category
// Nothing here ever writes to SQL Server.
const sql = require('mssql');
const { config } = require('../../config/env');

const IDARAH_VIEW = 'dbo.Vw_Idarah_Tafveez_CurrentYR';
const HR_VIEW = 'dbo.Vw_User_Department_Details_New';

// SQL Server type → PostgreSQL type for the mirror (ATOM_Decisions.md §4).
function toPgType(column) {
  const decl = String(column.type?.declaration || '').toLowerCase();
  switch (decl) {
    case 'int':
    case 'smallint':
    case 'tinyint':
      return 'integer';
    case 'bigint':
      return 'bigint';
    case 'bit':
      return 'boolean';
    case 'date':
      return 'date';
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
      return 'timestamp';
    case 'datetimeoffset':
      return 'timestamptz';
    case 'decimal':
    case 'numeric':
      return `numeric(${column.precision},${column.scale})`;
    case 'money':
      return 'numeric(19,4)';
    case 'smallmoney':
      return 'numeric(10,4)';
    case 'float':
      return 'double precision';
    case 'real':
      return 'real';
    default:
      return 'text'; // varchar, nvarchar, char, nchar, text, ntext, uniqueidentifier, xml, …
  }
}

function connectionConfig() {
  const c = config.mssql;
  if (!c.server || !c.user) throw new Error('MSSQL_SERVER and MSSQL_USER are not set');
  return {
    server: c.server,
    port: c.port,
    database: c.database,
    user: c.user,
    password: c.password,
    options: { encrypt: c.encrypt, trustServerCertificate: c.trustServerCertificate },
    connectionTimeout: 15_000,
    requestTimeout: 60_000,
    pool: { max: 2, min: 0, idleTimeoutMillis: 10_000 },
  };
}

async function withConnection(fn) {
  const pool = new sql.ConnectionPool(connectionConfig());
  await pool.connect();
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

const asTable = (result) => {
  const meta = Object.values(result.recordset.columns).sort((a, b) => a.index - b.index);
  return { columns: meta.map((c) => ({ name: c.name, pgType: toPgType(c) })), rows: result.recordset };
};

// -> { columns: [{ name, pgType }], rows: [ { ColumnName: value, … } ] }
function readView(view) {
  return withConnection(async (pool) => asTable(await pool.request().query(`SELECT * FROM ${view}`)));
}

const ITEM_MASTER_COLUMNS = ['Company_Id', 'Item_Id', 'Category', 'Item', 'Sub_Item', 'Description', 'Tag', 'Price', 'Qty', 'Qty_Multiples', 'M_ID'];
const MAIN_ITEM_COLUMNS = ['Item_Id', 'Item', 'Category'];

// Support Log item lists (all companies). The database name comes from .env and must be a plain name.
// A removed or renamed column makes SQL Server refuse the query — the sync then stops and says so.
// -> { items: { columns, rows }, main: { columns, rows } }
function readSupportLogItems() {
  const db = String(config.supportlog.database || '');
  if (!/^[A-Za-z0-9_]{1,128}$/.test(db)) throw new Error('SUPPORTLOG_DB must be a plain database name.');
  return withConnection(async (pool) => {
    const items = await pool.request().query(`SELECT ${ITEM_MASTER_COLUMNS.join(', ')} FROM [${db}].dbo.Item_Master`);
    const main = await pool.request().query(`SELECT ${MAIN_ITEM_COLUMNS.join(', ')} FROM [${db}].dbo.Main_Item_Master`);
    return { items: asTable(items), main: asTable(main) };
  });
}

const readIdarahView = () => readView(IDARAH_VIEW);
const readHrView = () => readView(HR_VIEW);

// -> [{ User_Id, Password }]  (only these two columns are ever read)
async function readLoginMaster() {
  return withConnection(async (pool) => {
    const result = await pool.request().query('SELECT User_Id, Password FROM dbo.Login_Master');
    return result.recordset;
  });
}

module.exports = {
  readIdarahView,
  readHrView,
  readLoginMaster,
  readSupportLogItems,
  toPgType,
  IDARAH_VIEW,
  HR_VIEW,
  ITEM_MASTER_COLUMNS,
  MAIN_ITEM_COLUMNS,
};
