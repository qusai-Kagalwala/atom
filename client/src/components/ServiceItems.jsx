import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, LoaderCircle, PackageCheck, Search, X } from 'lucide-react';
import { decideItems, deliverItem } from '../api/requests';
import { listAssets } from '../api/inventory';
import { errorMessage } from '../api/http';
import { Alert, Field } from './FormControls';
import Modal from './Modal';
import { ITEM_KINDS, ITEM_STATUS } from '../utils/requests';
import { assetTitle } from '../utils/assets';
import { formatDateTime } from '../utils/format';

const areaClass =
  'block w-full rounded-btn border border-line bg-white px-3 py-2 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';

// Engineer / Super Admin: deliver one approved item. Physical items: pick in-store assets
// (they are assigned to the requester), or explain in the note.
function DeliverModal({ ticket, item, onClose, onDone }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const physical = item.kind === 'physical';
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const assets = useQuery({
    queryKey: ['inventory', 'in-store', item.assetCategoryId, debounced],
    queryFn: () => listAssets({ status: 'IN_STORE', categoryId: item.assetCategoryId || undefined, q: debounced || undefined, pageSize: 20 }),
    enabled: physical,
  });
  const toggle = (tag) => setPicked((p) => (p.includes(tag) ? p.filter((x) => x !== tag) : p.length < item.quantity ? [...p, tag] : p));

  async function save() {
    setBusy(true);
    setError('');
    try {
      onDone(await deliverItem(ticket.number, item.id, { note, assetTags: picked }), `${item.name} delivered.`);
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Deliver: ${item.name}${item.quantity > 1 ? ` ×${item.quantity}` : ''}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy}>
            {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <PackageCheck size={18} aria-hidden="true" />} Mark delivered
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        {physical && (
          <div className="space-y-2">
            <p className="font-ui text-sm text-ink-2">
              Pick the asset{item.quantity > 1 ? 's' : ''} handed over (up to {item.quantity}). They are assigned to {ticket.requester.name} and show in their
              My assets. Not in inventory? Leave this empty and explain in the note.
            </p>
            <label className="relative block">
              <span className="sr-only">Search in-store assets</span>
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search in-store assets: tag, model, serial"
                className="block min-h-tap w-full rounded-btn border border-line bg-white pl-9 pr-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
              />
            </label>
            {picked.length > 0 && <p className="font-ui text-xs text-primary">Picked: {picked.join(', ')}</p>}
            <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-btn border border-line bg-white font-ui text-sm">
              {assets.isFetching && !assets.data && <li className="px-3 py-2 text-ink-3">Loading…</li>}
              {assets.data?.assets.length === 0 && <li className="px-3 py-2 text-ink-3">No matching asset in store.</li>}
              {assets.data?.assets.map((a) => {
                const on = picked.includes(a.tag);
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => toggle(a.tag)}
                      aria-pressed={on}
                      className={`flex min-h-tap w-full items-center gap-2 px-3 text-left ${on ? 'bg-primary-tint' : 'hover:bg-gold-muted'}`}
                    >
                      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${on ? 'border-primary bg-primary text-white' : 'border-line'}`}>
                        {on && <Check size={14} aria-hidden="true" />}
                      </span>
                      <span className="min-w-0 truncate">
                        <span className="tabular-nums">{a.tag}</span> <span className="text-ink-2">· {assetTitle(a)}</span>
                        {a.place && <span className="text-ink-3"> · {a.place.name}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <Field id="deliver-note" label={physical ? 'Note (required if no asset is picked)' : 'Note for the requester (optional)'}>
          <textarea
            id="deliver-note"
            rows={3}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={physical ? 'e.g. Handed over at the desk' : 'e.g. Licence sent to your email'}
            className={areaClass}
          />
        </Field>
      </div>
    </Modal>
  );
}

// Items of a service request: Super Admin approves / rejects each (while waiting for approval);
// the assigned engineer (or Super Admin) delivers each approved item.
export default function ServiceItems({ ticket, onDone }) {
  const [choice, setChoice] = useState({}); // itemId → { decision, note }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [delivering, setDelivering] = useState(null);
  const canDecide = ticket.permissions.canDecideItems;
  const canDeliver = ticket.permissions.canDeliverItems;
  const pending = ticket.items.filter((i) => i.status === 'PENDING');
  const set = (id, patch) => setChoice((c) => ({ ...c, [id]: { ...c[id], ...patch } }));

  async function submit(decisions) {
    setBusy(true);
    setError('');
    try {
      onDone(await decideItems(ticket.number, decisions), 'Decisions saved.');
      setChoice({});
    } catch (err) {
      setError(errorMessage(err, 'Could not save the decisions.'));
    } finally {
      setBusy(false);
    }
  }
  const chosen = Object.entries(choice)
    .filter(([, c]) => c.decision)
    .map(([itemId, c]) => ({ itemId, decision: c.decision, note: c.note || '' }));

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl">Items</h2>
        {canDecide && pending.length > 1 && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => submit(pending.map((i) => ({ itemId: i.id, decision: 'approve', note: choice[i.id]?.note || '' })))}>
            <Check size={16} aria-hidden="true" /> Approve all
          </button>
        )}
      </div>
      {canDecide && <p className="font-ui text-sm text-ink-2">Approve or reject each item. A reason is needed to reject; the requester sees it.</p>}
      {error && <Alert tone="error">{error}</Alert>}
      <ul className="divide-y divide-line font-ui text-sm">
        {ticket.items.map((i) => {
          const c = choice[i.id] || {};
          const st = ITEM_STATUS[i.status];
          return (
            <li key={i.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-ink">
                    {i.name}
                    {i.quantity > 1 && <span className="text-ink-2"> ×{i.quantity}</span>}
                    <span className="ml-2 text-xs font-normal text-ink-3">{i.catalogueItemId ? ITEM_KINDS[i.kind] : 'Something else'}</span>
                  </p>
                  <p className="text-ink-2">{i.reason}</p>
                </div>
                <span className={st.badge}>{st.label}</span>
              </div>
              {i.decisionNote && (
                <p className="text-xs text-ink-2">
                  {i.status === 'REJECTED' ? 'Reason' : 'Note'}: {i.decisionNote}
                  {i.decidedBy && <span className="text-ink-3"> — {i.decidedBy}</span>}
                </p>
              )}
              {i.status === 'DELIVERED' && (
                <p className="text-xs text-success">
                  Delivered {formatDateTime(i.deliveredAt)}
                  {i.deliveredBy && ` by ${i.deliveredBy}`}
                  {i.assets.length > 0 && ` · ${i.assets.map((a) => a.tag).join(', ')}`}
                  {i.deliveryNote && ` · ${i.deliveryNote}`}
                </p>
              )}
              {canDecide && i.status === 'PENDING' && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    aria-pressed={c.decision === 'approve'}
                    onClick={() => set(i.id, { decision: c.decision === 'approve' ? null : 'approve' })}
                    className={`inline-flex min-h-tap items-center gap-1 rounded-btn border px-3 ${c.decision === 'approve' ? 'border-primary bg-primary-tint text-primary' : 'border-line text-ink hover:border-gold'}`}
                  >
                    <Check size={16} aria-hidden="true" /> Approve
                  </button>
                  <button
                    type="button"
                    aria-pressed={c.decision === 'reject'}
                    onClick={() => set(i.id, { decision: c.decision === 'reject' ? null : 'reject' })}
                    className={`inline-flex min-h-tap items-center gap-1 rounded-btn border px-3 ${c.decision === 'reject' ? 'border-error bg-error-bg text-error' : 'border-line text-ink hover:border-gold'}`}
                  >
                    <X size={16} aria-hidden="true" /> Reject
                  </button>
                  {c.decision && (
                    <input
                      value={c.note || ''}
                      onChange={(e) => set(i.id, { note: e.target.value })}
                      maxLength={1000}
                      aria-label={`Note for ${i.name}`}
                      placeholder={c.decision === 'reject' ? 'Why not? (required)' : 'Note (optional)'}
                      className="min-h-tap min-w-0 flex-1 rounded-btn border border-line bg-white px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
                    />
                  )}
                </div>
              )}
              {canDeliver && i.status === 'APPROVED' && (
                <button type="button" className="btn-secondary" onClick={() => setDelivering(i)}>
                  <PackageCheck size={16} aria-hidden="true" /> Mark delivered
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {canDecide && chosen.length > 0 && (
        <div className="flex justify-end border-t border-line pt-3">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => submit(chosen)}>
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Save {chosen.length} decision{chosen.length === 1 ? '' : 's'}
          </button>
        </div>
      )}
      {delivering && (
        <DeliverModal
          ticket={ticket}
          item={delivering}
          onClose={() => setDelivering(null)}
          onDone={(fresh, msg) => {
            setDelivering(null);
            onDone(fresh, msg);
          }}
        />
      )}
    </section>
  );
}
