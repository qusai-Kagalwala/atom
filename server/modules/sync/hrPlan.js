// Pure mapping: HR view rows (dbo.Vw_User_Department_Details_New) → what ATOM should contain.
// No database access here. Rules: ATOM_Decisions.md §5 (decided 26 Oct 2026).
//
// The view = HR employee master (Active = 1) UNION the current-year Idarah view, joined to the
// department table. Columns used: dept_id, user_id, u_name, dptnm, dptnm_arabic, idarahcat,
// idarahcat_arabic, dpt_email, roomno, floor, location. (office_no is always empty.)
//   - 8-digit user_id = ITS person → people stay with the Idarah sync; the row still counts for
//     its department.
//   - short user_id   = employee-ID staff → created / updated / deactivated by this sync.
const { clean } = require('./idarahPlan');

const ITS_RE = /^\d{8}$/;
const SHORT_ID_RE = /^\d{1,7}$/;
const DEPT_RE = /^\d{1,9}$/;

function lowerKeys(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k.toLowerCase()] = v;
  return out;
}

// "TASNEEM BAI MOHAMMED BHAI SUTERWALA" → "Tasneem Bai Mohammed Bhai Suterwala".
// Names that already mix upper and lower case are kept as they are.
function titleCase(name) {
  const s = clean(name);
  if (!s) return null;
  const collapsed = s.replace(/\s+/g, ' ');
  if (collapsed !== collapsed.toUpperCase()) return collapsed;
  return collapsed.toLowerCase().replace(/(^|[\s\-'(./])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

const FLOORS = {
  b1: 'B1', b2: 'B2', basement: 'Basement', ground: 'Ground',
  first: 'First', second: 'Second', third: 'Third', fourth: 'Fourth', fifth: 'Fifth',
  sixth: 'Sixth', seventh: 'Seventh', eighth: 'Eighth', ninth: 'Ninth', tenth: 'Tenth',
};

// "SECOND" / "Sixth " → "Second" / "Sixth". Unknown values are kept (trimmed).
function normaliseFloor(value) {
  const s = clean(value);
  if (!s) return null;
  return FLOORS[s.toLowerCase()] || s;
}

// "ADMIN BLDG" → "Admin Bldg", "MAHAD AL ZAHRA" → "Mahad Al Zahra".
function normaliseBuilding(value) {
  return titleCase(value);
}

// "Admin Bldg · Sixth floor · Room 1615" (missing parts left out; null when nothing is known).
function locationLabel({ building, floor, roomNo }) {
  const parts = [];
  if (building) parts.push(building);
  if (floor) parts.push(/^B\d$/i.test(floor) || /floor/i.test(floor) ? floor : `${floor} floor`);
  if (roomNo) parts.push(`Room ${roomNo}`);
  return parts.length ? parts.join(' · ') : null;
}

const sortKey = (r) => [r.dept_id, r.user_id, r.u_name].map((v) => clean(v) ?? '').join('\u0001');

function firstFilled(target, field, value) {
  if (target[field] == null && value != null) target[field] = value;
}

// rows → { departments, people, counts }
//   departments: [{ idarahId, name, nameArabic, category, categoryArabic, email, building, floor, roomNo }]
//   people:      [{ employeeId, name, departmentIds: [idarahId] }]   (short IDs only)
//   counts:      { sourceRows, validRows, itsRows, skippedRows, skipped: { reason: n } }
function buildHrPlan(sourceRows) {
  const rows = sourceRows.map(lowerKeys).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  const departments = new Map();
  const people = new Map();
  const skipped = {};
  let validRows = 0;
  let itsRows = 0;
  const skip = (reason) => {
    skipped[reason] = (skipped[reason] || 0) + 1;
  };

  for (const r of rows) {
    const deptId = clean(r.dept_id);
    if (!deptId || !DEPT_RE.test(deptId)) {
      skip('no_department');
      continue;
    }
    const d = departments.get(deptId) || { idarahId: deptId };
    firstFilled(d, 'name', clean(r.dptnm));
    firstFilled(d, 'nameArabic', clean(r.dptnm_arabic));
    firstFilled(d, 'category', clean(r.idarahcat));
    firstFilled(d, 'categoryArabic', clean(r.idarahcat_arabic));
    firstFilled(d, 'email', clean(r.dpt_email));
    firstFilled(d, 'building', normaliseBuilding(r.location));
    firstFilled(d, 'floor', normaliseFloor(r.floor));
    firstFilled(d, 'roomNo', clean(r.roomno));
    departments.set(deptId, d);

    const id = clean(r.user_id);
    if (id && ITS_RE.test(id)) {
      itsRows += 1; // ITS people come from the Idarah sync
      continue;
    }
    if (!id || !SHORT_ID_RE.test(id)) {
      skip('invalid_user_id');
      continue;
    }
    validRows += 1;
    const p = people.get(id) || { employeeId: id, name: null, departmentIds: [] };
    firstFilled(p, 'name', titleCase(r.u_name));
    if (!p.departmentIds.includes(deptId)) p.departmentIds.push(deptId);
    people.set(id, p);
  }

  const skippedRows = Object.values(skipped).reduce((a, b) => a + b, 0);
  return {
    departments: [...departments.values()],
    people: [...people.values()],
    counts: { sourceRows: sourceRows.length, validRows, itsRows, skippedRows, skipped },
  };
}

module.exports = { buildHrPlan, titleCase, normaliseFloor, normaliseBuilding, locationLabel };
