import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitMerge, LoaderCircle, MapPin, Pencil, Plus, Search, X } from 'lucide-react';
import {
  createAssetCategory,
  createPlace,
  listAssetCategories,
  listPlaces,
  mergeAssetCategory,
  renameAssetCategory,
  updatePlace,
} from '../api/inventory';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from './FormControls';
import Modal from './Modal';
import { Pager } from './RequestList';

const selectClass =
  'min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';

function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// Search-and-pick a place. value = { id, name, detail } | null
export function PlacePicker({ value, onChange, label = 'Place' }) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const query = useQuery({ queryKey: ['inventory', 'places', 'pick', q], queryFn: () => listPlaces({ q: q || undefined, pageSize: 8 }), enabled: !value });

  if (value) {
    return (
      <div>
        <p className="mb-1.5 font-ui text-sm font-medium text-ink">{label}</p>
        <div className="flex items-center gap-2 rounded-btn border border-line bg-cream-dark px-3 py-2 font-ui text-sm">
          <MapPin size={16} className="shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ink">{value.name}</span>
            {value.detail && <span className="block truncate text-xs text-ink-3">{value.detail}</span>}
          </span>
          <button type="button" onClick={() => onChange(null)} className="flex min-h-tap min-w-tap items-center justify-center text-ink-3 hover:text-ink" aria-label="Change place">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <label htmlFor="place-search" className="mb-1.5 block font-ui text-sm font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
        <input
          id="place-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Room number or place name"
          className="block min-h-tap w-full rounded-btn border border-line bg-white pl-9 pr-3 font-ui text-sm text-ink placeholder:text-ink-3 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
        />
      </div>
      <ul className="mt-1 max-h-56 divide-y divide-line overflow-y-auto rounded-btn border border-line bg-white">
        {query.isPending && <li className="px-3 py-2 font-ui text-sm text-ink-3">Loading…</li>}
        {query.isSuccess && !query.data.places.length && <li className="px-3 py-2 font-ui text-sm text-ink-3">No place found.</li>}
        {(query.data?.places || []).map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => onChange(p)} className="block min-h-tap w-full px-3 py-1.5 text-left font-ui text-sm hover:bg-gold-muted">
              <span className="block text-ink">{p.name}</span>
              {p.detail && <span className="block text-xs text-ink-3">{p.detail}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlaceModal({ place, onClose, onDone }) {
  const [f, setF] = useState({
    name: place?.name || '', roomNo: place?.roomNo || '', cubicle: place?.cubicle || '',
    building: place?.building || '', floor: place?.floor || '', notes: place?.notes || '',
  });
  const [active, setActive] = useState(place ? place.isActive : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    setError('');
    try {
      onDone(place ? await updatePlace(place.id, { ...f, isActive: active }) : await createPlace(f));
    } catch (err) {
      setError(errorMessage(err, 'Could not save the place.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={place ? 'Edit place' : 'Add a place'}
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
        <Field id="p-name" label="Name">
          <TextInput id="p-name" value={f.name} onChange={set('name')} maxLength={120} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field id="p-room" label="Room">
            <TextInput id="p-room" value={f.roomNo} onChange={set('roomNo')} maxLength={20} />
          </Field>
          <Field id="p-cub" label="Cubicle" hint="Letter, e.g. C">
            <TextInput id="p-cub" value={f.cubicle} onChange={set('cubicle')} maxLength={8} />
          </Field>
          <Field id="p-bldg" label="Building">
            <TextInput id="p-bldg" value={f.building} onChange={set('building')} maxLength={60} />
          </Field>
          <Field id="p-floor" label="Floor">
            <TextInput id="p-floor" value={f.floor} onChange={set('floor')} maxLength={30} placeholder="e.g. Sixth" />
          </Field>
        </div>
        <Field id="p-notes" label="Notes">
          <TextInput id="p-notes" value={f.notes} onChange={set('notes')} maxLength={500} />
        </Field>
        {place && (
          <label className="flex min-h-tap items-center gap-3 font-ui text-sm text-ink">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={active} onChange={(e) => setActive(e.target.checked)} />
            In use (untick to hide a place that no longer exists — it must be empty)
          </label>
        )}
      </div>
    </Modal>
  );
}

export function PlacesTab({ isAdmin }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(null); // 'new' | place
  const [notice, setNotice] = useState('');
  const q = useDebounced(search.trim());
  const query = useQuery({
    queryKey: ['inventory', 'places', 'list', q, page],
    queryFn: () => listPlaces({ q: q || undefined, page, pageSize: 50 }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-4">
      {notice && <Alert tone="success">{notice}</Alert>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative flex-1">
          <span className="sr-only">Search places</span>
          <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Room number, name or building"
            className="block min-h-tap w-full rounded-btn border border-line bg-white pl-10 pr-3 font-ui text-sm text-ink placeholder:text-ink-3 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
          />
        </label>
        {isAdmin && (
          <button type="button" className="btn-secondary" onClick={() => setModal('new')}>
            <Plus size={16} aria-hidden="true" /> Add place
          </button>
        )}
      </div>
      {query.isError && <Alert tone="error">Could not load places.</Alert>}
      {query.isSuccess && !query.data.places.length && <p className="font-ui text-sm text-ink-3">No places found.</p>}
      {query.data?.places.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-white">
          {query.data.places.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-2.5 font-ui text-sm">
              <MapPin size={16} className="shrink-0 text-ink-3" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{p.name}</span>
                {p.detail && <span className="block truncate text-xs text-ink-3">{p.detail}</span>}
              </span>
              <Link to={`/inventory?q=${encodeURIComponent(p.name)}`} className="shrink-0 text-xs text-primary hover:underline">
                {p.assets} {p.assets === 1 ? 'asset' : 'assets'}
              </Link>
              {p.roomNo && (
                <Link to={`/inventory?room=${encodeURIComponent(p.roomNo)}`} className="hidden shrink-0 text-xs text-primary hover:underline sm:inline">
                  Whole room
                </Link>
              )}
              {isAdmin && (
                <button type="button" onClick={() => setModal(p)} className="flex min-h-tap min-w-tap items-center justify-center text-ink-3 hover:text-ink" aria-label={`Edit ${p.name}`}>
                  <Pencil size={16} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {query.data && <Pager page={page} total={query.data.total} pageSize={50} onPage={setPage} />}
      {modal && (
        <PlaceModal
          place={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          onDone={(p) => {
            setModal(null);
            setNotice(`${p.name} saved.`);
            queryClient.invalidateQueries({ queryKey: ['inventory'] });
          }}
        />
      )}
    </div>
  );
}

function CategoryModal({ mode, category, categories, onClose, onDone }) {
  const [name, setName] = useState(category?.name || '');
  const [intoId, setIntoId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    try {
      if (mode === 'merge') {
        const r = await mergeAssetCategory(category.id, intoId);
        onDone(`${category.name} merged into ${r.into.name} (${r.merged} assets moved).`);
      } else if (mode === 'rename') {
        const c = await renameAssetCategory(category.id, name);
        onDone(`Renamed to ${c.name}.`);
      } else {
        const c = await createAssetCategory(name);
        onDone(`${c.name} added.`);
      }
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'));
      setBusy(false);
    }
  }

  const title = mode === 'merge' ? `Merge ${category.name}` : mode === 'rename' ? 'Rename category' : 'Add a category';
  return (
    <Modal
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy || (mode === 'merge' ? !intoId : !name.trim())}>
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} {mode === 'merge' ? 'Merge' : 'Save'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        {mode === 'merge' ? (
          <>
            <p className="font-ui text-sm text-ink-2">
              All {category.assets} assets move to the chosen category, and future imports follow. This can't be undone from here.
            </p>
            <Field id="c-into" label="Merge into">
              <select id="c-into" className={selectClass} value={intoId} onChange={(e) => setIntoId(e.target.value)}>
                <option value="">Choose a category</option>
                {categories.filter((c) => c.id !== category.id).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : (
          <Field id="c-name" label="Name">
            <TextInput id="c-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

export function CategoriesTab({ isAdmin }) {
  const queryClient = useQueryClient();
  const [modal, setModal] = useState(null); // { mode, category }
  const [notice, setNotice] = useState('');
  const query = useQuery({ queryKey: ['inventory', 'categories'], queryFn: listAssetCategories });

  return (
    <div className="space-y-4">
      {notice && <Alert tone="success">{notice}</Alert>}
      {isAdmin && (
        <div className="flex justify-end">
          <button type="button" className="btn-secondary" onClick={() => setModal({ mode: 'new' })}>
            <Plus size={16} aria-hidden="true" /> Add category
          </button>
        </div>
      )}
      {query.isError && <Alert tone="error">Could not load categories.</Alert>}
      {query.data?.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-white">
          {query.data.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-2 font-ui text-sm">
              <span className="min-w-0 flex-1 truncate text-ink">{c.name}</span>
              <Link to={`/inventory?categoryId=${c.id}`} className="shrink-0 text-xs text-primary hover:underline">
                {c.assets} {c.assets === 1 ? 'asset' : 'assets'}
              </Link>
              {isAdmin && (
                <>
                  <button type="button" onClick={() => setModal({ mode: 'rename', category: c })} className="flex min-h-tap min-w-tap items-center justify-center text-ink-3 hover:text-ink" aria-label={`Rename ${c.name}`}>
                    <Pencil size={16} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => setModal({ mode: 'merge', category: c })} className="flex min-h-tap min-w-tap items-center justify-center text-ink-3 hover:text-ink" aria-label={`Merge ${c.name}`}>
                    <GitMerge size={16} aria-hidden="true" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {modal && (
        <CategoryModal
          mode={modal.mode}
          category={modal.category}
          categories={query.data || []}
          onClose={() => setModal(null)}
          onDone={(message) => {
            setModal(null);
            setNotice(message);
            queryClient.invalidateQueries({ queryKey: ['inventory'] });
          }}
        />
      )}
    </div>
  );
}
