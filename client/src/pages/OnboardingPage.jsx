import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, LoaderCircle, PackageCheck, PackagePlus, Search, TriangleAlert, UserRound } from 'lucide-react';
import { assetAction, listAssets, listToRecover, personEquipment, receiveFromPerson, searchInventoryPeople } from '../api/inventory';
import { errorMessage } from '../api/http';
import { Alert, Field } from '../components/FormControls';
import { Tabs } from '../components/RequestList';
import useAuth from '../hooks/useAuth';
import { assetTitle } from '../utils/assets';
import { formatDateTime } from '../utils/format';

// Company Admin (Phase 10): onboarding (give equipment one item at a time), offboarding (tick and
// receive everything at once) and the "to recover" list — people deactivated while holding assets.
// Only this company's assets; people are shared.
const inputClass =
  'block min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';

function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const idLine = (p) => [p.itsNumber && `ITS ${p.itsNumber}`, p.employeeId && `Employee ID ${p.employeeId}`].filter(Boolean).join(' · ');

function SearchBox({ value, onChange, placeholder, label }) {
  return (
    <label className="relative block">
      <span className="sr-only">{label}</span>
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={`${inputClass} pl-9`} />
    </label>
  );
}

// ---------- find a person ----------
function PeopleSearch({ onOpen }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const people = useQuery({ queryKey: ['onboarding', 'people', term], queryFn: () => searchInventoryPeople(term), enabled: term.length >= 2 });
  return (
    <div className="card space-y-3">
      <SearchBox value={q} onChange={setQ} label="Find a person" placeholder="Name, ITS number or Employee ID" />
      {term.length < 2 && <p className="font-ui text-sm text-ink-3">Type at least 2 characters.</p>}
      {people.isFetching && !people.data && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
      {people.isError && <Alert tone="error">Could not search.</Alert>}
      {people.data?.length === 0 && <p className="font-ui text-sm text-ink-3">Nobody found.</p>}
      {people.data?.length > 0 && (
        <ul className="divide-y divide-line font-ui text-sm">
          {people.data.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onOpen(p.id)} className="flex min-h-tap w-full flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2 text-left hover:bg-gold-muted">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-ink">
                    {p.name}
                    {!p.isActive && <span className="status-closed ml-2">Inactive</span>}
                  </span>
                  <span className="block text-xs text-ink-3">{idLine(p)}</span>
                </span>
                <span className="text-xs text-ink-2">{p.held} held</span>
                {p.toRecover > 0 && <span className="status-waiting">{p.toRecover} to recover</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- give equipment (onboarding) ----------
function GiveEquipment({ person, onGiven }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const assets = useQuery({
    queryKey: ['onboarding', 'in-store', term],
    queryFn: () => listAssets({ status: 'IN_STORE', q: term || undefined, pageSize: 20 }),
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function give(tag) {
    setBusy(tag);
    setError('');
    try {
      await assetAction(tag, 'assign', { userId: person.id, note: 'Onboarding' });
      onGiven(tag);
    } catch (err) {
      setError(errorMessage(err, 'Could not assign it.'));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="card space-y-3">
      <h2 className="flex items-center gap-2 text-xl">
        <PackagePlus size={20} className="text-primary" aria-hidden="true" /> Give equipment
      </h2>
      {!person.isActive ? (
        <p className="font-ui text-sm text-ink-3">{person.name} is inactive — equipment can only be given to active people.</p>
      ) : (
        <>
          <p className="font-ui text-sm text-ink-2">In-store assets of this company. Assign one at a time; it shows in their My assets.</p>
          <SearchBox value={q} onChange={setQ} label="Search in-store assets" placeholder="Tag, model, serial" />
          {error && <Alert tone="error">{error}</Alert>}
          {assets.isError && <Alert tone="error">Could not load the assets.</Alert>}
          {assets.data?.assets.length === 0 && <p className="font-ui text-sm text-ink-3">No matching asset in store.</p>}
          <ul className="max-h-80 divide-y divide-line overflow-y-auto font-ui text-sm">
            {assets.data?.assets.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">
                    <span className="tabular-nums">{a.tag}</span> · {assetTitle(a)}
                  </span>
                  <span className="block text-xs text-ink-3">
                    {a.category.name}
                    {a.place && ` · ${a.place.name}`}
                  </span>
                </span>
                <button type="button" className="btn-secondary shrink-0" disabled={Boolean(busy)} onClick={() => give(a.tag)}>
                  {busy === a.tag ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />} Assign
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------- one person: what they hold, receive (offboarding) ----------
function Person({ id, onBack }) {
  const queryClient = useQueryClient();
  const data = useQuery({ queryKey: ['onboarding', 'person', id], queryFn: () => personEquipment(id) });
  const [picked, setPicked] = useState(() => new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['onboarding'] });

  if (data.isPending) return <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />;
  if (data.isError) return <Alert tone="error">{errorMessage(data.error, 'Could not load this person.')}</Alert>;
  const { person, assets } = data.data;
  const all = assets.length > 0 && picked.size === assets.length;
  const toggle = (tag) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(tag)) n.delete(tag);
      else n.add(tag);
      return n;
    });

  async function receive() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await receiveFromPerson(person.id, { tags: [...picked], note });
      setPicked(new Set());
      setNote('');
      setMsg({ tone: 'success', text: `Received ${r.received.length}: ${r.received.join(', ')}. Back in store.` });
      await refresh();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not mark them received.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="inline-flex min-h-tap items-center gap-1 font-ui text-sm text-primary hover:underline">
        <ArrowLeft size={16} aria-hidden="true" /> Find another person
      </button>

      <div className="card flex flex-wrap items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-tint text-primary" aria-hidden="true">
          <UserRound size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl">
            {person.name}
            {!person.isActive && <span className="status-closed ml-2 align-middle">Inactive</span>}
          </h2>
          <p className="font-ui text-sm text-ink-2">
            {idLine(person)}
            {person.department && ` · ${person.department}`}
          </p>
        </div>
      </div>

      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <div className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-xl">
            <PackageCheck size={20} className="text-primary" aria-hidden="true" /> Equipment held ({assets.length})
          </h2>
          {assets.length > 0 && (
            <label className="flex min-h-tap items-center gap-2 font-ui text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={all}
                onChange={() => setPicked(all ? new Set() : new Set(assets.map((a) => a.tag)))}
              />
              Select all
            </label>
          )}
        </div>
        {assets.length === 0 ? (
          <p className="font-ui text-sm text-ink-3">Holds nothing from this company.</p>
        ) : (
          <ul className="divide-y divide-line font-ui text-sm">
            {assets.map((a) => (
              <li key={a.id}>
                <label className="flex min-h-tap cursor-pointer items-center gap-3 py-2">
                  <input type="checkbox" className="h-4 w-4 shrink-0 accent-primary" checked={picked.has(a.tag)} onChange={() => toggle(a.tag)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">
                      <Link to={`/inventory/assets/${encodeURIComponent(a.tag)}`} className="tabular-nums text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
                        {a.tag}
                      </Link>{' '}
                      · {assetTitle(a)}
                    </span>
                    <span className="block text-xs text-ink-3">
                      {a.category.name}
                      {a.serial && ` · S/N ${a.serial}`}
                    </span>
                  </span>
                  {a.toRecoverSince && <span className="status-waiting shrink-0">To recover</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
        {assets.length > 0 && (
          <div className="space-y-3 border-t border-line pt-3">
            <Field id="receive-note" label="Note (optional)" hint="e.g. Left the department, all items checked.">
              <input id="receive-note" className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
            </Field>
            <div className="flex justify-end">
              <button type="button" className="btn-primary" disabled={busy || picked.size === 0} onClick={receive}>
                {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <PackageCheck size={18} aria-hidden="true" />}
                Mark {picked.size || ''} received
              </button>
            </div>
          </div>
        )}
      </div>

      <GiveEquipment
        person={person}
        onGiven={async (tag) => {
          setMsg({ tone: 'success', text: `${tag} assigned to ${person.name}.` });
          await refresh();
        }}
      />
    </div>
  );
}

// ---------- to recover ----------
function ToRecover({ query, onOpen }) {
  if (query.isPending) return <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />;
  if (query.isError) return <Alert tone="error">Could not load the list.</Alert>;
  const { people } = query.data;
  if (!people.length) return <p className="card font-ui text-sm text-ink-3">Nothing to recover. Everyone who left has handed everything back.</p>;
  return (
    <ul className="space-y-3">
      {people.map((g) => (
        <li key={g.person.id} className="card">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="flex items-center gap-2 font-ui font-medium text-ink">
                <TriangleAlert size={16} className="text-warning" aria-hidden="true" /> {g.person.name}
              </p>
              <p className="font-ui text-xs text-ink-3">
                {idLine(g.person)} · inactive since {formatDateTime(g.since)}
              </p>
            </div>
            <button type="button" className="btn-secondary" onClick={() => onOpen(g.person.id)}>
              Receive
            </button>
          </div>
          <p className="mt-2 font-ui text-sm text-ink-2">
            {g.assets.map((a) => `${a.tag} (${assetTitle(a)})`).join(' · ')}
          </p>
        </li>
      ))}
    </ul>
  );
}

const TABS = [
  ['people', 'People'],
  ['recover', 'To recover'],
];

export default function OnboardingPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const person = /^\d{1,18}$/.test(params.get('person') || '') ? params.get('person') : null;
  const tab = person ? 'people' : params.get('tab') === 'recover' ? 'recover' : 'people';
  const recover = useQuery({ queryKey: ['onboarding', 'to-recover'], queryFn: listToRecover });
  const open = (id) => setParams({ person: id });

  return (
    <section className="mx-auto max-w-4xl space-y-4">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">{user.company?.name} · Admin</p>
        <h1 className="mt-1 text-3xl">Onboarding / Offboarding</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">
          Give a person {user.company?.name || 'this company'}’s equipment one item at a time, and receive everything back in one go when they leave.
        </p>
      </div>
      <Tabs tabs={TABS} value={tab} onChange={(v) => setParams(v === 'people' ? {} : { tab: v })} counts={{ recover: recover.data?.total || 0 }} />
      {tab === 'recover' ? (
        <ToRecover query={recover} onOpen={open} />
      ) : person ? (
        <Person key={person} id={person} onBack={() => setParams({})} />
      ) : (
        <PeopleSearch onOpen={open} />
      )}
    </section>
  );
}
