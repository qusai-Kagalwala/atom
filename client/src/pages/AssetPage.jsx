import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CircleAlert, LoaderCircle, MapPin, Pencil, RotateCcw, Tag, UserRound, UserRoundCheck } from 'lucide-react';
import { assetAction, getAsset, listAssetCategories, updateAsset } from '../api/inventory';
import { listUsers } from '../api/users';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import { PlacePicker } from '../components/InventorySetup';
import Modal from '../components/Modal';
import { formatDateTime, loginIdLabel } from '../utils/format';
import { ASSET_STATUS, assetEventText, assetTitle, statusClass, statusLabel } from '../utils/assets';

const selectClass =
  'min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';
const textareaClass =
  'block w-full rounded-btn border border-line bg-white px-3 py-2 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';

function ActionModal({ title, onClose, busy, onSave, saveLabel, danger, children, error }) {
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
          <button type="button" className={danger ? 'btn-danger' : 'btn-primary'} onClick={onSave} disabled={busy}>
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} {saveLabel}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        {children}
      </div>
    </Modal>
  );
}

// Run one asset action with busy / error state.
function useAction(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn, message) => {
    setBusy(true);
    setError('');
    try {
      onDone(await fn(), message);
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'));
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

function PersonPicker({ value, onChange }) {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const people = useQuery({ queryKey: ['users', 'pick', q], queryFn: () => listUsers({ q, status: 'active', pageSize: 8 }), enabled: q.length >= 2 && !value });

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-btn border border-line bg-cream-dark px-3 py-2 font-ui text-sm">
        <UserRound size={16} className="text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {value.name} <span className="text-ink-3">· {loginIdLabel(value)}</span>
        </span>
        <button type="button" onClick={() => onChange(null)} className="text-xs text-primary hover:underline">
          Change
        </button>
      </div>
    );
  }
  return (
    <div>
      <label htmlFor="person" className="mb-1.5 block font-ui text-sm font-medium text-ink">
        Person
      </label>
      <TextInput id="person" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, ITS number or Employee ID" />
      {q.length >= 2 && (
        <ul className="mt-1 max-h-56 divide-y divide-line overflow-y-auto rounded-btn border border-line bg-white">
          {people.isPending && <li className="px-3 py-2 font-ui text-sm text-ink-3">Searching…</li>}
          {people.isSuccess && !people.data.users.length && <li className="px-3 py-2 font-ui text-sm text-ink-3">Nobody found.</li>}
          {(people.data?.users || []).map((u) => (
            <li key={u.id}>
              <button type="button" onClick={() => onChange(u)} className="block min-h-tap w-full px-3 py-1.5 text-left font-ui text-sm hover:bg-gold-muted">
                {u.name} <span className="text-ink-3">· {loginIdLabel(u)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EditModal({ asset, onClose, onDone }) {
  const categories = useQuery({ queryKey: ['inventory', 'categories'], queryFn: listAssetCategories });
  const [f, setF] = useState({
    name: asset.name || '', categoryId: asset.category.id, manufacturer: asset.manufacturer || '', model: asset.model || '',
    modelNo: asset.modelNo || '', serial: asset.serial || '', macAddress: asset.macAddress || '', ipAddress: asset.ipAddress || '',
    purchasedOn: asset.purchasedOn || '', orderNumber: asset.orderNumber || '', supplier: asset.supplier || '', notes: asset.notes || '',
  });
  const { busy, error, run } = useAction(onDone);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const text = (id, label, k, max) => (
    <Field id={id} label={label}>
      <TextInput id={id} value={f[k]} onChange={set(k)} maxLength={max} />
    </Field>
  );
  return (
    <ActionModal title={`Edit ${asset.tag}`} onClose={onClose} busy={busy} error={error} saveLabel="Save" onSave={() => run(() => updateAsset(asset.tag, f), 'Details saved.')}>
      {text('e-name', 'Name', 'name', 120)}
      <Field id="e-cat" label="Category">
        <select id="e-cat" className={selectClass} value={f.categoryId} onChange={set('categoryId')}>
          {(categories.data || [asset.category]).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        {text('e-man', 'Manufacturer', 'manufacturer', 80)}
        {text('e-model', 'Model', 'model', 120)}
        {text('e-mno', 'Model no.', 'modelNo', 80)}
        <Field id="e-serial" label="Serial" hint={asset.serialNeedsCheck ? 'Typing the real serial clears “needs checking”.' : undefined}>
          <TextInput id="e-serial" value={f.serial} onChange={set('serial')} maxLength={80} />
        </Field>
        {text('e-mac', 'MAC address', 'macAddress', 60)}
        {text('e-ip', 'IP address', 'ipAddress', 60)}
        <Field id="e-date" label="Purchased on">
          <TextInput id="e-date" type="date" value={f.purchasedOn} onChange={set('purchasedOn')} />
        </Field>
        {text('e-order', 'Order number', 'orderNumber', 80)}
      </div>
      {text('e-sup', 'Supplier', 'supplier', 120)}
      <Field id="e-notes" label="Notes">
        <textarea id="e-notes" rows={3} value={f.notes} onChange={set('notes')} maxLength={2000} className={textareaClass} />
      </Field>
    </ActionModal>
  );
}

function Detail({ label, children, mono }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-ink-3">{label}</dt>
      <dd className={`text-ink ${mono ? 'tabular-nums' : ''}`}>{children || <span className="text-ink-3">—</span>}</dd>
    </div>
  );
}

export default function AssetPage() {
  const { tag } = useParams();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [modal, setModal] = useState(null); // 'edit' | 'assign' | 'return' | 'move' | 'status'
  const [notice, setNotice] = useState(location.state?.notice || '');
  const [person, setPerson] = useState(null);
  const [place, setPlace] = useState(null);
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const back = typeof location.state?.from === 'string' ? location.state.from : '/inventory';
  const key = ['inventory', 'asset', tag];
  const query = useQuery({ queryKey: key, queryFn: () => getAsset(tag), retry: false });

  const done = (fresh, message) => {
    queryClient.setQueryData(key, fresh);
    queryClient.invalidateQueries({ queryKey: ['inventory', 'assets'] });
    setModal(null);
    setNotice(message);
  };
  const action = useAction(done);
  const open = (m) => {
    setPerson(null);
    setPlace(null);
    setStatus('');
    setNote('');
    action.setError('');
    setModal(m);
  };

  if (query.isPending) {
    return (
      <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
        <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading…
      </p>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-4">
        <Link to={back} className="inline-flex items-center gap-1 font-ui text-sm text-primary hover:underline">
          <ArrowLeft size={16} aria-hidden="true" /> Inventory
        </Link>
        <Alert tone="error">{errorMessage(query.error, 'Could not load this asset.')}</Alert>
      </div>
    );
  }

  const a = query.data;
  const manage = a.permissions.canManage;
  const retired = a.status === 'RETIRED';

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link to={back} className="inline-flex items-center gap-1 font-ui text-sm text-primary hover:underline">
        <ArrowLeft size={16} aria-hidden="true" /> Inventory
      </Link>
      {notice && <Alert tone="success">{notice}</Alert>}
      {(a.serialNeedsCheck || a.holderUnknown) && (
        <Alert tone="info">
          <span className="flex items-start gap-2">
            <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {a.serialNeedsCheck && 'The serial was lost in the Snipe-IT export (Excel changed it) — read it off the device and edit it here. '}
              {a.holderUnknown && 'In use, but nobody in ATOM is recorded as holding it — assign the real person.'}
            </span>
          </span>
        </Alert>
      )}

      <header className="card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1 font-ui text-xs tabular-nums text-ink-3">
              <Tag size={12} aria-hidden="true" /> {a.tag} · {a.category.name}
            </p>
            <h1 className="mt-1 text-2xl sm:text-3xl">{assetTitle(a)}</h1>
          </div>
          <span className={statusClass(a.status)}>{statusLabel(a.status)}</span>
        </div>
        <dl className="mt-4 grid gap-x-6 gap-y-3 font-ui text-sm sm:grid-cols-2">
          <Detail label="Held by">{a.holder ? `${a.holder.name} · ${loginIdLabel(a.holder)}` : a.holderUnknown ? 'Unknown (from Snipe-IT)' : null}</Detail>
          <Detail label="Place">
            {a.place && (
              <span className="flex items-start gap-1">
                <MapPin size={14} className="mt-0.5 text-ink-3" aria-hidden="true" />
                <span>
                  {a.place.name}
                  {a.place.detail && <span className="block text-xs text-ink-3">{a.place.detail}</span>}
                </span>
              </span>
            )}
          </Detail>
          {a.sitsHere?.length > 0 && (
            <Detail label={a.place?.cubicle ? 'Sits here' : 'Sits in this room'}>
              {a.sitsHere
                .slice(0, 20)
                .map((p) => `${p.name}${!a.place?.cubicle && p.cubicle ? ` (${p.cubicle})` : ''}`)
                .join(', ')}
              {a.sitsHere.length > 20 && ' and more'}
            </Detail>
          )}
          <Detail label="Manufacturer / model">{[a.manufacturer, a.model, a.modelNo].filter(Boolean).join(' · ')}</Detail>
          <Detail label="Serial" mono>
            {a.serial}
          </Detail>
          <Detail label="MAC / IP" mono>
            {[a.macAddress, a.ipAddress].filter(Boolean).join(' · ')}
          </Detail>
          <Detail label="Purchased">{[a.purchasedOn, a.supplier, a.orderNumber && `Order ${a.orderNumber}`].filter(Boolean).join(' · ')}</Detail>
        </dl>
        {a.notes && <p className="mt-4 whitespace-pre-wrap font-ui text-sm text-ink">{a.notes}</p>}
        <p className="mt-3 font-ui text-xs text-ink-3">
          {a.source === 'snipeit' ? `From Snipe-IT (ID ${a.snipeitId ?? '—'}), last imported ${formatDateTime(a.importedAt)}` : 'Added in ATOM'}
          {a.editedInAtomAt && ` · changed in ATOM ${formatDateTime(a.editedInAtomAt)} (a re-import will warn before overwriting)`}
        </p>

        {manage && (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
            {!retired && (
              <button type="button" className="btn-primary" onClick={() => open('assign')}>
                <UserRoundCheck size={16} aria-hidden="true" /> {a.holder ? 'Reassign' : 'Assign to a person'}
              </button>
            )}
            {(a.holder || a.holderUnknown) && (
              <button type="button" className="btn-secondary" onClick={() => open('return')}>
                <RotateCcw size={16} aria-hidden="true" /> Return to store
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={() => open('move')}>
              <MapPin size={16} aria-hidden="true" /> Move
            </button>
            <button type="button" className="btn-secondary" onClick={() => open('status')}>
              Change status
            </button>
            <button type="button" className="btn-secondary" onClick={() => open('edit')}>
              <Pencil size={16} aria-hidden="true" /> Edit
            </button>
          </div>
        )}
      </header>

      <section>
        <h2 className="text-xl">History</h2>
        <ol className="mt-3 space-y-3">
          {a.history.map((e) => (
            <li key={e.id} className="flex gap-3 px-1 font-ui text-sm">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gold" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-ink">
                  <span className="font-medium">{e.actor?.name || 'ATOM'}</span> · {assetEventText(e)}
                </p>
                {e.note && <p className="mt-0.5 whitespace-pre-wrap text-ink-2">“{e.note}”</p>}
                <p className="text-xs text-ink-3">{formatDateTime(e.at)}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {modal === 'edit' && <EditModal asset={a} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'assign' && (
        <ActionModal
          title={`Assign ${a.tag}`}
          onClose={() => setModal(null)}
          busy={action.busy}
          error={action.error}
          saveLabel="Assign"
          onSave={() =>
            person ? action.run(() => assetAction(a.tag, 'assign', { userId: person.id, note }), `Assigned to ${person.name}.`) : action.setError('Choose a person.')
          }
        >
          <PersonPicker value={person} onChange={setPerson} />
          <Field id="as-note" label="Note (optional)">
            <TextInput id="as-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
        </ActionModal>
      )}
      {modal === 'return' && (
        <ActionModal
          title={`Return ${a.tag}`}
          onClose={() => setModal(null)}
          busy={action.busy}
          error={action.error}
          saveLabel="Return to store"
          onSave={() => action.run(() => assetAction(a.tag, 'return', { placeId: place?.id, note }), 'Returned to store.')}
        >
          <p className="font-ui text-sm text-ink-2">It stops being held by {a.holder ? a.holder.name : 'anyone'} and goes back to “In store”.</p>
          <PlacePicker value={place} onChange={setPlace} label="Store it at (optional — leave empty to keep the current place)" />
          <Field id="rt-note" label="Note (optional)">
            <TextInput id="rt-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
        </ActionModal>
      )}
      {modal === 'move' && (
        <ActionModal
          title={`Move ${a.tag}`}
          onClose={() => setModal(null)}
          busy={action.busy}
          error={action.error}
          saveLabel="Move"
          onSave={() => (place ? action.run(() => assetAction(a.tag, 'move', { placeId: place.id, note }), `Moved to ${place.name}.`) : action.setError('Choose a place.'))}
        >
          <PlacePicker value={place} onChange={setPlace} label="New place" />
          <Field id="mv-note" label="Note (optional)">
            <TextInput id="mv-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
        </ActionModal>
      )}
      {modal === 'status' && (
        <ActionModal
          title={`Status of ${a.tag}`}
          onClose={() => setModal(null)}
          busy={action.busy}
          error={action.error}
          saveLabel={status === 'RETIRED' ? 'Retire' : 'Save'}
          danger={status === 'RETIRED'}
          onSave={() => (status ? action.run(() => assetAction(a.tag, 'status', { status, note }), `Status: ${statusLabel(status)}.`) : action.setError('Choose a status.'))}
        >
          <Field id="st" label="New status">
            <select id="st" className={selectClass} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Choose…</option>
              {Object.entries(ASSET_STATUS)
                .filter(([k]) => k !== a.status)
                .map(([k, s]) => (
                  <option key={k} value={k}>
                    {s.label}
                  </option>
                ))}
            </select>
          </Field>
          {(status === 'RETIRED' || status === 'IN_STORE') && (a.holder || a.holderUnknown) && (
            <p className="font-ui text-xs text-ink-3">It will no longer be held by anyone.</p>
          )}
          <Field id="st-note" label={status === 'RETIRED' ? 'Why is it retired? (required)' : 'Note (optional)'}>
            <textarea id="st-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className={textareaClass} />
          </Field>
        </ActionModal>
      )}
    </div>
  );
}
