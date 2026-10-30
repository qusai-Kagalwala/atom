import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, LoaderCircle, Minus, PenLine, Plus, Search, Send, Trash2 } from 'lucide-react';
import { getDefaultLocation, listCatalogue, raiseServiceRequest } from '../api/requests';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import { ITEM_KINDS } from '../utils/requests';
import PriorityPicker from '../components/PriorityPicker';
import useAuth from '../hooks/useAuth';

const MAX_ITEMS = 10;
const areaClass =
  'block w-full rounded-btn border border-line bg-white px-3 py-2 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';

const SHOW_MAX = 30; // long catalogues (e.g. Tanzeem stationery): search or pick a group
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

let nextKey = 1;

// Everyone: ask for something new (software, equipment, a service). Pick from the catalogue or
// type "something else"; each item needs a reason. The company's Admin approves or rejects each item.
export default function RequestPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const catalogue = useQuery({ queryKey: ['catalogue'], queryFn: () => listCatalogue(false), staleTime: 5 * 60_000 });
  const suggested = useQuery({ queryKey: ['requests', 'default-location', 'me'], queryFn: () => getDefaultLocation(), staleTime: 5 * 60_000 });
  const [lines, setLines] = useState([]);
  const [location, setLocation] = useState(null); // null = use the suggestion
  const [priority, setPriority] = useState('NORMAL');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const where = location ?? suggested.data ?? '';
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('');
  const all = useMemo(() => catalogue.data || [], [catalogue.data]);
  const groups = useMemo(() => [...new Set(all.map((c) => c.group).filter(Boolean))].sort(), [all]);
  const matches = useMemo(() => {
    const term = q.trim().toLowerCase();
    return all.filter((c) => (!group || c.group === group) && (!term || `${c.name} ${c.group || ''} ${c.description || ''}`.toLowerCase().includes(term)));
  }, [all, q, group]);
  const shown = matches.slice(0, SHOW_MAX);
  const priceOf = (x) => (x.catalogueItemId ? all.find((c) => c.id === x.catalogueItemId)?.price ?? null : null);
  const priced = lines.filter((x) => priceOf(x) != null);

  // From the AI assistant (Tanzeem): the items it suggested are added once the catalogue is loaded.
  const fromChat = useLocation().state?.add;
  const added = useRef(false);
  useEffect(() => {
    if (added.current || !fromChat?.length || !catalogue.data) return;
    added.current = true;
    const items = fromChat.map((id) => catalogue.data.find((c) => c.id === String(id))).filter(Boolean).slice(0, MAX_ITEMS);
    setLines(items.map((item) => ({ key: nextKey++, catalogueItemId: item.id, name: item.name, kind: item.kind, quantity: 1, reason: '' })));
  }, [fromChat, catalogue.data]);
  const total = priced.reduce((n, x) => n + priceOf(x) * x.quantity, 0);

  const add = (item) => {
    if (lines.length >= MAX_ITEMS) return;
    setLines((l) => [...l, { key: nextKey++, catalogueItemId: item?.id || null, name: item?.name || '', kind: item?.kind || null, quantity: 1, reason: '' }]);
  };
  const set = (key, patch) => setLines((l) => l.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const remove = (key) => setLines((l) => l.filter((x) => x.key !== key));
  const missing = !lines.length || lines.some((x) => x.reason.trim().length < 3 || (!x.catalogueItemId && x.name.trim().length < 2));

  async function submit(e) {
    e.preventDefault();
    if (missing || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await raiseServiceRequest({
        location: where,
        priority,
        items: lines.map((x) => ({
          catalogueItemId: x.catalogueItemId || undefined,
          name: x.catalogueItemId ? undefined : x.name,
          quantity: x.quantity,
          reason: x.reason,
        })),
      });
      navigate(`/tickets/${r.number}`, { replace: true, state: { notice: `Request ${r.number} sent for approval.` } });
    } catch (err) {
      setError(errorMessage(err, 'Could not send the request.'));
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-5">
      <Link to="/track" className="inline-flex items-center gap-1 font-ui text-sm text-primary hover:underline">
        <ArrowLeft size={16} aria-hidden="true" /> My tickets &amp; requests
      </Link>
      <div>
        <h1 className="text-3xl">Request something</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">
          Need something from {user.company?.name || 'us'}? Add what you need and why. {user.company?.name || 'The team'} approves each item and lets you know. Something broken? Raise a ticket
          instead.
        </p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="card space-y-3">
        <h2 className="text-xl">What do you need?</h2>
        {catalogue.isPending && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
        {catalogue.isError && <Alert tone="error">Could not load the catalogue.</Alert>}
        {all.length > 12 && (
          <div className="flex flex-wrap gap-2">
            <label className="relative min-w-0 flex-1">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
              <span className="sr-only">Search</span>
              <input
                type="search"
                className="min-h-tap w-full rounded-btn border border-line bg-white pl-9 pr-3 font-ui text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
                placeholder="Search, e.g. pen, file, envelope"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            {groups.length > 1 && (
              <select
                aria-label="Group"
                className="min-h-tap rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
              >
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
        {all.length > 0 && matches.length === 0 && <p className="font-ui text-sm text-ink-3">Nothing matches — use “Something else”.</p>}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => add(c)}
              disabled={lines.length >= MAX_ITEMS}
              className="flex min-h-tap flex-col items-start rounded-btn border border-line bg-white px-3 py-2 text-left font-ui hover:border-gold hover:bg-gold-muted disabled:opacity-60"
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">{c.name}</span>
                <Plus size={16} className="shrink-0 text-primary" aria-hidden="true" />
              </span>
              <span className="text-xs text-ink-3">
                {c.group || ITEM_KINDS[c.kind]}
                {c.price != null && ` · approx. ${rupees(c.price)} each`}
                {c.packSize > 1 && ` · comes in packs of ${c.packSize}`}
              </span>
              {c.description && <span className="mt-0.5 text-xs text-ink-2">{c.description}</span>}
            </button>
          ))}
          <button
            type="button"
            onClick={() => add(null)}
            disabled={lines.length >= MAX_ITEMS}
            className="flex min-h-tap flex-col items-start rounded-btn border border-dashed border-primary bg-white px-3 py-2 text-left font-ui hover:bg-primary-tint disabled:opacity-60"
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span className="text-sm font-medium text-primary">Something else</span>
              <PenLine size={16} className="shrink-0 text-primary" aria-hidden="true" />
            </span>
            <span className="text-xs text-ink-2">Not in the list? Type what you need.</span>
          </button>
        </div>
        {matches.length > shown.length && (
          <p className="font-ui text-xs text-ink-3">
            Showing {shown.length} of {matches.length}. Search or pick a group to find more.
          </p>
        )}
      </div>

      <form onSubmit={submit} className="card space-y-4" noValidate>
        <h2 className="text-xl">Your request</h2>
        {!lines.length && <p className="font-ui text-sm text-ink-3">Nothing added yet — pick from the list above.</p>}
        <ul className="space-y-4">
          {lines.map((x, n) => (
            <li key={x.key} className="space-y-3 rounded-btn border border-line p-3">
              <div className="flex items-start justify-between gap-2">
                {x.catalogueItemId ? (
                  <p className="font-ui text-sm font-medium text-ink">
                    {n + 1}. {x.name} <span className="font-normal text-ink-3">· {ITEM_KINDS[x.kind]}</span>
                    {priceOf(x) != null && <span className="block text-xs font-normal text-ink-3">approx. {rupees(priceOf(x))} × {x.quantity} = {rupees(priceOf(x) * x.quantity)}</span>}
                  </p>
                ) : (
                  <div className="flex-1">
                    <Field id={`name-${x.key}`} label={`${n + 1}. What do you need?`}>
                      <TextInput id={`name-${x.key}`} value={x.name} onChange={(e) => set(x.key, { name: e.target.value })} maxLength={200} placeholder="e.g. Wireless presenter" />
                    </Field>
                  </div>
                )}
                <button type="button" onClick={() => remove(x.key)} className="flex min-h-tap min-w-tap items-center justify-center rounded-btn text-ink-3 hover:text-error" aria-label={`Remove ${x.name || 'item'}`}>
                  <Trash2 size={18} />
                </button>
              </div>
              <div className="flex items-center gap-2 font-ui text-sm">
                <span className="text-ink-2">How many?</span>
                <button type="button" className="btn-secondary px-3" aria-label="Fewer" onClick={() => set(x.key, { quantity: Math.max(1, x.quantity - 1) })} disabled={x.quantity <= 1}>
                  <Minus size={16} />
                </button>
                <span className="w-8 text-center tabular-nums" aria-live="polite">
                  {x.quantity}
                </span>
                <button type="button" className="btn-secondary px-3" aria-label="More" onClick={() => set(x.key, { quantity: Math.min(50, x.quantity + 1) })} disabled={x.quantity >= 50}>
                  <Plus size={16} />
                </button>
              </div>
              <Field id={`reason-${x.key}`} label="Why do you need it?">
                <textarea id={`reason-${x.key}`} rows={2} maxLength={1000} value={x.reason} onChange={(e) => set(x.key, { reason: e.target.value })} className={areaClass} />
              </Field>
            </li>
          ))}
        </ul>
        {priced.length > 0 && (
          <p className="font-ui text-sm text-ink">
            Approx. total <span className="font-medium tabular-nums">{rupees(total)}</span>
            {priced.length < lines.length && <span className="text-ink-3"> (items without a price not included)</span>}
          </p>
        )}
        {lines.length > 0 && <PriorityPicker value={priority} onChange={setPriority} note={`Delivery depends on availability — ${user.company?.name || 'the team'} will keep you updated.`} />}
        {lines.length > 0 && (
          <Field id="where" label="Where? (optional)" hint="Where it should be delivered or installed.">
            <TextInput id="where" value={where} onChange={(e) => setLocation(e.target.value)} maxLength={200} />
          </Field>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Link to="/track" className="btn-secondary">
            Cancel
          </Link>
          <button type="submit" className="btn-primary" disabled={missing || busy}>
            {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}
            {busy ? 'Sending…' : 'Send for approval'}
          </button>
        </div>
      </form>
    </section>
  );
}
