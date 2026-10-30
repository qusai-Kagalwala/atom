import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History, LoaderCircle, Package, Pencil, Plus, Search } from 'lucide-react';
import { adjustStock, createCatalogueItem, listCatalogue, stockHistory, updateCatalogueItem } from '../api/requests';
import { listAssetCategories } from '../api/inventory';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import Modal from '../components/Modal';
import { formatDateTime } from '../utils/format';
import { ITEM_KINDS } from '../utils/requests';

const selectClass =
  'min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';
const KIND_HINT = {
  physical: 'Delivered by handing over an asset from Inventory.',
  software: 'Delivered with a note (e.g. licence sent by email).',
  service: 'Delivered with a note (e.g. account created).',
  supply: 'Handed over from stock (e.g. stationery). Delivery takes it off the stock count.',
};
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const MOVE_LABEL = { sync: 'Support Log sync', adjust: 'Changed by hand', delivery: 'Delivered' };

// Stock of one item: change it (with a reason) and see the history.
function StockModal({ item, onClose, onSaved }) {
  const history = useQuery({ queryKey: ['catalogue', 'stock', item.id], queryFn: () => stockHistory(item.id) });
  const tracked = item.stock != null;
  const [mode, setMode] = useState(tracked ? 'add' : 'set'); // add · remove · set
  const [n, setN] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    const num = Number(n);
    const body = mode === 'set' ? { setTo: num, reason } : { change: mode === 'add' ? num : -num, reason };
    try {
      onSaved(await adjustStock(item.id, body));
    } catch (err) {
      setError(errorMessage(err, 'Could not change the stock.'));
      setBusy(false);
    }
  }

  const valid = n !== '' && Number.isInteger(Number(n)) && Number(n) >= 0 && reason.trim().length >= 3;
  return (
    <Modal
      title={`Stock · ${item.name}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy || !valid}>
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <p className="font-ui text-sm text-ink">
          In stock now: <span className="font-medium tabular-nums">{tracked ? item.stock : 'not counted'}</span>
          {item.packSize > 1 && <span className="text-ink-3"> · {item.packSize} per pack</span>}
        </p>
        <div className="flex flex-wrap gap-x-5 gap-y-2 font-ui text-sm">
          {(tracked ? [['add', 'Add'], ['remove', 'Remove'], ['set', 'Set the count']] : [['set', 'Set the count']]).map(([k, label]) => (
            <label key={k} className="flex min-h-tap items-center gap-2">
              <input type="radio" name="stock-mode" className="h-4 w-4 accent-primary" checked={mode === k} onChange={() => setMode(k)} />
              {label}
            </label>
          ))}
        </div>
        <Field id="st-n" label={mode === 'set' ? 'New count (pieces)' : 'How many pieces'}>
          <TextInput id="st-n" type="number" min="0" step="1" inputMode="numeric" value={n} onChange={(e) => setN(e.target.value)} />
        </Field>
        <Field id="st-reason" label="Reason" hint="e.g. New purchase received, counted the cupboard.">
          <TextInput id="st-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        <div>
          <h3 className="flex items-center gap-1 font-ui text-sm font-medium text-ink">
            <History size={16} aria-hidden="true" /> History
          </h3>
          {history.isPending && <LoaderCircle size={16} className="mt-2 animate-spin text-ink-3" aria-label="Loading" />}
          {history.data?.length === 0 && <p className="mt-1 font-ui text-xs text-ink-3">No changes yet.</p>}
          {history.data?.length > 0 && (
            <ul className="mt-2 max-h-56 divide-y divide-line overflow-y-auto font-ui text-xs">
              {history.data.map((m) => (
                <li key={m.id} className="py-1.5">
                  <span className={`tabular-nums font-medium ${m.change < 0 ? 'text-error' : 'text-success'}`}>
                    {m.change > 0 ? `+${m.change}` : m.change}
                  </span>{' '}
                  → {m.stockAfter} · {MOVE_LABEL[m.kind] || m.kind}
                  {m.request && ` (${m.request})`}
                  <span className="block text-ink-3">
                    {formatDateTime(m.at)}
                    {m.by && ` · ${m.by}`}
                    {m.reason && ` · ${m.reason}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ItemModal({ item, onClose, onSaved }) {
  const categories = useQuery({ queryKey: ['inventory', 'categories'], queryFn: listAssetCategories, staleTime: 5 * 60_000 });
  const [f, setF] = useState({
    name: item?.name || '',
    kind: item?.kind || 'physical',
    description: item?.description || '',
    assetCategoryId: item?.assetCategory?.id || '',
    sortOrder: item?.sortOrder ?? 100,
    isActive: item?.isActive ?? true,
    group: item?.group || '',
    price: item?.price ?? '',
    packSize: item?.packSize ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function save() {
    setBusy(true);
    setError('');
    const body = {
      ...f,
      sortOrder: Number(f.sortOrder),
      assetCategoryId: f.kind === 'physical' ? f.assetCategoryId || null : null,
      price: f.price === '' ? null : Number(f.price),
      packSize: f.packSize === '' ? null : Number(f.packSize),
    };
    try {
      onSaved(item ? await updateCatalogueItem(item.id, body) : await createCatalogueItem(body));
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={item ? `Edit ${item.name}` : 'Add a catalogue item'}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy}>
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Field id="ci-name" label="Name">
          <TextInput id="ci-name" value={f.name} onChange={set('name')} maxLength={120} placeholder="e.g. Office 365" />
        </Field>
        <Field id="ci-kind" label="Type" hint={KIND_HINT[f.kind]}>
          <select id="ci-kind" className={selectClass} value={f.kind} onChange={set('kind')}>
            <option value="physical">Item (equipment)</option>
            <option value="software">Software</option>
            <option value="service">Service</option>
            <option value="supply">Supply (from stock)</option>
          </select>
        </Field>
        <Field id="ci-group" label="Group (optional)" hint="e.g. Stationery. Groups the list on the Request page.">
          <TextInput id="ci-group" value={f.group} onChange={set('group')} maxLength={60} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="ci-price" label="Approx. price, ₹ (optional)" hint="Per piece.">
            <TextInput id="ci-price" type="number" min="0" step="0.01" inputMode="decimal" value={f.price} onChange={set('price')} />
          </Field>
          <Field id="ci-pack" label="Pack size (optional)" hint="Pieces in one pack. Stock and requests count pieces.">
            <TextInput id="ci-pack" type="number" min="1" step="1" inputMode="numeric" value={f.packSize} onChange={set('packSize')} />
          </Field>
        </div>
        {item?.source === 'supportlog' && (
          <p className="font-ui text-xs text-ink-3">From the Support Log. Your changes are kept when it is synced again (unless the Super Admin overwrites them).</p>
        )}
        {f.kind === 'physical' && (
          <Field id="ci-cat" label="Inventory category (optional)" hint="Delivery then suggests in-store assets of this category.">
            <select id="ci-cat" className={selectClass} value={f.assetCategoryId} onChange={set('assetCategoryId')}>
              <option value="">Any category</option>
              {(categories.data || []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field id="ci-desc" label="Short description (optional)">
          <TextInput id="ci-desc" value={f.description} onChange={set('description')} maxLength={300} />
        </Field>
        <Field id="ci-order" label="Order" hint="Lower numbers show first.">
          <TextInput id="ci-order" type="number" min="0" step="10" value={f.sortOrder} onChange={set('sortOrder')} />
        </Field>
        {item && (
          <label className="flex min-h-tap items-center gap-2 font-ui text-sm">
            <input type="checkbox" checked={f.isActive} onChange={set('isActive')} className="h-5 w-5 rounded border-line text-primary" />
            Offered (shown on the Request page)
          </label>
        )}
      </div>
    </Modal>
  );
}

// Super Admin: what staff can request. Items are switched off, never deleted.
export default function CataloguePage() {
  const queryClient = useQueryClient();
  const items = useQuery({ queryKey: ['catalogue', 'all'], queryFn: () => listCatalogue(true) });
  const [editing, setEditing] = useState(null); // null · 'new' · item
  const [stockOf, setStockOf] = useState(null);
  const [notice, setNotice] = useState('');
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('');
  const groups = useMemo(() => [...new Set((items.data || []).map((c) => c.group).filter(Boolean))].sort(), [items.data]);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (items.data || []).filter((c) => (!group || c.group === group) && (!term || `${c.name} ${c.group || ''}`.toLowerCase().includes(term)));
  }, [items.data, q, group]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Admin</p>
          <h1 className="mt-1 text-3xl">Catalogue</h1>
          <p className="mt-1 font-ui text-sm text-ink-2">What staff can pick on the Request page. They can always type “something else” too.</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
          <Plus size={18} aria-hidden="true" /> Add item
        </button>
      </div>
      {notice && <Alert tone="success">{notice}</Alert>}
      {items.isPending && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
      {items.isError && <Alert tone="error">Could not load the catalogue.</Alert>}
      {items.data?.length > 6 && (
        <div className="flex flex-wrap gap-2">
          <label className="relative min-w-0 flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
            <span className="sr-only">Search the catalogue</span>
            <input
              type="search"
              className="min-h-tap w-full rounded-btn border border-line bg-white pl-9 pr-3 font-ui text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
              placeholder="Search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          {groups.length > 0 && (
            <select aria-label="Group" className={selectClass.replace('w-full', 'w-auto')} value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">All groups</option>
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {items.data?.length > 0 && shown.length === 0 && <p className="font-ui text-sm text-ink-3">Nothing matches.</p>}
      {shown.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-white font-ui text-sm">
          {shown.map((c) => (
            <li key={c.id} className={`flex items-center gap-3 px-4 py-3 ${c.isActive ? '' : 'opacity-60'}`}>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-ink">
                  {c.name} {!c.isActive && <span className="badge ml-1 bg-cream-dark text-ink-3">Off</span>}
                </span>
                <span className="block text-xs text-ink-3">
                  {c.group && `${c.group} · `}
                  {ITEM_KINDS[c.kind]}
                  {c.price != null && ` · approx. ${rupees(c.price)}`}
                  {c.packSize > 1 && ` · pack of ${c.packSize}`}
                  {c.stock != null && ` · ${c.stock} in stock`}
                  {c.assetCategory && ` · from Inventory: ${c.assetCategory.name}`}
                  {c.description && ` · ${c.description}`}
                </span>
              </span>
              {c.kind === 'supply' && (
                <button type="button" className="btn-secondary shrink-0" onClick={() => setStockOf(c)} aria-label={`Stock of ${c.name}`}>
                  <Package size={16} aria-hidden="true" /> Stock
                </button>
              )}
              <button type="button" className="btn-secondary shrink-0" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                <Pencil size={16} aria-hidden="true" /> Edit
              </button>
            </li>
          ))}
        </ul>
      )}
      {stockOf && (
        <StockModal
          item={stockOf}
          onClose={() => setStockOf(null)}
          onSaved={(saved) => {
            setStockOf(null);
            setNotice(`Stock of ${saved.name} is now ${saved.stock}.`);
            queryClient.invalidateQueries({ queryKey: ['catalogue'] });
          }}
        />
      )}
      {editing && (
        <ItemModal
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setNotice(`${saved.name} saved.`);
            queryClient.invalidateQueries({ queryKey: ['catalogue'] });
          }}
        />
      )}
    </section>
  );
}
