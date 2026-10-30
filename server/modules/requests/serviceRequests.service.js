// Catalogue + service requests (Phase 9, ATOM_Decisions.md §9). Each company has its own catalogue;
// everything here is inside the session's company ("Super Admin" below = that company's Admin).
//   Employee: picks catalogue items and/or types "something else", each with quantity and reason.
//   Super Admin: approves / rejects each item (reason required to reject). When none is pending:
//     any approved → OPEN (Assign queue, like a ticket) · all rejected → REJECTED.
//   Engineer (assigned) or Super Admin: delivers each approved item — physical items by handing over
//     in-store assets (assigned to the requester), software / services with a note.
//     The last delivery moves the request to RESOLVED ("Delivered"); the Super Admin closes it.
// Every change: one transaction, request row locked, timeline event, notifications after COMMIT.
const pool = require('../../db/pool');
const { HttpError, notFound } = require('../../utils/httpError');
const notifications = require('../notifications/notifications.service');
const repo = require('./requests.repo');
const lifecycle = require('./lifecycle');
const tickets = require('./requests.service');
const timeFrames = require('./timeFrames');
const roles = require('../../utils/roles');

const bad = (message, code) => new HttpError(400, message, code);
const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const isId = (v) => /^\d{1,18}$/.test(String(v ?? ''));
// supply = a consumable taken from stock (Tanzeem: stationery, crockery …), no asset tags.
const KINDS = ['physical', 'software', 'service', 'supply'];
const MAX_ITEMS = 10;
const MAX_ASSETS = 50;

// ---------- catalogue ----------
function toCatalogue(c) {
  return {
    id: String(c.id),
    name: c.name,
    kind: c.kind,
    description: c.description,
    group: c.group_name || null,
    // Approximate price per unit requested (shown to requesters with a total); pack size; stock (null = not tracked).
    price: c.price == null ? null : Number(c.price),
    packSize: c.pack_size ?? null,
    stock: c.stock ?? null,
    source: c.source,
    assetCategory: c.asset_category_id ? { id: String(c.asset_category_id), name: c.asset_category_name } : null,
    sortOrder: c.sort_order,
    isActive: c.is_active,
  };
}

async function listCatalogue(user, { includeInactive = false } = {}) {
  if (!user.companyId) return [];
  const all = includeInactive && roles.isAdmin(user);
  const { rows } = await pool.query(
    `SELECT ci.*, ac.name AS asset_category_name
       FROM catalogue_items ci LEFT JOIN asset_categories ac ON ac.id = ci.asset_category_id
      WHERE ci.service_unit_id = $1::bigint ${all ? '' : 'AND ci.is_active'}
      ORDER BY ci.sort_order, lower(ci.group_name) NULLS FIRST, lower(ci.name)`,
    [user.companyId]
  );
  return rows.map(toCatalogue);
}

async function catalogueFields(db, user, body, current = {}) {
  const name = 'name' in body ? clean(body.name) : current.name;
  if (!name || name.length < 2 || name.length > 120) throw bad('Give the item a name (2–120 characters).', 'bad_name');
  const kind = 'kind' in body ? clean(body.kind) : current.kind || 'physical';
  if (!KINDS.includes(kind)) throw bad('Choose item, supply, software or service.', 'bad_kind');
  const group = 'group' in body ? clean(body.group).slice(0, 60) || null : current.group_name ?? null;
  let price = 'price' in body ? body.price : current.price ?? null;
  if (price === '' || price == null) price = null;
  else {
    price = Number(price);
    if (!Number.isFinite(price) || price < 0 || price > 10000000) throw bad('Enter a price in rupees, or leave it empty.', 'bad_price');
    price = Math.round(price * 100) / 100;
  }
  let packSize = 'packSize' in body ? body.packSize : current.pack_size ?? null;
  if (packSize === '' || packSize == null) packSize = null;
  else {
    packSize = Number(packSize);
    if (!Number.isInteger(packSize) || packSize < 1 || packSize > 100000) throw bad('Pack size must be a whole number.', 'bad_pack');
  }
  const description = 'description' in body ? clean(body.description).slice(0, 300) || null : current.description ?? null;
  let assetCategoryId = 'assetCategoryId' in body ? body.assetCategoryId || null : current.asset_category_id ?? null;
  if (kind !== 'physical') assetCategoryId = null;
  if (assetCategoryId) {
    if (!isId(assetCategoryId)) throw bad('Choose an inventory category.', 'bad_category');
    const { rows } = await db.query(
      'SELECT id FROM asset_categories WHERE id = $1::bigint AND is_active AND service_unit_id = $2::bigint',
      [assetCategoryId, user.companyId]
    );
    if (!rows[0]) throw bad('Choose an inventory category.', 'bad_category');
  }
  const sortOrder = 'sortOrder' in body ? Number(body.sortOrder) : current.sort_order ?? 100;
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) throw bad('Order must be a whole number.', 'bad_order');
  if ('isActive' in body && typeof body.isActive !== 'boolean') throw bad('Bad status value.', 'invalid');
  const isActive = 'isActive' in body ? body.isActive : current.is_active ?? true;
  return { name, kind, description, assetCategoryId, sortOrder, isActive, group, price, packSize };
}

