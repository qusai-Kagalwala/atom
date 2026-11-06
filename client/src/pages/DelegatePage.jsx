import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, LoaderCircle, Save, Search, UserCog } from 'lucide-react';
import { listDelegates, setDelegateFeatures } from '../api/staff';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import useAuth from '../hooks/useAuth';
import { formatDateTime } from '../utils/format';

const idText = (p) => [p.itsNumber && `ITS ${p.itsNumber}`, p.employeeId && `Employee ID ${p.employeeId}`].filter(Boolean).join(' · ');
const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

// One staff member: tick features, save.
function PersonCard({ person, features, onSaved }) {
  const [chosen, setChosen] = useState(person.features);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const dirty = !same(chosen, person.features);
  const grantOf = (k) => person.grants.find((g) => g.feature === k);

  const toggle = (k) => {
    setMsg(null);
    setChosen((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]));
  };

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await setDelegateFeatures(person.id, chosen);
      setChosen(r.person.features);
      onSaved(r.person);
      setMsg({ tone: 'success', text: r.added.length || r.removed.length ? 'Saved. They have been notified.' : 'No changes.' });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not save.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-ui font-medium text-ink">{person.name}</p>
          <p className="font-ui text-xs text-ink-3">
            {[person.occupation, idText(person)].filter(Boolean).join(' · ')}
            {!person.isActive && ' · Inactive'}
          </p>
        </div>
        {person.features.length > 0 && (
          <span className="badge shrink-0">
            {person.features.length} {person.features.length === 1 ? 'feature' : 'features'}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {features.map((f) => {
          const on = chosen.includes(f.key);
          const g = grantOf(f.key);
          return (
            <label
              key={f.key}
              className={`flex min-h-tap cursor-pointer items-start gap-3 rounded-btn border px-3 py-2.5 ${on ? 'border-brand bg-primary-muted' : 'border-line bg-surface hover:border-brand'}`}
            >
              <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-brand" checked={on} disabled={busy || (!person.isActive && !on)} onChange={() => toggle(f.key)} />
              <span className="min-w-0">
                <span className="block font-ui text-sm font-medium text-ink">{f.label}</span>
                <span className="block font-ui text-xs text-ink-3">{f.hint}</span>
                {g && on && (
                  <span className="mt-0.5 block font-ui text-xs text-ink-3">
                    Given {formatDateTime(g.at)}{g.by ? ` by ${g.by}` : ''}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" disabled={!dirty || busy} onClick={save}>
          {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Save size={18} aria-hidden="true" />} Save
        </button>
        {dirty && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => setChosen(person.features)}>
            Undo
          </button>
        )}
      </div>
    </li>
  );
}

// Company Admin / Super Admin: give single Admin features to people on the company's staff.
export default function DelegatePage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['delegates'], queryFn: listDelegates });
  const [search, setSearch] = useState('');
  const [onlyGiven, setOnlyGiven] = useState(false);

  const people = useMemo(() => {
    const t = search.trim().toLowerCase();
    return (q.data?.people || []).filter(
      (p) =>
        (!onlyGiven || p.features.length) &&
        (!t || p.name.toLowerCase().includes(t) || (p.itsNumber || '').includes(t) || (p.employeeId || '').toLowerCase().includes(t))
    );
  }, [q.data, search, onlyGiven]);

  const onSaved = (person) =>
    queryClient.setQueryData(['delegates'], (d) => (d ? { ...d, people: d.people.map((p) => (p.id === person.id ? person : p)) } : d));

  return (
    <section className="space-y-5">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">{user.company?.name} · Admin</p>
        <h1 className="mt-1 flex items-center gap-2 text-3xl">
          <UserCog size={26} className="text-brand" aria-hidden="true" /> Delegate access
        </h1>
        <p className="mt-1 font-ui text-sm text-ink-2">
          Give single Admin features to people on your staff. They see them in their menu under &ldquo;Delegated&rdquo;, in any role, and can do everything you can
          for that feature only. Staff &amp; occupations and Delegate access stay with you. To add someone first, use{' '}
          <Link to="/staff" className="text-brand underline">
            Staff &amp; occupations
          </Link>
          .
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="relative block w-full sm:max-w-sm">
          <span className="sr-only">Search staff</span>
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
          <input
            type="search"
            className="min-h-tap w-full rounded-btn border border-line bg-surface pl-9 pr-3 font-ui text-sm text-ink"
            placeholder="Name, ITS number or Employee ID"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="flex min-h-tap items-center gap-2 font-ui text-sm text-ink">
          <input type="checkbox" className="h-5 w-5 accent-brand" checked={onlyGiven} onChange={(e) => setOnlyGiven(e.target.checked)} />
          Only people with features
        </label>
      </div>

      {q.isPending && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
      {q.isError && <Alert tone="error">{errorMessage(q.error, 'Could not load your staff.')}</Alert>}
      {q.isSuccess && !q.data.people.length && (
        <Alert tone="info">
          No staff yet. Add people in <Link to="/staff" className="underline">Staff &amp; occupations</Link> first.
        </Alert>
      )}
      {q.isSuccess && q.data.people.length > 0 && !people.length && <p className="font-ui text-sm text-ink-3">Nobody matches.</p>}
      <ul className="space-y-4">
        {people.map((p) => (
          <PersonCard key={p.id} person={p} features={q.data.features} onSaved={onSaved} />
        ))}
      </ul>
      {q.isSuccess && (
        <p className="flex items-center gap-1.5 font-ui text-xs text-ink-3">
          <Check size={14} aria-hidden="true" /> Every change is saved with your name and the time, and the person is told.
        </p>
      )}
    </section>
  );
}
