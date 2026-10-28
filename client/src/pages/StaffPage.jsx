import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HardHat, LoaderCircle, Pencil, Plus, Search, UserMinus, UserPlus } from 'lucide-react';
import { addStaff, changeOccupation, createOccupation, listOccupations, listStaff, removeStaff, searchPeople, updateOccupation } from '../api/staff';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import Modal from '../components/Modal';
import { Tabs } from '../components/RequestList';
import useAuth from '../hooks/useAuth';
import { loginIdLabel } from '../utils/format';

const selectClass =
  'min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted disabled:opacity-60';

function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function OccupationSelect({ occupations, value, onChange, disabled, label = 'Occupation', id }) {
  return (
    <select id={id} aria-label={label} className={selectClass} value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">Choose occupation…</option>
      {occupations.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

// Search people and make one of them Staff here, with an occupation.
function AddStaffModal({ occupations, onClose, onAdded }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const people = useQuery({ queryKey: ['staff', 'people', term], queryFn: () => searchPeople(term), enabled: term.length >= 2 });
  const [chosen, setChosen] = useState(null);
  const [occupationId, setOccupationId] = useState(occupations.length === 1 ? occupations[0].id : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    try {
      onAdded(await addStaff(chosen.id, occupationId));
    } catch (err) {
      setError(errorMessage(err, 'Could not add this person.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add staff"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy || !chosen || !occupationId}>
            {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <UserPlus size={18} aria-hidden="true" />} Add
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        {!chosen ? (
          <>
            <label className="relative block">
              <span className="sr-only">Search people</span>
              <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
              <input
                type="search"
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Name, ITS number or employee ID"
                className="block min-h-tap w-full rounded-btn border border-line bg-white pl-10 pr-3 font-ui text-sm text-ink placeholder:text-ink-3 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
              />
            </label>
            {people.isFetching && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Searching" />}
            {people.isError && <Alert tone="error">Could not search.</Alert>}
            {people.isSuccess && !people.data.length && <p className="font-ui text-sm text-ink-3">Nobody found.</p>}
            <ul className="divide-y divide-line font-ui text-sm">
              {(people.data || []).map((p) => {
                const why = p.alreadyStaff ? 'Already staff here' : p.otherCompany ? `Works for ${p.otherCompany}` : null;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setChosen(p)}
                      disabled={Boolean(why)}
                      className="flex min-h-tap w-full items-center justify-between gap-2 px-2 py-2 text-left hover:bg-gold-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span>
                        <span className="block font-medium text-ink">{p.name}</span>
                        <span className="block text-xs tabular-nums text-ink-3">{loginIdLabel({ loginType: p.itsNumber ? 'ITS' : 'EMPLOYEE_ID', ...p })}</span>
                      </span>
                      {why && <span className="text-xs text-ink-3">{why}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 rounded-btn border border-line px-3 py-2 font-ui text-sm">
              <span>
                <span className="block font-medium text-ink">{chosen.name}</span>
                <span className="block text-xs tabular-nums text-ink-3">{loginIdLabel({ loginType: chosen.itsNumber ? 'ITS' : 'EMPLOYEE_ID', ...chosen })}</span>
              </span>
              <button type="button" className="text-primary hover:underline" onClick={() => setChosen(null)} disabled={busy}>
                Change
              </button>
            </div>
            <Field id="add-occupation" label="Occupation">
              <OccupationSelect id="add-occupation" occupations={occupations} value={occupationId} onChange={setOccupationId} disabled={busy} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

function StaffTab({ occupations }) {
  const queryClient = useQueryClient();
  const staff = useQuery({ queryKey: ['staff', 'list'], queryFn: listStaff });
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['staff'] });

  async function run(key, fn) {
    setBusy(key);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errorMessage(err, 'Could not save the change.'));
    } finally {
      setBusy('');
    }
  }

  const list = staff.data || [];
  const admins = list.filter((m) => m.isAdmin && !m.isStaff);
  const workers = list.filter((m) => m.isStaff);
  // Grouped by occupation, in the occupation order.
  const groups = occupations
    .map((o) => ({ ...o, members: workers.filter((m) => m.occupation?.id === o.id) }))
    .filter((g) => g.members.length);
  const unplaced = workers.filter((m) => !occupations.some((o) => o.id === m.occupation?.id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-ui text-sm text-ink-2">Staff only see work of this company. Tickets are assigned to them by occupation.</p>
        <button type="button" className="btn-primary" onClick={() => setAdding(true)} disabled={!occupations.length}>
          <UserPlus size={18} aria-hidden="true" /> Add staff
        </button>
      </div>
      {!occupations.length && <Alert tone="warning">Add an occupation first (Occupations tab).</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      {staff.isPending && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
      {staff.isError && <Alert tone="error">{errorMessage(staff.error, 'Could not load the staff.')}</Alert>}
      {staff.isSuccess && !workers.length && <div className="card text-center font-ui text-sm text-ink-2">No staff yet.</div>}

      {[...groups, ...(unplaced.length ? [{ id: 'none', name: 'No occupation', members: unplaced }] : [])].map((g) => (
        <div key={g.id} className="card p-0">
          <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 text-xl">
            <HardHat size={18} aria-hidden="true" className="text-gold-dark" /> {g.name}
            <span className="font-ui text-sm font-normal text-ink-3">· {g.members.length}</span>
          </h2>
          <ul className="divide-y divide-line">
            {g.members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3 font-ui text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-ink">
                    {m.name} {!m.isActive && <span className="status-closed ml-1">Inactive</span>}
                  </span>
                  <span className="block text-xs tabular-nums text-ink-3">
                    {loginIdLabel({ loginType: m.itsNumber ? 'ITS' : 'EMPLOYEE_ID', ...m })} · {m.openWork} open {m.openWork === 1 ? 'job' : 'jobs'}
                    {m.isAdmin && ' · also Admin'}
                  </span>
                </span>
                <span className="w-full sm:w-56">
                  <OccupationSelect
                    label={`Occupation of ${m.name}`}
                    occupations={occupations}
                    value={m.occupation?.id}
                    disabled={Boolean(busy)}
                    onChange={(id) => id && run(`occ:${m.id}`, () => changeOccupation(m.id, id))}
                  />
                </span>
                <button
                  type="button"
                  className="btn-secondary text-error"
                  disabled={Boolean(busy)}
                  onClick={() => run(`rm:${m.id}`, () => removeStaff(m.id))}
                  title={m.openWork ? 'Their open jobs stay assigned — reassign them from the queues.' : undefined}
                >
                  {busy === `rm:${m.id}` ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <UserMinus size={16} aria-hidden="true" />} Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {admins.length > 0 && (
        <div className="card">
          <h2 className="text-xl">Admins</h2>
          <p className="mt-1 font-ui text-xs text-ink-3">Appointed by the Super Admin.</p>
          <ul className="mt-2 divide-y divide-line font-ui text-sm">
            {admins.map((m) => (
              <li key={m.id} className="py-2">
                <span className="font-medium text-ink">{m.name}</span>{' '}
                <span className="text-xs tabular-nums text-ink-3">{loginIdLabel({ loginType: m.itsNumber ? 'ITS' : 'EMPLOYEE_ID', ...m })}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {adding && (
        <AddStaffModal
          occupations={occupations}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function OccupationModal({ occupation, onClose, onSaved }) {
  const [f, setF] = useState({ name: occupation?.name || '', sortOrder: occupation?.sortOrder ?? 100 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    const body = { name: f.name, sortOrder: Number(f.sortOrder) };
    try {
      onSaved(occupation ? await updateOccupation(occupation.id, body) : await createOccupation(body));
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={occupation ? 'Edit occupation' : 'New occupation'}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy || f.name.trim().length < 2}>
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Field id="occ-name" label="Name" hint="e.g. Carpenter, Electrician, Peon">
          <TextInput id="occ-name" value={f.name} maxLength={60} autoFocus onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} />
        </Field>
        <Field id="occ-order" label="Order" hint="Smaller numbers come first in lists.">
          <TextInput id="occ-order" inputMode="numeric" value={f.sortOrder} onChange={(e) => setF((x) => ({ ...x, sortOrder: e.target.value.replace(/\D/g, '') }))} />
        </Field>
      </div>
    </Modal>
  );
}

function OccupationsTab() {
  const queryClient = useQueryClient();
  const all = useQuery({ queryKey: ['staff', 'occupations', 'all'], queryFn: () => listOccupations(true) });
  const [editing, setEditing] = useState(null); // occupation | 'new'
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['staff'] });

  async function toggle(o) {
    setBusy(o.id);
    setError('');
    try {
      await updateOccupation(o.id, { isActive: !o.isActive });
      await refresh();
    } catch (err) {
      setError(errorMessage(err, 'Could not save the change.'));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-ui text-sm text-ink-2">The kinds of work this company's staff do. Never deleted — switch one off when nobody holds it.</p>
        <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
          <Plus size={18} aria-hidden="true" /> New occupation
        </button>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {all.isPending && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
      {all.isError && <Alert tone="error">{errorMessage(all.error, 'Could not load the occupations.')}</Alert>}
      {all.isSuccess && (
        <ul className="card divide-y divide-line p-0 font-ui text-sm">
          {all.data.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className={`block font-medium ${o.isActive ? 'text-ink' : 'text-ink-3 line-through'}`}>{o.name}</span>
                <span className="block text-xs text-ink-3">
                  {o.staff} staff {!o.isActive && '· switched off'}
                </span>
              </span>
              <button type="button" className="btn-secondary" onClick={() => setEditing(o)} disabled={Boolean(busy)}>
                <Pencil size={16} aria-hidden="true" /> Edit
              </button>
              <button type="button" className="btn-secondary" onClick={() => toggle(o)} disabled={Boolean(busy) || (o.isActive && o.staff > 0)} title={o.isActive && o.staff > 0 ? 'Move its staff to another occupation first.' : undefined}>
                {busy === o.id && <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />}
                {o.isActive ? 'Switch off' : 'Switch on'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <OccupationModal
          occupation={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

const TABS = [
  ['staff', 'Staff'],
  ['occupations', 'Occupations'],
];

// Company Admin: who works for this company and as what (Engineer, Carpenter, Peon, …).
export default function StaffPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'occupations' ? 'occupations' : 'staff';
  const occupations = useQuery({ queryKey: ['staff', 'occupations', 'active'], queryFn: () => listOccupations(false) });

  return (
    <section className="space-y-4">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">{user.company?.name} · Admin</p>
        <h1 className="mt-1 text-3xl">Staff &amp; occupations</h1>
      </div>
      <Tabs tabs={TABS} value={tab} onChange={(v) => setParams(v === 'staff' ? {} : { tab: v })} />
      {tab === 'staff' && (occupations.isPending ? <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" /> : <StaffTab occupations={occupations.data || []} />)}
      {tab === 'occupations' && <OccupationsTab />}
    </section>
  );
}