const nameTaken = (err) => err.code === '23505' ? new HttpError(409, 'An item with this name already exists.', 'duplicate') : err;

async function createCatalogueItem(user, body = {}) {
  const f = await catalogueFields(pool, user, body);
  const unitId = user.companyId;
  try {
    const { rows } = await pool.query(
      `INSERT INTO catalogue_items (name, kind, description, asset_category_id, sort_order, is_active, service_unit_id,
                                    group_name, price, pack_size)
       VALUES ($1::text, $2::text, $3::text, $4::bigint, $5::int, $6::boolean, $7::bigint, $8::text, $9::numeric, $10::int) RETURNING id`,
      [f.name, f.kind, f.description, f.assetCategoryId, f.sortOrder, f.isActive, unitId, f.group, f.price, f.packSize]
    );
    return (await listCatalogue(user, { includeInactive: true })).find((c) => c.id === String(rows[0].id));
  } catch (err) {
    throw nameTaken(err);
  }
}

async function updateCatalogueItem(user, id, body = {}) {
  if (!isId(id)) throw notFound();
  const { rows } = await pool.query('SELECT * FROM catalogue_items WHERE id = $1::bigint AND service_unit_id = $2::bigint', [id, user.companyId]);
  if (!rows[0]) throw notFound();
  const f = await catalogueFields(pool, user, body, rows[0]);
  try {
    await pool.query(
      `UPDATE catalogue_items SET name = $2::text, kind = $3::text, description = $4::text, asset_category_id = $5::bigint,
              sort_order = $6::int, is_active = $7::boolean, group_name = $8::text, price = $9::numeric, pack_size = $10::int,
              edited_in_atom_at = CASE WHEN source = 'supportlog' THEN now() ELSE edited_in_atom_at END
        WHERE id = $1::bigint`,
      [id, f.name, f.kind, f.description, f.assetCategoryId, f.sortOrder, f.isActive, f.group, f.price, f.packSize]
    );
  } catch (err) {
    throw nameTaken(err);
  }
  return (await listCatalogue(user, { includeInactive: true })).find((c) => c.id === String(id));
}

// ---------- stock (Admin) ----------
// body: { change: ±n } or { setTo: n }, reason (required). setTo on an untracked item starts tracking it.
async function adjustStock(user, id, body = {}) {
  if (!isId(id)) throw notFound();
  const reason = clean(body.reason);
  if (reason.length < 3 || reason.length > 500) throw bad('Say why the stock changes (3–500 characters).', 'reason_required');
  const hasChange = body.change !== undefined && body.change !== null && body.change !== '';
  const hasSet = body.setTo !== undefined && body.setTo !== null && body.setTo !== '';
  if (hasChange === hasSet) throw bad('Enter how many to add or remove, or the new count.', 'bad_stock');
  const n = Number(hasChange ? body.change : body.setTo);
  if (!Number.isInteger(n) || Math.abs(n) > 1000000) throw bad('Stock must be a whole number.', 'bad_stock');
  const changedId = await tickets.inTransaction(async (db) => {
    const { rows } = await db.query(
      'SELECT id, stock FROM catalogue_items WHERE id = $1::bigint AND service_unit_id = $2::bigint FOR UPDATE',
      [id, user.companyId]
    );
    const item = rows[0];
    if (!item) throw notFound();
    if (hasChange && item.stock == null) throw bad('Stock isn’t counted for this item yet — enter the current count first.', 'not_tracked');
    const before = item.stock ?? 0;
    const after = hasChange ? before + n : n;
    if (after < 0) throw bad(`Only ${before} in stock.`, 'negative_stock');
    await db.query('UPDATE catalogue_items SET stock = $2::int, stock_edited_at = now() WHERE id = $1::bigint', [item.id, after]);
    await db.query(
      `INSERT INTO stock_movements (catalogue_item_id, kind, change, stock_after, reason, actor_id)
       VALUES ($1::bigint, 'adjust', $2::int, $3::int, $4::text, $5::bigint)`,
      [item.id, after - before, after, reason, user.id]
    );
    return String(item.id);
  });
  return (await listCatalogue(user, { includeInactive: true })).find((c) => c.id === changedId);
}

