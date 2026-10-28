import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Pencil, Plus } from 'lucide-react';
import { createCatalogueItem, listCatalogue, updateCatalogueItem } from '../api/requests';
import { listAssetCategories } from '../api/inventory';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import Modal from '../components/Modal';
import { ITEM_KINDS } from '../utils/requests';

const selectClass =
  'min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';
const KIND_HINT = {
  physical: 'Delivered by handing over an asset from Inventory.',
  software: 'Delivered with a note (e.g. licence sent by email).',
  service: 'Delivered with a note (e.g. account created).',
};

function ItemModal({ item, onClose, onSaved }) {
  const categories = useQuery({ queryKey: ['inventory', 'categories'], queryFn: listAssetCategories, staleTime: 5 * 60_000 });
  const [f, setF] = useState({
    name: item?.name || '',
    kind: item?.kind || 'physical',
    description: item?.description || '',
    assetCategoryId: item?.assetCategory?.id || '',
    sortOrder: item?.sortOrder ?? 100,
    isActive: item?.isActive ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function save() {
    setBusy(true);
    setError('');
    const body = { ...f, sortOrder: Number(f.sortOrder), assetCategoryId: f.kind === 'physical' ? f.assetCategoryId || null : null };
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
          <TextInput id="ci-name" value={f.name} onChange={set('name')} maxLength={80} placeholder="e.g. Office 365" />
        </Field>
        <Field id="ci-kind" label="Type" hint={KIND_HINT[f.kind]}>
          <select id="ci-kind" className={selectClass} value={f.kind} onChange={set('kind')}>
            <option value="physical">Item (equipment)</option>
            <option value="software">Software</option>
            <option value="service">Service</option>
          </select>
        </Field>
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
  const [notice, setNotice] = useState('');

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Super Admin</p>
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
      {items.data?.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-white font-ui text-sm">
          {items.data.map((c) => (
            <li key={c.id} className={`flex items-center gap-3 px-4 py-3 ${c.isActive ? '' : 'opacity-60'}`}>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-ink">
                  {c.name} {!c.isActive && <span className="badge ml-1 bg-cream-dark text-ink-3">Off</span>}
                </span>
                <span className="block text-xs text-ink-3">
                  {ITEM_KINDS[c.kind]}
                  {c.assetCategory && ` · from Inventory: ${c.assetCategory.name}`}
                  {c.description && ` · ${c.description}`}
                </span>
              </span>
              <button type="button" className="btn-secondary shrink-0" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                <Pencil size={16} aria-hidden="true" /> Edit
              </button>
            </li>
          ))}
        </ul>
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
