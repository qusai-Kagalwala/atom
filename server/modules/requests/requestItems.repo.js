// SQL for service-request items and the catalogue (Phase 9). Functions take `db`.
async function listItems(db, requestId) {
  const { rows } = await db.query(
    `SELECT i.id::text AS id, i.catalogue_item_id::text AS catalogue_item_id, i.name, i.kind, i.quantity, i.reason, i.status,
            i.decision_note, i.decided_at, i.delivery_note, i.delivered_at,
            c.asset_category_id::text AS asset_category_id, i.unit_price, c.stock AS stock_now, c.pack_size,
            CASE WHEN d.id IS NULL THEN NULL ELSE COALESCE(d.name, 'Employee ' || d.employee_id) END AS decided_by_name,
            CASE WHEN v.id IS NULL THEN NULL ELSE COALESCE(v.name, 'Employee ' || v.employee_id) END AS delivered_by_name,
            (SELECT COALESCE(json_agg(json_build_object('tag', a.asset_tag, 'name', COALESCE(a.name, concat_ws(' ', a.manufacturer, a.model)))
                                      ORDER BY a.asset_tag), '[]')
               FROM request_item_assets x JOIN assets a ON a.id = x.asset_id WHERE x.request_item_id = i.id) AS assets
       FROM request_items i
       LEFT JOIN catalogue_items c ON c.id = i.catalogue_item_id
       LEFT JOIN users d ON d.id = i.decided_by
       LEFT JOIN users v ON v.id = i.delivered_by
      WHERE i.request_id = $1::bigint
      ORDER BY i.sort_order, i.id`,
    [requestId]
  );
  return rows;
}

const toItem = (i) => ({
  id: i.id,
  catalogueItemId: i.catalogue_item_id,
  name: i.name,
  kind: i.kind,
  quantity: i.quantity,
  reason: i.reason,
  status: i.status,
  decisionNote: i.decision_note,
  decidedAt: i.decided_at,
  decidedBy: i.decided_by_name,
  deliveryNote: i.delivery_note,
  deliveredAt: i.delivered_at,
  deliveredBy: i.delivered_by_name,
  assetCategoryId: i.asset_category_id,
  unitPrice: i.unit_price == null ? null : Number(i.unit_price),
  stock: i.stock_now ?? null,
  packSize: i.pack_size ?? null,
  assets: i.assets || [],
});

module.exports = { listItems, toItem };