// Latest stock movements of one item (Admin).
async function stockHistory(user, id) {
  if (!isId(id)) throw notFound();
  const { rows: own } = await pool.query('SELECT id FROM catalogue_items WHERE id = $1::bigint AND service_unit_id = $2::bigint', [id, user.companyId]);
  if (!own[0]) throw notFound();
  const { rows } = await pool.query(
    `SELECT m.id::text, m.kind, m.change, m.stock_after, m.reason, m.created_at,
            CASE WHEN u.id IS NULL THEN NULL ELSE COALESCE(u.name, 'Employee ' || u.employee_id) END AS by,
            CASE WHEN r.id IS NULL THEN NULL ELSE (CASE r.type WHEN 'SERVICE_REQUEST' THEN 'R-' ELSE 'T-' END || r.number) END AS request
       FROM stock_movements m
       LEFT JOIN users u ON u.id = m.actor_id
       LEFT JOIN request_items ri ON ri.id = m.request_item_id
       LEFT JOIN requests r ON r.id = ri.request_id
      WHERE m.catalogue_item_id = $1::bigint
      ORDER BY m.created_at DESC, m.id DESC LIMIT 50`,
    [id]
  );
  return rows.map((m) => ({ id: m.id, kind: m.kind, change: m.change, stockAfter: m.stock_after, reason: m.reason, at: m.created_at, by: m.by, request: m.request }));
}

