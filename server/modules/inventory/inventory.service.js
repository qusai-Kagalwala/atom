// Inventory (Phase 8). Super Admin manages; Engineers read; everyone sees "My assets".
//   - Every change is one transaction with the asset row locked, and one history entry.
//   - Never deleted: assets are retired (note required), places / categories deactivated or merged.
//   - A change made in ATOM to an imported (Snipe-IT) asset is remembered (edited_in_atom_at), so
//     the next import preview can warn before overwriting it.
const pool = require('../../db/pool');
const { HttpError, notFound } = require('../../utils/httpError');

const STATUSES = ['IN_STORE', 'IN_USE', 'IN_REPAIR', 'RETIRED'];
const bad = (message, code) => new HttpError(400, message, code);
const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const isId = (v) => /^\d{1,18}$/.test(String(v ?? ''));
const PERSON = (a) => `CASE WHEN ${a}.id IS NULL THEN NULL ELSE json_build_object('id', ${a}.id::text,
  'name', COALESCE(${a}.name, 'Employee ' || ${a}.employee_id), 'itsNumber', ${a}.its_number, 'employeeId', ${a}.employee_id) END`;

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// "Admin Bldg · Sixth floor · Room 1615 · Cubicle C" (parts already in the name are left out).
function placeDetail(p) {
  if (!p) return null;
  const name = (p.name || '').toLowerCase();
  const parts = [];
  if (p.building && !name.includes(p.building.toLowerCase())) parts.push(p.building);
  if (p.floor && !name.includes(p.floor.toLowerCase())) parts.push(/floor|^B\d$/i.test(p.floor) ? p.floor : `${p.floor} floor`);
  if (p.room_no && !name.includes(p.room_no)) parts.push(`Room ${p.room_no}`);
  if (p.cubicle) parts.push(`Cubicle ${p.cubicle}`);
  return parts.join(' · ') || null;
}

const toPlace = (p) =>
  p && p.id
    ? { id: String(p.id), name: p.name, roomNo: p.room_no, cubicle: p.cubicle, building: p.building, floor: p.floor, detail: placeDetail(p), notes: p.notes ?? null, isActive: p.is_active ?? true }
    : null;

// ---------- assets: read ----------
const ASSET_SELECT = `
  SELECT a.*, a.purchased_on::text AS purchased_on_text,
         c.name AS category_name,
         CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id', p.id, 'name', p.name, 'room_no', p.room_no,
              'cubicle', p.cubicle, 'building', p.building, 'floor', p.floor) END AS place,
         ${PERSON('h')} AS holder
    FROM assets a
    JOIN asset_categories c ON c.id = a.category_id
    LEFT JOIN places p ON p.id = a.place_id
    LEFT JOIN users h ON h.id = a.holder_user_id`;

function toSummary(a) {
  return {
    id: String(a.id),
    tag: a.asset_tag,
    name: a.name,
    category: { id: String(a.category_id), name: a.category_name },
    manufacturer: a.manufacturer,
    model: a.model,
    serial: a.serial,
    serialNeedsCheck: a.serial_needs_check,
    status: a.status,
    place: toPlace(a.place),
    holder: a.holder,
    holderUnknown: a.holder_unknown,
    source: a.source,
    updatedAt: a.updated_at,
  };
}

