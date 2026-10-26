// Asset display helpers (Phase 8).
export const ASSET_STATUS = {
  IN_STORE: { label: 'In store', cls: 'asset-available' },
  IN_USE: { label: 'In use', cls: 'asset-assigned' },
  IN_REPAIR: { label: 'In repair', cls: 'asset-repair' },
  RETIRED: { label: 'Retired', cls: 'asset-retired' },
};

export const statusLabel = (s) => ASSET_STATUS[s]?.label || s;
export const statusClass = (s) => ASSET_STATUS[s]?.cls || 'badge';

// "Asset name" or "Manufacturer Model"
export const assetTitle = (a) => a.name || [a.manufacturer, a.model].filter(Boolean).join(' ') || a.tag;

// Who / where: "Alice Hamid", "Holder unknown · AV Store Room", "MCR-Video"
export function assetWhere(a) {
  const parts = [];
  if (a.holder) parts.push(a.holder.name);
  else if (a.holderUnknown) parts.push('Holder unknown');
  if (a.place) parts.push(a.place.name);
  return parts.join(' · ') || 'No place';
}

const FIELD_LABELS = {
  name: 'name', category_id: 'category', manufacturer: 'manufacturer', model: 'model', model_no: 'model no.',
  serial: 'serial', serial_needs_check: 'serial check', mac_address: 'MAC', ip_address: 'IP', purchased_on: 'purchase date',
  order_number: 'order number', supplier: 'supplier', notes: 'notes', status: 'status', place_id: 'place',
  holder_unknown: 'holder', holder_user_id: 'holder',
};
const fields = (list) => [...new Set((list || []).map((f) => FIELD_LABELS[f] || f))].join(', ');

// One line for a history entry.
export function assetEventText(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'imported':
      return 'Imported from Snipe-IT';
    case 'reimported':
      return `Updated from Snipe-IT: ${fields(d.changed) || 'details'}`;
    case 'created':
      return 'Added in ATOM';
    case 'edited':
      return d.merged ? `Category merged: ${d.merged.from} → ${d.merged.into}` : `Edited: ${fields(d.fields)}`;
    case 'moved':
      return `Moved${d.from ? ` from ${d.from.name}` : ''} to ${d.to?.name}`;
    case 'assigned':
      return `Assigned to ${d.to?.name}${d.from ? ` (was ${d.from.name})` : ''}`;
    case 'returned':
      return `Returned${d.from ? ` by ${d.from.name}` : ''}${d.to ? ` to ${d.to.name}` : ''}`;
    case 'status':
      return `Status: ${statusLabel(d.from)} → ${statusLabel(d.to)}`;
    default:
      return e.type;
  }
}
