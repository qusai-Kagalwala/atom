import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, LoaderCircle, Search, ShieldUser, UserMinus, UserPlus } from 'lucide-react';
import { grantRole, listServiceUnits, listUsers, removeRole } from '../api/users';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import Modal from '../components/Modal';
import { loginIdLabel } from '../utils/format';

function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// Search active people and appoint one as Admin of the company.
function AppointModal({ company, onClose, onDone }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const people = useQuery({
    queryKey: ['users', 'search', term],
    queryFn: () => listUsers({ q: term, status: 'active', pageSize: 20 }),
    enabled: term.length >= 2,
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function appoint(u) {
    setBusy(u.id);
    setError('');
    try {
      await grantRole(u.id, 'ADMIN', { companyId: company.id });
      onDone();
    } catch (err) {
      setError(errorMessage(err, 'Could not appoint this person.'));
      setBusy('');
    }
  }

  return (
    <Modal title={`Appoint an Admin of ${company.name}`} onClose={onClose} busy={Boolean(busy)}>
      <div className="space-y-3">
        {error && <Alert tone="error">{error}</Alert>}
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
        {people.isSuccess && !people.data.users.length && <p className="font-ui text-sm text-ink-3">Nobody found.</p>}
        <ul className="divide-y divide-line font-ui text-sm">
          {(people.data?.users || []).map((u) => {
            const here = u.company?.code === company.code;
            const already = here && u.roles.includes('ADMIN');
            const elsewhere = u.company && !here && (u.roles.includes('ADMIN') || u.roles.includes('ENGINEER'));
            const why = already ? 'Already Admin here' : elsewhere ? `Works for ${u.company.name}` : null;
            return (
              <li key={u.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  <span className="block font-medium text-ink">{u.name}</span>
                  <span className="block text-xs tabular-nums text-ink-3">{loginIdLabel(u)}</span>
                </span>
                {why ? (
                  <span className="text-xs text-ink-3">{why}</span>
                ) : (
                  <button type="button" className="btn-secondary" onClick={() => appoint(u)} disabled={Boolean(busy)}>
                    {busy === u.id ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <UserPlus size={16} aria-hidden="true" />} Appoint
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}

function CompanyAdmins({ company }) {
  const queryClient = useQueryClient();
  const admins = useQuery({
    queryKey: ['users', 'admins', company.id],
    queryFn: () => listUsers({ role: 'ADMIN', companyId: company.id, status: 'all', pageSize: 100 }),
  });
  const [appointing, setAppointing] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  async function remove(u) {
    setBusy(u.id);
    setError('');
    try {
      await removeRole(u.id, 'ADMIN');
      await refresh();
    } catch (err) {
      setError(errorMessage(err, 'Could not remove this Admin.'));
    } finally {
      setBusy('');
    }
  }

  const list = admins.data?.users || [];
  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xl">
          <Building2 size={20} aria-hidden="true" className="text-gold-dark" /> {company.name}
        </h2>
        <button type="button" className="btn-secondary" onClick={() => setAppointing(true)}>
          <UserPlus size={16} aria-hidden="true" /> Appoint Admin
        </button>
      </div>
      {company.tagline && <p className="mt-1 font-ui text-sm text-ink-2">{company.tagline}</p>}
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {admins.isPending && <LoaderCircle size={18} className="mt-3 animate-spin text-ink-3" aria-label="Loading" />}
      {admins.isError && <Alert tone="error">{errorMessage(admins.error, 'Could not load the Admins.')}</Alert>}
      {admins.isSuccess && !list.length && <p className="mt-3 font-ui text-sm text-warning">No Admin yet — nobody can assign or approve here.</p>}
      <ul className="mt-2 divide-y divide-line font-ui text-sm">
        {list.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <Link to={`/users/${u.id}`} className="font-medium text-primary hover:underline">
                {u.name}
              </Link>
              {!u.isActive && <span className="status-closed ml-2">Inactive</span>}
              <span className="block text-xs tabular-nums text-ink-3">
                {loginIdLabel(u)}
                {u.roles.includes('ENGINEER') && u.occupation ? ` · also ${u.occupation}` : ''}
              </span>
            </span>
            <button type="button" className="btn-secondary text-error" onClick={() => remove(u)} disabled={Boolean(busy)}>
              {busy === u.id ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <UserMinus size={16} aria-hidden="true" />} Remove
            </button>
          </li>
        ))}
      </ul>
      {appointing && (
        <AppointModal
          company={company}
          onClose={() => setAppointing(false)}
          onDone={() => {
            setAppointing(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// Super Admin: who runs each company. An Admin works for one company only; each company's Admins
// manage their own staff (Staff & occupations, inside the company).
export default function AdminsPage() {
  const companies = useQuery({ queryKey: ['service-units'], queryFn: listServiceUnits, staleTime: 5 * 60_000 });
  return (
    <section className="space-y-4">
      <div>
        <p className="flex items-center gap-1 font-ui text-xs uppercase tracking-wider text-gold-dark">
          <ShieldUser size={14} aria-hidden="true" /> Super Admin
        </p>
        <h1 className="mt-1 text-3xl">Company admins</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">Each company is run by its own Admins. They only see their own company.</p>
      </div>
      {companies.isPending && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
      {companies.isError && <Alert tone="error">Could not load the companies.</Alert>}
      {(companies.data || [])
        .filter((c) => c.isActive)
        .map((c) => (
          <CompanyAdmins key={c.id} company={c} />
        ))}
    </section>
  );
}