async function listAssets(f) {
  const params = [];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = [];
  const q = clean(f.q);
  if (q) {
    const like = add(`%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    where.push(`(a.asset_tag ILIKE ${like} OR a.name ILIKE ${like} OR a.serial ILIKE ${like} OR a.model ILIKE ${like}
                 OR a.model_no ILIKE ${like} OR a.manufacturer ILIKE ${like} OR a.mac_address ILIKE ${like}
                 OR p.name ILIKE ${like} OR p.room_no ILIKE ${like} OR h.name ILIKE ${like})`);
  }
  if (f.categoryId) where.push(`a.category_id = ${add(f.categoryId)}::bigint`);
  if (f.placeId) where.push(`a.place_id = ${add(f.placeId)}::bigint`);
  if (f.room) where.push(`p.room_no = ${add(f.room)}::text`);
  if (f.holderId) where.push(`a.holder_user_id = ${add(f.holderId)}::bigint`);
  if (f.status === 'all') {
    /* everything */
  } else if (STATUSES.includes(f.status)) where.push(`a.status = ${add(f.status)}::asset_status`);
  else where.push(`a.status <> 'RETIRED'`);
  if (f.attention === 'serial') where.push('a.serial_needs_check');
  else if (f.attention === 'holder') where.push('a.holder_unknown');
  else if (f.attention === 'any') where.push('(a.serial_needs_check OR a.holder_unknown)');

  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countParams = [...params];
  const limit = add(f.limit);
  const offset = add(f.offset);
  const [rows, total] = await Promise.all([
    pool.query(`${ASSET_SELECT} ${filter} ORDER BY upper(a.asset_tag) LIMIT ${limit}::int OFFSET ${offset}::int`, params),
    pool.query(
      `SELECT count(*)::int AS n FROM assets a LEFT JOIN places p ON p.id = a.place_id LEFT JOIN users h ON h.id = a.holder_user_id ${filter}`,
      countParams
    ),
  ]);
  return { assets: rows.rows.map(toSummary), total: total.rows[0].n };
}

async function getAssetRow(db, tag, { forUpdate = false } = {}) {
  const t = clean(tag);
  if (!t || t.length > 60) return null;
  if (forUpdate) {
    const { rows } = await db.query('SELECT id FROM assets WHERE upper(asset_tag) = upper($1::text) FOR UPDATE', [t]);
    if (!rows[0]) return null;
  }
  const { rows } = await db.query(`${ASSET_SELECT} WHERE upper(a.asset_tag) = upper($1::text)`, [t]);
  return rows[0] || null;
}

async function toDetail(db, user, a) {
  const { rows: events } = await db.query(
    `SELECT e.id, e.type, e.note, e.data, e.created_at, ${PERSON('u')} AS actor
       FROM asset_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.asset_id = $1::bigint ORDER BY e.created_at DESC, e.id DESC`,
    [a.id]
  );
  return {
    ...toSummary(a),
    modelNo: a.model_no,
    macAddress: a.mac_address,
    ipAddress: a.ip_address,
    purchasedOn: a.purchased_on_text,
    orderNumber: a.order_number,
    supplier: a.supplier,
    notes: a.notes,
    snipeitId: a.snipeit_id,
    importedAt: a.imported_at,
    editedInAtomAt: a.edited_in_atom_at,
    createdAt: a.created_at,
    history: events.map((e) => ({ id: String(e.id), type: e.type, note: e.note, data: e.data, at: e.created_at, actor: e.actor })),
    sitsHere: await placeOccupants(db, a.place),
    permissions: { canManage: user.activeRole === 'SUPER_ADMIN' },
  };
}

async function getAsset(user, tag) {
  const a = await getAssetRow(pool, tag);
  if (!a) throw notFound();
  return toDetail(pool, user, a);
}

// My assets: assigned to me, plus (Phase 8.2) equipment at my seat from the occupancy sheet —
// at my cubicle, or shared in my room (a place with that room number and no cubicle).
// Equipment someone else holds is left out.
const toSeat = (o) => ({
  roomNo: o.room_no, cubicle: o.cubicle || null, building: o.building, floor: o.floor,
  department: o.department, intercom: o.intercom, didNo: o.did_no,
});

async function mySeats(db, userId) {
  const { rows } = await db.query(
    `SELECT * FROM place_occupants WHERE user_id = $1::bigint AND is_active ORDER BY room_no, cubicle`,
    [userId]
  );
  return rows;
}

async function myAssets(user) {
  const { rows } = await pool.query(`${ASSET_SELECT} WHERE a.holder_user_id = $1::bigint AND a.status <> 'RETIRED' ORDER BY c.name, a.asset_tag`, [user.id]);
  const seats = await mySeats(pool, user.id);
  let roomAssets = [];
  if (seats.length) {
    const { rows: atSeat } = await pool.query(
      `${ASSET_SELECT}
        WHERE a.status <> 'RETIRED' AND (a.holder_user_id IS NULL)
          AND EXISTS (SELECT 1 FROM place_occupants o
                       WHERE o.user_id = $1::bigint AND o.is_active AND o.room_no = p.room_no
                         AND COALESCE(p.cubicle, '') IN ('', o.cubicle))
        ORDER BY p.room_no, p.cubicle NULLS FIRST, c.name, a.asset_tag`,
      [user.id]
    );
    roomAssets = atSeat.map((a) => ({ ...toSummary(a), shared: !a.place?.cubicle }));
  }
  return { assets: rows.map(toSummary), seats: seats.map(toSeat), roomAssets };
}

// Who sits where this asset is (asset page). A cubicle → its occupants; a whole room → everyone in it.
async function placeOccupants(db, place) {
  if (!place?.room_no) return [];
  const { rows } = await db.query(
    `SELECT u.id::text AS id, COALESCE(u.name, 'Employee ' || u.employee_id) AS name, u.its_number, u.employee_id, o.cubicle
       FROM place_occupants o JOIN users u ON u.id = o.user_id
      WHERE o.is_active AND u.is_active AND o.room_no = $1::text AND ($2::text = '' OR o.cubicle = $2::text)
      ORDER BY o.cubicle, u.name LIMIT 21`,
    [place.room_no, place.cubicle || '']
  );
  return rows.map((r) => ({ id: r.id, name: r.name, itsNumber: r.its_number, employeeId: r.employee_id, cubicle: r.cubicle || null }));
}

// ---------- assets: change (Super Admin) ----------
async function addEvent(db, assetId, type, actorId, { note = null, data = null } = {}) {
  await db.query(
    `INSERT INTO asset_events (asset_id, type, actor_id, note, data) VALUES ($1::bigint, $2::text, $3::bigint, $4::text, $5::jsonb)`,
    [assetId, type, actorId, note, data ? JSON.stringify(data) : null]
  );
}

// Remember changes to imported assets, so a re-import can warn before overwriting them.
const markEdited = (db, a) =>
  a.source === 'snipeit' ? db.query('UPDATE assets SET edited_in_atom_at = now() WHERE id = $1::bigint', [a.id]) : null;

async function activeCategory(db, id) {
  if (!isId(id)) return null;
  const { rows } = await db.query('SELECT id, name FROM asset_categories WHERE id = $1::bigint AND is_active', [id]);
  return rows[0] || null;
}

async function activePlace(db, id) {
  if (!isId(id)) return null;
  const { rows } = await db.query('SELECT * FROM places WHERE id = $1::bigint AND is_active', [id]);
  return rows[0] || null;
}

const TEXT_FIELDS = {
  name: ['name', 120], manufacturer: ['manufacturer', 80], model: ['model', 120], modelNo: ['model_no', 80],
  serial: ['serial', 80], macAddress: ['mac_address', 60], ipAddress: ['ip_address', 60],
  orderNumber: ['order_number', 80], supplier: ['supplier', 120], notes: ['notes', 2000],
};

function readFields(input) {
  const out = {};
  for (const [key, [col, max]] of Object.entries(TEXT_FIELDS)) {
    if (input[key] === undefined) continue;
    const v = key === 'notes' ? String(input[key] ?? '').trim() : clean(input[key]);
    if (v.length > max) throw bad(`Keep ${key} under ${max} characters.`, `bad_${col}`);
    out[col] = v || null;
  }
  if (input.purchasedOn !== undefined) {
    const v = clean(input.purchasedOn);
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('Enter the purchase date as YYYY-MM-DD.', 'bad_date');
    if (v) {
      const d = new Date(`${v}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad('Enter a valid purchase date.', 'bad_date');
    }
    out.purchased_on = v || null;
  }
  if (input.serialNeedsCheck !== undefined) out.serial_needs_check = Boolean(input.serialNeedsCheck);
  else if (out.serial) out.serial_needs_check = false; // a typed serial clears the flag
  return out;
}

