// Read-only SQL Server access for the syncs. Only these reads exist:
//   1. SELECT * FROM dbo.Vw_Idarah_Tafveez_CurrentYR     (Idarah sync)
//   2. SELECT * FROM dbo.Vw_User_Department_Details_New  (HR staff sync, Phase 3.1)
//   3. SELECT User_Id, Password FROM dbo.Login_Master    (one-time employee-ID import)
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

// -> { columns: [{ name, pgType }], rows: [ { ColumnName: value, … } ] }
function readView(view) {
  return withConnection(async (pool) => {
    const result = await pool.request().query(`SELECT * FROM ${view}`);
    const meta = Object.values(result.recordset.columns).sort((a, b) => a.index - b.index);
    return {
      columns: meta.map((c) => ({ name: c.name, pgType: toPgType(c) })),
      rows: result.recordset,
    };
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

module.exports = { readIdarahView, readHrView, readLoginMaster, toPgType, IDARAH_VIEW, HR_VIEW };
