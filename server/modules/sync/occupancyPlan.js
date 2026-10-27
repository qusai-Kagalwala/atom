// Room occupancy sheet → who sits in which room / cubicle (Phase 8.2). Pure, no DB.
// Sheet columns (Marol intercom directory, row 2 headers):
//   S.No · Building · Floor · Department · Room No · Place · ITS/Emp ID · Name · Intercom · DID No
// Headers are found by name in the first rows; if none are found the A–J order above is used
// (the first header cell is merged with a banner row, so the CSV header line is not reliable).
const FIXED = ['sno', 'building', 'floor', 'department', 'roomNo', 'place', 'personId', 'name', 'intercom', 'didNo'];
const HEADER_RES = {
  personId: /\bits\b|emp|ejamaat/i,
  roomNo: /room/i,
  building: /build|bldg/i,
  floor: /floor/i,
  department: /dep|idarah|section/i,
  place: /place|seat|cubic|cabin/i,
  name: /name/i,
  intercom: /intercom|\bext/i,
  didNo: /\bdid\b/i,
};
const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

// → { map: { key: columnIndex }, headerRow } or null
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 6); r += 1) {
    const map = {};
    rows[r].forEach((cell, i) => {
      const text = clean(cell);
      if (!text) return;
      for (const [key, re] of Object.entries(HEADER_RES)) {
        if (map[key] === undefined && re.test(text)) {
          map[key] = i;
          break;
        }
      }
    });
    if (map.personId !== undefined && map.roomNo !== undefined && Object.keys(map).length >= 3) return { map, headerRow: r };
  }
  return null;
}

// "1615", "1615-C", "1615 c", "1615/C", "Room 1615C" → { roomNo, cubicle }
function parseRoom(text) {
  const m = /(?:^|[^\d])(\d{4})(?:\s*[-/]?\s*([A-Za-z]{1,2}))?(?![A-Za-z\d])/.exec(clean(text));
  return m ? { roomNo: m[1], cubicle: m[2] ? m[2].toUpperCase() : '' } : null;
}
// "C", "Cubicle C", "Cabin c" → "C"
function parseCubicle(text) {
  const m = /^(?:cubicle|cubical|cabin|cub\.?|seat)?\s*([A-Za-z]{1,2})$/i.exec(clean(text));
  return m ? m[1].toUpperCase() : '';
}
// One cell may list several people: "1301 / 1302", "30328701, 20309076".
const personIds = (text) => (clean(text).match(/\d+/g) || []).filter((d) => d.length <= 8 && Number(d) > 0);

// sheets: [{ tab, rows: string[][] }] → { occupants, counts }
function buildOccupancyPlan(sheets) {
  const occupants = [];
  const seen = new Set();
  const counts = { sourceRows: 0, validRows: 0, skippedRows: 0, skipped: { no_person_id: 0, no_room: 0 }, tabs: [] };

  for (const { tab, rows } of sheets) {
    const header = findHeader(rows);
    const col = header ? header.map : Object.fromEntries(FIXED.map((k, i) => [k, i]));
    const start = header ? header.headerRow + 1 : 1;
    let used = 0;
    for (let r = start; r < rows.length; r += 1) {
      const row = rows[r];
      const cell = (k) => (col[k] === undefined ? '' : clean(row[col[k]]));
      if (!row.some((c) => clean(c))) continue;
      counts.sourceRows += 1;

      const ids = personIds(cell('personId'));
      if (!ids.length) {
        counts.skipped.no_person_id += 1;
        counts.skippedRows += 1;
        continue;
      }
      let room = parseRoom(cell('roomNo')) || parseRoom(cell('place'));
      if (!room) {
        counts.skipped.no_room += 1;
        counts.skippedRows += 1;
        continue;
      }
      if (!room.cubicle) room = { ...room, cubicle: parseCubicle(cell('place')) };

      counts.validRows += 1;
      used += 1;
      for (const personId of ids) {
        const key = `${personId}|${room.roomNo}|${room.cubicle}`;
        if (seen.has(key)) continue;
        seen.add(key);
        occupants.push({
          personId,
          roomNo: room.roomNo,
          cubicle: room.cubicle,
          building: cell('building') || null,
          floor: cell('floor') || null,
          department: cell('department') || null,
          intercom: cell('intercom') || null,
          didNo: cell('didNo') || null,
          tab,
        });
      }
    }
    counts.tabs.push({ tab, rows: used, header: Boolean(header) });
  }
  return { occupants, counts };
}

module.exports = { buildOccupancyPlan, parseRoom, parseCubicle, personIds, findHeader };
