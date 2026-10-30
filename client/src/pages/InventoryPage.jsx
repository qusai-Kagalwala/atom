import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CircleAlert, Download, FileUp, LoaderCircle, Package, Plus, Search } from 'lucide-react';
import { createAsset, exportInventory, listAssetCategories, listAssets } from '../api/inventory';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import { CategoriesTab, PlacesTab, PlacePicker } from '../components/InventorySetup';
import Modal from '../components/Modal';
import { Pager, Tabs } from '../components/RequestList';
import useAuth from '../hooks/useAuth';
import { isAdminRole, roleLabel } from '../utils/roles';
import { ASSET_STATUS, assetTitle, assetWhere, statusClass, statusLabel } from '../utils/assets';

const selectClass =
  'min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';
const PAGE_SIZE = 50;

function AddAssetModal({ categories, onClose, onDone }) {
  const [f, setF] = useState({ tag: '', categoryId: '', manufacturer: '', model: '', serial: '' });
  const [place, setPlace] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save() {
    if (!f.tag.trim() || !f.categoryId) return setError('Enter the asset tag and choose a category.');
    setBusy(true);
    setError('');
    try {
      onDone(await createAsset({ ...f, placeId: place?.id }));
    } catch (err) {
      setError(errorMessage(err, 'Could not add the asset.'));
      setBusy(false);
    }
    return undefined;
  }

  return (
    <Modal
      title="Add an asset"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy}>
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Add asset
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <p className="font-ui text-sm text-ink-2">For equipment that isn't in Snipe-IT. Imports never overwrite assets added here.</p>
        <Field id="a-tag" label="Asset tag">
          <TextInput id="a-tag" value={f.tag} onChange={set('tag')} maxLength={60} placeholder="AJSM-…" />
        </Field>
        <Field id="a-cat" label="Category">
          <select id="a-cat" className={selectClass} value={f.categoryId} onChange={set('categoryId')}>
            <option value="">Choose a category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="a-man" label="Manufacturer">
            <TextInput id="a-man" value={f.manufacturer} onChange={set('manufacturer')} maxLength={80} />
          </Field>
          <Field id="a-model" label="Model">
            <TextInput id="a-model" value={f.model} onChange={set('model')} maxLength={120} />
          </Field>
        </div>
        <Field id="a-serial" label="Serial">
          <TextInput id="a-serial" value={f.serial} onChange={set('serial')} maxLength={80} />
        </Field>
        <PlacePicker value={place} onChange={setPlace} label="Place (optional)" />
      </div>
    </Modal>
  );
}