// ---------- create ----------
// body: { items: [{ catalogueItemId?, name? (something else), quantity, reason }], location?, priority?, requesterId? }
async function createServiceRequest(user, body = {}) {
  const isAdmin = roles.isAdmin(user);
  if (!user.companyId) throw new HttpError(409, 'Choose a company first.', 'choose_company');
  const list = Array.isArray(body.items) ? body.items : [];
  if (!list.length) throw bad('Add at least one item.', 'no_items');
  if (list.length > MAX_ITEMS) throw bad(`Up to ${MAX_ITEMS} items in one request.`, 'too_many_items');
  const location = clean(body.location) || null;
  if (location && location.length > 200) throw bad('Keep the location under 200 characters.', 'bad_location');
  const priority = clean(body.priority).toUpperCase() || 'NORMAL';
  if (!(isAdmin ? tickets.ALL_PRIORITIES : tickets.REQUESTER_PRIORITIES).has(priority)) throw bad('Choose how urgent it is.', 'bad_priority');

  const { rows: catalogue } = await pool.query(
    'SELECT id, name, kind, price FROM catalogue_items WHERE is_active AND service_unit_id = $1::bigint',
    [user.companyId]
  );
  const byId = new Map(catalogue.map((c) => [String(c.id), c]));
  const items = list.map((raw, i) => {
    const n = i + 1;
    const quantity = Number(raw?.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw bad(`Item ${n}: quantity must be 1–50.`, 'bad_quantity');
    const reason = clean(raw?.reason);
    if (reason.length < 3 || reason.length > 1000) throw bad(`Item ${n}: say why you need it (3–1000 characters).`, 'bad_reason');
    if (raw?.catalogueItemId) {
      const c = byId.get(String(raw.catalogueItemId));
      if (!c) throw bad(`Item ${n} is not in the catalogue any more.`, 'bad_item');
      return { catalogueItemId: String(c.id), name: c.name, kind: c.kind, quantity, reason, unitPrice: c.price ?? null };
    }
    const name = clean(raw?.name);
    if (name.length < 2 || name.length > 200) throw bad(`Item ${n}: say what you need (2–200 characters).`, 'bad_name');
    return { catalogueItemId: null, name, kind: 'service', quantity, reason, unitPrice: null };
  });

  const label = (it) => `${it.name}${it.quantity > 1 ? ` ×${it.quantity}` : ''}`;
  let title = items.map(label).join(', ');
  if (title.length > 120) title = `${title.slice(0, 117)}…`;
  if (title.length < 3) title = `Request: ${title}`;
  const description = items.map((it) => `• ${label(it)} — ${it.reason}`).join('\n').slice(0, 5000);

  const created = await tickets.inTransaction(async (db, afterCommit) => {
    const serviceUnitId = user.companyId;
    let requesterId = String(user.id);
    if (body.requesterId && String(body.requesterId) !== String(user.id)) {
      if (!isAdmin) throw notFound();
      const person = await repo.getActiveUser(db, body.requesterId);
      if (!person) throw bad('Choose an active person to raise this for.', 'bad_requester');
      requesterId = String(person.id);
    }
    const { rows } = await db.query(
      `INSERT INTO requests (type, status, priority, title, description, location, service_unit_id, requester_id, raised_by_id)
       VALUES ('SERVICE_REQUEST', 'PENDING_APPROVAL', $1::request_priority, $2::text, $3::text, $4::text, $5::bigint, $6::bigint, $7::bigint)
       RETURNING id, number, service_unit_id`,
      [priority, title, description, location, serviceUnitId, requesterId, user.id]
    );
    const row = rows[0];
    const due = await timeFrames.setDue(db, row.id); // the clock starts when it is raised
    let order = 0;
    for (const it of items) {
      await db.query(
        `INSERT INTO request_items (request_id, catalogue_item_id, name, kind, quantity, reason, sort_order, unit_price)
         VALUES ($1::bigint, $2::bigint, $3::text, $4::text, $5::int, $6::text, $7::int, $8::numeric)`,
        [row.id, it.catalogueItemId, it.name, it.kind, it.quantity, it.reason, (order += 1), it.unitPrice]
      );
    }
    await repo.insertEvent(db, {
      requestId: row.id,
      type: 'created',
      actorId: user.id,
      toStatus: 'PENDING_APPROVAL',
      data: requesterId !== String(user.id) ? { raisedFor: requesterId } : null,
    });
    const ticket = {
      ...row, type: 'SERVICE_REQUEST', status: 'PENDING_APPROVAL', title, requester_id: requesterId, raised_by_id: user.id,
      assigned_engineer_id: null, due_by: due?.due_by, service_unit_name: user.company?.name,
    };
    const sent = await notifications.recordTicketEvent(db, ticket, { kind: 'created', actorId: user.id, raisedFor: requesterId !== String(user.id) });
    afterCommit(() => notifications.publish(sent, ticket));
    return row;
  });
  return tickets.getTicket(user, created.number);
}

// ---------- approve / reject items (Super Admin) ----------
// body: { decisions: [{ itemId, decision: 'approve' | 'reject', note? }] }
async function decideItems(user, numberParam, body = {}) {
  const decisions = Array.isArray(body.decisions) ? body.decisions : [];
  if (!decisions.length) throw bad('Choose approve or reject for at least one item.', 'no_decisions');
  const r = await tickets.inTransaction(async (db, afterCommit) => {
    const req = await tickets.loadInScope(db, { user }, numberParam, { forUpdate: true });
    if (req.type !== 'SERVICE_REQUEST' || !roles.isAdmin(user)) throw notFound();
    if (!lifecycle.canDecideItems(user, req)) {
      throw new HttpError(409, 'This request has moved on — refresh to see its current status.', 'wrong_status');
    }
    const { rows: items } = await db.query('SELECT * FROM request_items WHERE request_id = $1::bigint FOR UPDATE', [req.id]);
    const byId = new Map(items.map((i) => [String(i.id), i]));
    const seen = new Set();
    for (const d of decisions) {
      const item = byId.get(String(d?.itemId));
      if (!item || seen.has(String(item.id))) throw bad('Unknown item.', 'bad_item');
      seen.add(String(item.id));
      if (item.status !== 'PENDING') throw new HttpError(409, `“${item.name}” is already decided.`, 'already_decided');
      const note = clean(d.note);
      if (!['approve', 'reject'].includes(d.decision)) throw bad('Choose approve or reject.', 'bad_decision');
      if (d.decision === 'reject' && note.length < 3) throw bad(`Say why “${item.name}” is not approved.`, 'note_required');
      if (note.length > 1000) throw bad('Keep the note under 1000 characters.', 'note_too_long');
      const status = d.decision === 'approve' ? 'APPROVED' : 'REJECTED';
      await db.query(
        `UPDATE request_items SET status = $2::text, decision_note = $3::text, decided_by = $4::bigint, decided_at = now()
          WHERE id = $1::bigint`,
        [item.id, status, note || null, user.id]
      );
      item.status = status;
      await repo.insertEvent(db, {
        requestId: req.id,
        type: status === 'APPROVED' ? 'item_approved' : 'item_rejected',
        actorId: user.id,
        note: note || null,
        data: { itemId: String(item.id), name: item.name, quantity: item.quantity },
      });
    }

    if (items.some((i) => i.status === 'PENDING')) {
      await repo.touch(db, req.id);
      return req;
    }
    // All decided: approved → OPEN (to the Assign queue); none approved → REJECTED.
    const approved = items.filter((i) => i.status === 'APPROVED').length;
    const rejected = items.length - approved;
    const to = approved ? 'OPEN' : 'REJECTED';
    const summary = approved ? null : 'None of the items were approved.';
    await repo.updateStatus(db, req.id, { status: to, rejectionNote: summary });
    await repo.insertEvent(db, {
      requestId: req.id,
      type: 'status',
      actorId: user.id,
      fromStatus: req.status,
      toStatus: to,
      data: { action: approved ? 'approved' : 'all_rejected', approved, rejected },
    });
    const event = { kind: 'items_decided', actorId: user.id, approved, rejected };
    const sent = await notifications.recordTicketEvent(db, req, event);
    afterCommit(() => notifications.publish(sent, req));
    return req;
  });
  return tickets.getTicket(user, r.number);
}

// ---------- deliver an approved item (assigned engineer or Super Admin) ----------
// body: { note?, assetTags?: [] }  Physical items: hand over in-store assets, or explain in the note.
async function deliverItem(user, numberParam, itemId, body = {}) {
  const note = clean(body.note);
  if (note.length > 1000) throw bad('Keep the note under 1000 characters.', 'note_too_long');
  const tags = [...new Set((Array.isArray(body.assetTags) ? body.assetTags : []).map((t) => clean(t)).filter(Boolean))];
  if (tags.length > MAX_ASSETS) throw bad('Too many assets.', 'too_many_assets');

  const r = await tickets.inTransaction(async (db, afterCommit) => {
    const req = await tickets.loadInScope(db, { user }, numberParam, { forUpdate: true });
    if (req.type !== 'SERVICE_REQUEST') throw notFound();
    if (!lifecycle.canDeliverItems(user, req)) {
      const worker = roles.isAdmin(user) || (user.activeRole === 'ENGINEER' && String(req.assigned_engineer_id) === String(user.id));
      if (worker) throw new HttpError(409, 'Start work on this request before delivering items.', 'wrong_status');
      throw notFound();
    }
    if (!isId(itemId)) throw notFound();
    const { rows: found } = await db.query('SELECT * FROM request_items WHERE id = $1::bigint AND request_id = $2::bigint FOR UPDATE', [itemId, req.id]);
    const item = found[0];
    if (!item) throw notFound();
    if (item.status !== 'APPROVED') throw new HttpError(409, `“${item.name}” is ${item.status === 'DELIVERED' ? 'already delivered' : 'not approved'}.`, 'wrong_item_status');
    if (tags.length > item.quantity) throw bad(`Only ${item.quantity} requested.`, 'too_many_assets');
    if (item.kind === 'physical' && !tags.length && note.length < 3) {
      throw bad('Choose the asset(s) handed over, or explain in the note (e.g. bought new, not in inventory yet).', 'assets_or_note');
    }
    if (item.kind !== 'physical' && tags.length) throw bad('Assets are handed over only for physical items.', 'not_physical');

    // Supplies come out of stock (when the item's stock is counted): never below zero.
    let stockAfter = null;
    if (item.kind === 'supply' && item.catalogue_item_id) {
      const { rows: ci } = await db.query('SELECT id, name, stock FROM catalogue_items WHERE id = $1::bigint FOR UPDATE', [item.catalogue_item_id]);
      if (ci[0] && ci[0].stock != null) {
        if (ci[0].stock < item.quantity) {
          throw new HttpError(409, `Only ${ci[0].stock} of “${item.name}” in stock — add stock in the Catalogue first.`, 'not_enough_stock');
        }
        stockAfter = ci[0].stock - item.quantity;
        await db.query('UPDATE catalogue_items SET stock = $2::int, stock_edited_at = now() WHERE id = $1::bigint', [ci[0].id, stockAfter]);
        await db.query(
          `INSERT INTO stock_movements (catalogue_item_id, kind, change, stock_after, reason, request_item_id, actor_id)
           VALUES ($1::bigint, 'delivery', $2::int, $3::int, $4::text, $5::bigint, $6::bigint)`,
          [ci[0].id, -item.quantity, stockAfter, `Delivered for ${tickets.displayNumber(req)}`, item.id, user.id]
        );
      }
    }

    const display = tickets.displayNumber(req);
    const handed = [];
    for (const tag of tags) {
      const { rows: a } = await db.query(
        `SELECT id, asset_tag, status, holder_user_id, source FROM assets
          WHERE upper(asset_tag) = upper($1::text) AND service_unit_id = $2::bigint FOR UPDATE`,
        [tag, req.service_unit_id]
      );
      const asset = a[0];
      if (!asset) throw bad(`Asset ${tag} not found.`, 'bad_asset');
      if (asset.status !== 'IN_STORE' || asset.holder_user_id) throw new HttpError(409, `${asset.asset_tag} is not in store.`, 'asset_not_in_store');
      await db.query(`UPDATE assets SET holder_user_id = $2::bigint, holder_unknown = FALSE, status = 'IN_USE' WHERE id = $1::bigint`, [asset.id, req.requester_id]);
      if (asset.source === 'snipeit') await db.query('UPDATE assets SET edited_in_atom_at = now() WHERE id = $1::bigint', [asset.id]);
      await db.query(
        `INSERT INTO asset_events (asset_id, type, actor_id, note, data) VALUES ($1::bigint, 'assigned', $2::bigint, $3::text, $4::jsonb)`,
        [asset.id, user.id, `Delivered for ${display}`,
          JSON.stringify({ to: { id: String(req.requester_id), name: req.requester?.name || null }, from: null, request: display })]
      );
      await db.query('INSERT INTO request_item_assets (request_item_id, asset_id) VALUES ($1::bigint, $2::bigint)', [item.id, asset.id]);
      handed.push(asset.asset_tag);
    }
    await db.query(
      `UPDATE request_items SET status = 'DELIVERED', delivery_note = $2::text, delivered_by = $3::bigint, delivered_at = now() WHERE id = $1::bigint`,
      [item.id, note || null, user.id]
    );
    await repo.insertEvent(db, {
      requestId: req.id,
      type: 'item_delivered',
      actorId: user.id,
      note: note || null,
      data: { itemId: String(item.id), name: item.name, assets: handed, ...(stockAfter != null ? { fromStock: item.quantity, stockLeft: stockAfter } : {}) },
    });
    let sent = await notifications.recordTicketEvent(db, req, { kind: 'item_delivered', actorId: user.id, itemName: item.name, note });

    const { rows: left } = await db.query(`SELECT count(*)::int AS n FROM request_items WHERE request_id = $1::bigint AND status = 'APPROVED'`, [req.id]);
    if (left[0].n === 0) {
      await repo.updateStatus(db, req.id, { status: 'RESOLVED', resolution: 'All approved items delivered.' });
      await repo.insertEvent(db, { requestId: req.id, type: 'status', actorId: user.id, fromStatus: req.status, toStatus: 'RESOLVED', data: { action: 'delivered' } });
      sent = [...sent, ...(await notifications.recordTicketEvent(db, req, { kind: 'resolve', actorId: user.id }))];
    } else {
      await repo.touch(db, req.id);
    }
    afterCommit(() => notifications.publish(sent, req));
    return req;
  });
  return tickets.getTicket(user, r.number);
}

module.exports = {
  listCatalogue,
  createCatalogueItem,
  updateCatalogueItem,
  adjustStock,
  stockHistory,
  createServiceRequest,
  decideItems,
  deliverItem,
  KINDS,
};