async function createAsset(user, input) {
  const tag = clean(input.tag);
  if (!tag || tag.length > 60) throw bad('Enter an asset tag (up to 60 characters).', 'bad_tag');
  return inTransaction(async (db) => {
    const cat = await activeCategory(db, input.categoryId);
    if (!cat) throw bad('Choose a category.', 'bad_category');
    let place = null;
    if (input.placeId) {
      place = await activePlace(db, input.placeId);
      if (!place) throw bad('Choose a place.', 'bad_place');
    }
    const { rows: dup } = await db.query('SELECT 1 FROM assets WHERE upper(asset_tag) = upper($1::text)', [tag]);
    if (dup.length) throw new HttpError(409, `Asset tag ${tag} is already in use.`, 'duplicate_tag');
    const { rows: unit } = await db.query(`SELECT id FROM service_units WHERE code = 'AVIT'`);
    const fields = readFields(input);
    const cols = ['asset_tag', 'category_id', 'place_id', 'service_unit_id', 'source', ...Object.keys(fields)];
    const vals = [tag, cat.id, place ? place.id : null, unit[0].id, 'atom', ...Object.values(fields)];
    const { rows } = await db.query(
      `INSERT INTO assets (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      vals
    );
    await addEvent(db, rows[0].id, 'created', user.id);
    return toDetail(db, user, await getAssetRow(db, tag));
  });
}

async function updateAsset(user, tag, input) {
  return inTransaction(async (db) => {
    const a = await getAssetRow(db, tag, { forUpdate: true });
    if (!a) throw notFound();
    const fields = readFields(input);
    if (input.categoryId !== undefined) {
      const cat = await activeCategory(db, input.categoryId);
      if (!cat) throw bad('Choose a category.', 'bad_category');
      fields.category_id = cat.id;
    }
    const changed = Object.keys(fields).filter((col) => {
      const cur = col === 'purchased_on' ? a.purchased_on_text : a[col];
      return String(cur ?? '') !== String(fields[col] ?? '');
    });
    if (!changed.length) return toDetail(db, user, a);
    const sets = changed.map((col, i) => `${col} = $${i + 2}`);
    await db.query(`UPDATE assets SET ${sets.join(', ')} WHERE id = $1::bigint`, [a.id, ...changed.map((c) => fields[c])]);
    await markEdited(db, a);
    await addEvent(db, a.id, 'edited', user.id, { data: { fields: changed } });
    return toDetail(db, user, await getAssetRow(db, tag));
  });
}

async function moveAsset(user, tag, { placeId, note }) {
  return inTransaction(async (db) => {
    const a = await getAssetRow(db, tag, { forUpdate: true });
    if (!a) throw notFound();
    const place = await activePlace(db, placeId);
    if (!place) throw bad('Choose a place.', 'bad_place');
    if (String(a.place_id) === String(place.id)) throw bad('The asset is already there.', 'no_change');
    await db.query('UPDATE assets SET place_id = $2::bigint WHERE id = $1::bigint', [a.id, place.id]);
    await markEdited(db, a);
    await addEvent(db, a.id, 'moved', user.id, {
      note: clean(note) || null,
      data: { from: a.place ? { id: String(a.place.id), name: a.place.name } : null, to: { id: String(place.id), name: place.name } },
    });
    return toDetail(db, user, await getAssetRow(db, tag));
  });
}

async function assignAsset(user, tag, { userId, note }) {
  return inTransaction(async (db) => {
    const a = await getAssetRow(db, tag, { forUpdate: true });
    if (!a) throw notFound();
    if (a.status === 'RETIRED') throw new HttpError(409, 'This asset is retired.', 'retired');
    if (!isId(userId)) throw bad('Choose a person.', 'bad_user');
    const { rows } = await db.query(
      `SELECT id, COALESCE(name, 'Employee ' || employee_id) AS name FROM users WHERE id = $1::bigint AND is_active`,
      [userId]
    );
    if (!rows[0]) throw bad('Choose an active person.', 'bad_user');
    if (String(a.holder_user_id) === String(rows[0].id)) throw bad('Already assigned to this person.', 'no_change');
    await db.query(
      `UPDATE assets SET holder_user_id = $2::bigint, holder_unknown = FALSE, status = 'IN_USE' WHERE id = $1::bigint`,
      [a.id, rows[0].id]
    );
    await markEdited(db, a);
    await addEvent(db, a.id, 'assigned', user.id, {
      note: clean(note) || null,
      data: { to: { id: String(rows[0].id), name: rows[0].name }, from: a.holder ? { id: a.holder.id, name: a.holder.name } : null },
    });
    return toDetail(db, user, await getAssetRow(db, tag));
  });
}

async function returnAsset(user, tag, { placeId, note }) {
  return inTransaction(async (db) => {
    const a = await getAssetRow(db, tag, { forUpdate: true });
    if (!a) throw notFound();
    if (!a.holder_user_id && !a.holder_unknown) throw bad('Nobody holds this asset.', 'no_holder');
    let place = null;
    if (placeId) {
      place = await activePlace(db, placeId);
      if (!place) throw bad('Choose a place.', 'bad_place');
    }
    await db.query(
      `UPDATE assets SET holder_user_id = NULL, holder_unknown = FALSE, status = 'IN_STORE',
              place_id = COALESCE($2::bigint, place_id) WHERE id = $1::bigint`,
      [a.id, place ? place.id : null]
    );
    await markEdited(db, a);
    await addEvent(db, a.id, 'returned', user.id, {
      note: clean(note) || null,
      data: { from: a.holder ? { id: a.holder.id, name: a.holder.name } : null, to: place ? { id: String(place.id), name: place.name } : null },
    });
    return toDetail(db, user, await getAssetRow(db, tag));
  });
}

async function setStatus(user, tag, { status, note }) {
  if (!STATUSES.includes(status)) throw bad('Choose a status.', 'bad_status');
  const why = clean(note);
  if (status === 'RETIRED' && why.length < 3) throw bad('Say why the asset is retired (at least 3 characters).', 'note_required');
  if (why.length > 1000) throw bad('Keep the note under 1000 characters.', 'note_too_long');
  return inTransaction(async (db) => {
    const a = await getAssetRow(db, tag, { forUpdate: true });
    if (!a) throw notFound();
    if (a.status === status) throw bad('The asset already has this status.', 'no_change');
    if (status === 'IN_USE' && !a.holder_user_id && !a.place_id) throw bad('Assign it to a person or a place first.', 'no_holder');
    // Retired or back in store: nobody holds it any more.
    const clearHolder = status === 'RETIRED' || status === 'IN_STORE';
    await db.query(
      `UPDATE assets SET status = $2::asset_status,
              holder_user_id = CASE WHEN $3::boolean THEN NULL ELSE holder_user_id END,
              holder_unknown = CASE WHEN $3::boolean THEN FALSE ELSE holder_unknown END
        WHERE id = $1::bigint`,
      [a.id, status, clearHolder]
    );
    await markEdited(db, a);
    await addEvent(db, a.id, 'status', user.id, { note: why || null, data: { from: a.status, to: status } });
    return toDetail(db, user, await getAssetRow(db, tag));
  });
}

// ---------- categories ----------
async function listCategories() {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, count(a.id) FILTER (WHERE a.status <> 'RETIRED')::int AS assets
       FROM asset_categories c LEFT JOIN assets a ON a.category_id = c.id
      WHERE c.is_active GROUP BY c.id ORDER BY lower(c.name)`
  );
  return rows.map((c) => ({ id: String(c.id), name: c.name, assets: c.assets }));
}

async function createCategory(input) {
  const name = clean(input.name);
  if (!name || name.length > 80) throw bad('Enter a category name (up to 80 characters).', 'bad_name');
  return inTransaction(async (db) => {
    const { rows: dup } = await db.query('SELECT 1 FROM asset_categories WHERE is_active AND lower(name) = lower($1::text)', [name]);
    if (dup.length) throw new HttpError(409, 'A category with this name already exists.', 'duplicate_name');
    const { rows: unit } = await db.query(`SELECT id FROM service_units WHERE code = 'AVIT'`);
    const { rows } = await db.query('INSERT INTO asset_categories (name, service_unit_id) VALUES ($1::text, $2::bigint) RETURNING id, name', [name, unit[0].id]);
    return { id: String(rows[0].id), name: rows[0].name, assets: 0 };
  });
}

async function renameCategory(id, input) {
  const name = clean(input.name);
  if (!name || name.length > 80) throw bad('Enter a category name (up to 80 characters).', 'bad_name');
  return inTransaction(async (db) => {
    const cat = await activeCategory(db, id);
    if (!cat) throw notFound();
    const { rows: dup } = await db.query(
      'SELECT 1 FROM asset_categories WHERE is_active AND lower(name) = lower($1::text) AND id <> $2::bigint',
      [name, cat.id]
    );
    if (dup.length) throw new HttpError(409, 'Another category already has this name — merge them instead.', 'duplicate_name');
    await db.query('UPDATE asset_categories SET name = $2::text WHERE id = $1::bigint', [cat.id, name]);
    return { id: String(cat.id), name };
  });
}

// Moves every asset (and Snipe-IT name) of `id` into `intoId`; `id` is kept but inactive.
async function mergeCategory(user, id, intoId) {
  if (String(id) === String(intoId)) throw bad('Choose a different category to merge into.', 'same_category');
  return inTransaction(async (db) => {
    const from = await activeCategory(db, id);
    const into = await activeCategory(db, intoId);
    if (!from || !into) throw notFound();
    const { rows: moved } = await db.query('UPDATE assets SET category_id = $2::bigint WHERE category_id = $1::bigint RETURNING id', [from.id, into.id]);
    for (const m of moved) {
      await addEvent(db, m.id, 'edited', user.id, { data: { fields: ['category_id'], merged: { from: from.name, into: into.name } } });
    }
    await db.query('UPDATE asset_category_aliases SET category_id = $2::bigint WHERE category_id = $1::bigint', [from.id, into.id]);
    await db.query('UPDATE asset_categories SET is_active = FALSE, merged_into_id = $2::bigint WHERE id = $1::bigint', [from.id, into.id]);
    return { merged: moved.length, into: { id: String(into.id), name: into.name } };
  });
}

// ---------- places ----------
async function listPlaces(f) {
  const params = [];
  const where = [f.includeInactive ? 'TRUE' : 'p.is_active'];
  const q = clean(f.q);
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    where.push(`(p.name ILIKE $1 OR p.room_no ILIKE $1 OR p.building ILIKE $1)`);
  }
  params.push(f.limit, f.offset);
  const { rows } = await pool.query(
    `SELECT p.*, (SELECT count(*)::int FROM assets a WHERE a.place_id = p.id AND a.status <> 'RETIRED') AS assets,
            count(*) OVER ()::int AS total
       FROM places p WHERE ${where.join(' AND ')}
      ORDER BY p.room_no IS NULL, p.room_no, p.cubicle NULLS FIRST, lower(p.name)
      LIMIT $${params.length - 1}::int OFFSET $${params.length}::int`,
    params
  );
  return { places: rows.map((p) => ({ ...toPlace(p), assets: p.assets })), total: rows[0]?.total ?? 0 };
}

function readPlace(input, current = {}) {
  const v = (k, max) => {
    if (input[k] === undefined) return current[k] ?? null;
    const s = clean(input[k]);
    if (s.length > max) throw bad(`Keep ${k} under ${max} characters.`, `bad_${k}`);
    return s || null;
  };
  const p = {
    name: v('name', 120), room_no: v('roomNo', 20), cubicle: v('cubicle', 8), building: v('building', 60),
    floor: v('floor', 30), notes: v('notes', 500),
  };
  if (!p.name) throw bad('Enter a name for the place.', 'bad_name');
  if (p.cubicle) p.cubicle = p.cubicle.toUpperCase();
  return p;
}

async function createPlace(input) {
  const p = readPlace({ ...input, roomNo: input.roomNo }, {});
  const { rows } = await pool.query(
    `INSERT INTO places (name, room_no, cubicle, building, floor, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [p.name, p.room_no, p.cubicle, p.building, p.floor, p.notes]
  );
  return { ...toPlace(rows[0]), assets: 0 };
}

async function updatePlace(id, input) {
  if (!isId(id)) throw notFound();
  return inTransaction(async (db) => {
    const { rows: cur } = await db.query('SELECT * FROM places WHERE id = $1::bigint FOR UPDATE', [id]);
    if (!cur[0]) throw notFound();
    const c = cur[0];
    const p = readPlace(input, { name: c.name, roomNo: c.room_no, cubicle: c.cubicle, building: c.building, floor: c.floor, notes: c.notes });
    const active = input.isActive === undefined ? c.is_active : Boolean(input.isActive);
    if (!active && c.is_active) {
      const { rows: n } = await db.query(`SELECT count(*)::int AS n FROM assets WHERE place_id = $1::bigint AND status <> 'RETIRED'`, [c.id]);
      if (n[0].n) throw bad(`Move the ${n[0].n} asset(s) out of this place first.`, 'place_in_use');
    }
    const { rows } = await db.query(
      `UPDATE places SET name = $2, room_no = $3, cubicle = $4, building = $5, floor = $6, notes = $7, is_active = $8
        WHERE id = $1::bigint RETURNING *`,
      [c.id, p.name, p.room_no, p.cubicle, p.building, p.floor, p.notes, active]
    );
    return toPlace(rows[0]);
  });
}

// ---------- import log ----------
async function listImports() {
  const { rows } = await pool.query(
    `SELECT i.id, i.file_name, i.rows, i.summary, i.created_at, ${PERSON('u')} AS by
       FROM asset_imports i LEFT JOIN users u ON u.id = i.imported_by
      ORDER BY i.created_at DESC LIMIT 20`
  );
  return rows.map((r) => ({ id: String(r.id), fileName: r.file_name, rows: r.rows, summary: r.summary, at: r.created_at, by: r.by }));
}

module.exports = {
  STATUSES,
  placeDetail,
  listAssets,
  getAsset,
  myAssets,
  createAsset,
  updateAsset,
  moveAsset,
  assignAsset,
  returnAsset,
  setStatus,
  listCategories,
  createCategory,
  renameCategory,
  mergeCategory,
  listPlaces,
  createPlace,
  updatePlace,
  listImports,
};