function AssetsTab({ isAdmin }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') || '');
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState(null);
  const f = {
    q: params.get('q') || '',
    status: params.get('status') || '',
    categoryId: params.get('categoryId') || '',
    attention: params.get('attention') || '',
    room: params.get('room') || '',
    page: Number(params.get('page')) || 1,
  };
  const set = (patch) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      if (!('page' in patch)) next.delete('page');
      return next;
    });

  useEffect(() => {
    const t = setTimeout(() => {
      if (search.trim() !== f.q) set({ q: search.trim() });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const query = useQuery({
    queryKey: ['inventory', 'assets', f],
    queryFn: () =>
      listAssets({
        q: f.q || undefined, status: f.status || undefined, categoryId: f.categoryId || undefined,
        attention: f.attention || undefined, room: f.room || undefined, page: f.page, pageSize: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });
  const categories = useQuery({ queryKey: ['inventory', 'categories'], queryFn: listAssetCategories, staleTime: 5 * 60_000 });
  const attention = useQuery({ queryKey: ['inventory', 'assets', 'attention-count'], queryFn: () => listAssets({ attention: 'any', pageSize: 1 }) });
  const items = query.data?.assets || [];
  const from = `/inventory${params.toString() ? `?${params}` : ''}`;

  return (
    <div className="space-y-4">
      {attention.data?.total > 0 && f.attention !== 'any' && (
        <button type="button" onClick={() => set({ attention: 'any' })} className="w-full text-left">
          <Alert tone="info">
            <strong>{attention.data.total} assets need attention</strong> — serial needs checking, or in use but the person is not known yet. Show them →
          </Alert>
        </button>
      )}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="relative sm:col-span-2">
          <span className="sr-only">Search assets</span>
          <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tag, serial, model, place, room or person"
            className="block min-h-tap w-full rounded-btn border border-line bg-white pl-10 pr-3 font-ui text-sm text-ink placeholder:text-ink-3 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
          />
        </label>
        <select aria-label="Status" className={selectClass} value={f.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">Not retired</option>
          {Object.entries(ASSET_STATUS).map(([k, s]) => (
            <option key={k} value={k}>
              {s.label}
            </option>
          ))}
          <option value="all">Everything</option>
        </select>
        <select aria-label="Category" className={selectClass} value={f.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
          <option value="">Any category</option>
          {(categories.data || []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.assets})
            </option>
          ))}
        </select>
        <select aria-label="Needs attention" className={selectClass} value={f.attention} onChange={(e) => set({ attention: e.target.value })}>
          <option value="">All assets</option>
          <option value="any">Needs attention</option>
          <option value="serial">Serial needs checking</option>
          <option value="holder">Person not known yet</option>
        </select>
        {f.room && (
          <button type="button" className="btn-secondary" onClick={() => set({ room: '' })}>
            Room {f.room} ×
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex min-h-[1.25rem] items-center gap-2 font-ui text-sm text-ink-2" aria-live="polite">
          {query.isFetching && <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />}
          {query.isSuccess && `${query.data.total} ${query.data.total === 1 ? 'asset' : 'assets'}`}
        </p>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={exporting}
              onClick={async () => {
                setExporting(true);
                setExportMsg(null);
                try {
                  const r = await exportInventory({
                    q: f.q || undefined, status: f.status || undefined, categoryId: f.categoryId || undefined,
                    attention: f.attention || undefined, room: f.room || undefined,
                  });
                  setExportMsg({ tone: 'success', text: `${r.name} downloaded${r.rows != null ? ` (${r.rows} assets)` : ''}. Edit the white columns, then use “Import inventory file”.` });
                } catch (err) {
                  setExportMsg({ tone: 'error', text: errorMessage(err, 'Could not export.') });
                } finally {
                  setExporting(false);
                }
              }}
            >
              {exporting ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Download size={16} aria-hidden="true" />} Export
              {query.isSuccess && ` (${query.data.total})`}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>
              <Plus size={16} aria-hidden="true" /> Add asset
            </button>
          </div>
        )}
      </div>

      {exportMsg && <Alert tone={exportMsg.tone}>{exportMsg.text}</Alert>}
      {query.isError && <Alert tone="error">Could not load assets.</Alert>}
      {query.isSuccess && !items.length && (
        <div className="card text-center">
          <Package size={24} className="mx-auto text-ink-3" aria-hidden="true" />
          <p className="mt-2 font-ui font-medium">No assets match</p>
          {isAdmin && <p className="mt-1 font-ui text-sm text-ink-2">Import the Snipe-IT CSV to load the inventory.</p>}
        </div>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-white">
          {items.map((a) => (
            <li key={a.id}>
              <Link to={`/inventory/assets/${encodeURIComponent(a.tag)}`} state={{ from }} className="flex items-start gap-3 px-4 py-3 font-ui hover:bg-gold-muted focus-visible:bg-gold-muted">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium tabular-nums text-ink">{a.tag}</span>
                    <span className="truncate text-sm text-ink-2">{assetTitle(a)}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-ink-3">
                    {a.category.name} · {assetWhere(a)}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className={`${statusClass(a.status)} whitespace-nowrap`}>{statusLabel(a.status)}</span>
                  {(a.serialNeedsCheck || a.holderUnknown) && (
                    <span className="flex items-center gap-1 text-xs text-warning">
                      <CircleAlert size={12} aria-hidden="true" /> {a.serialNeedsCheck ? 'Check serial' : 'Person not known'}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {query.data && <Pager page={f.page} total={query.data.total} pageSize={PAGE_SIZE} onPage={(p) => set({ page: String(p) })} />}

      {adding && (
        <AddAssetModal
          categories={categories.data || []}
          onClose={() => setAdding(false)}
          onDone={(asset) => navigate(`/inventory/assets/${encodeURIComponent(asset.tag)}`, { state: { from, notice: `${asset.tag} added.` } })}
        />
      )}
    </div>
  );
}

const TABS = [
  ['assets', 'Assets'],
  ['places', 'Places'],
  ['categories', 'Categories'],
];

// The company's Admin manages; Staff read. Each company has its own inventory.
export default function InventoryPage() {
  const { user } = useAuth();
  const isAdmin = isAdminRole(user.activeRole);
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'assets';

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">{user.company?.name} · {isAdmin ? 'Admin' : roleLabel(user.activeRole, user)}</p>
          <h1 className="mt-1 text-3xl">Inventory</h1>
          <p className="mt-1 font-ui text-sm text-ink-2">
            Every asset of {user.company?.name || 'this company'}, where it is and who has it.{!isAdmin && ' Read only.'}
          </p>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <Link to="/inventory/import-file" className="btn-secondary">
              <FileUp size={18} aria-hidden="true" /> Import inventory file
            </Link>
            <Link to="/inventory/import" className="btn-primary">
              <FileUp size={18} aria-hidden="true" /> Import from Snipe-IT
            </Link>
          </div>
        )}
      </div>
      <Tabs tabs={TABS} value={tab} onChange={(v) => setParams(v === 'assets' ? {} : { tab: v })} />
      {tab === 'assets' && <AssetsTab isAdmin={isAdmin} />}
      {tab === 'places' && <PlacesTab isAdmin={isAdmin} />}
      {tab === 'categories' && <CategoriesTab isAdmin={isAdmin} />}
    </section>
  );
}
