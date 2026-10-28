import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, LoaderCircle, Search, UserPlus } from 'lucide-react';
import { createUser, listUsers } from '../api/users';
import { errorMessage } from '../api/http';
import { Alert, Field, PasswordInput, TextInput } from '../components/FormControls';
import Modal from '../components/Modal';
import { loginIdLabel, SOURCE_LABELS } from '../utils/format';
import { roleBadgeClass, roleLabel, sortRoles } from '../utils/roles';

const PAGE_SIZE = 25;
const selectClass =
  'min-h-tap rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';

function StatusBadge({ active }) {
  return <span className={active ? 'status-resolved' : 'status-closed'}>{active ? 'Active' : 'Inactive'}</span>;
}

// Staff show their occupation; Admin / Staff roles show the company they belong to.
function RoleBadges({ user }) {
  return (
    <span className="flex flex-wrap gap-1">
      {sortRoles(user.roles).map((r) => (
        <span key={r} className={roleBadgeClass(r)}>
          {roleLabel(r, user)}
          {user.company && (r === 'ADMIN' || r === 'ENGINEER') ? ` · ${user.company.name}` : ''}
        </span>
      ))}
    </span>
  );
}

// Typing waits 300 ms before searching.
function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function AddUserModal({ onClose }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ loginType: 'ITS', itsNumber: '', employeeId: '', password: '', name: '', email: '', mobile: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const digits = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value.replace(/\D/g, '') }));
  const isIts = form.loginType === 'ITS';

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = { loginType: form.loginType, name: form.name, email: form.email, mobile: form.mobile };
      if (isIts) body.itsNumber = form.itsNumber;
      else Object.assign(body, { employeeId: form.employeeId, password: form.password });
      const user = await createUser(body);
      navigate(`/users/${user.id}`);
    } catch (err) {
      setError(errorMessage(err, 'Could not add the user.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a user"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="add-user" className="btn-primary" disabled={busy}>
            {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <UserPlus size={18} aria-hidden="true" />}
            Add user
          </button>
        </>
      }
    >
      <p className="font-ui text-sm text-ink-2">
        For someone who is not in the Idarah view or the old login table. They start as Employee.
      </p>
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      <form id="add-user" onSubmit={submit} className="mt-4 space-y-4" noValidate>
        <fieldset>
          <legend className="mb-1.5 font-ui text-sm font-medium text-ink">Signs in with</legend>
          <div className="grid grid-cols-2 gap-2">
            {[
              ['ITS', 'ITS (eJamaat)'],
              ['EMPLOYEE_ID', 'Employee ID'],
            ].map(([value, label]) => (
              <label
                key={value}
                className={`flex min-h-tap cursor-pointer items-center justify-center rounded-btn border px-3 font-ui text-sm ${
                  form.loginType === value ? 'border-primary bg-primary-tint text-primary' : 'border-line text-ink'
                }`}
              >
                <input type="radio" name="loginType" value={value} checked={form.loginType === value} onChange={set('loginType')} className="sr-only" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        {isIts ? (
          <Field id="its" label="ITS number" hint="8 digits. Their password is checked by eJamaat.">
            <TextInput id="its" inputMode="numeric" maxLength={8} value={form.itsNumber} onChange={digits('itsNumber')} className="tabular-nums" />
          </Field>
        ) : (
          <>
            <Field id="empid" label="Employee ID" hint="1–7 digits.">
              <TextInput id="empid" inputMode="numeric" maxLength={7} value={form.employeeId} onChange={digits('employeeId')} className="tabular-nums" />
            </Field>
            <Field id="pw" label="Password" hint="At least 8 characters. Tell the user this password.">
              <PasswordInput id="pw" autoComplete="new-password" value={form.password} onChange={set('password')} />
            </Field>
          </>
        )}
        <Field id="name" label="Name">
          <TextInput id="name" value={form.name} onChange={set('name')} maxLength={200} />
        </Field>
        <Field id="email" label="Email (optional)">
          <TextInput id="email" type="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field id="mobile" label="Mobile (optional)">
          <TextInput id="mobile" inputMode="tel" value={form.mobile} onChange={set('mobile')} />
        </Field>
      </form>
    </Modal>
  );
}

export default function UsersPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') || '');
  const [adding, setAdding] = useState(false);
  const q = useDebounced(search.trim());

  const filters = {
    role: params.get('role') || '',
    status: params.get('status') || 'active',
    source: params.get('source') || '',
    page: Number(params.get('page')) || 1,
  };

  // Keep the search box in the URL (so Back returns to the same list), and go to page 1 on a new search.
  useEffect(() => {
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if ((next.get('q') || '') !== q) {
          if (q) next.set('q', q);
          else next.delete('q');
          next.delete('page');
        }
        return next;
      },
      { replace: true }
    );
  }, [q, setParams]);

  const setFilter = (key) => (e) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (e.target.value) next.set(key, e.target.value);
      else next.delete(key);
      next.delete('page');
      return next;
    });

  const goToPage = (page) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('page', String(page));
      return next;
    });

  const query = useQuery({
    queryKey: ['users', { q, ...filters }],
    queryFn: () =>
      listUsers({
        q: q || undefined,
        role: filters.role || undefined,
        status: filters.status,
        source: filters.source || undefined,
        page: filters.page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const users = query.data?.users || [];
  const total = query.data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Super Admin</p>
          <h1 className="mt-1 text-3xl">Users &amp; roles</h1>
        </div>
        <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
          <UserPlus size={18} aria-hidden="true" /> Add user
        </button>
      </div>

      <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto]">
        <label className="relative sm:col-span-2 lg:col-span-1">
          <span className="sr-only">Search users</span>
          <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, ITS number, employee ID or department"
            className="block min-h-tap w-full rounded-btn border border-line bg-white pl-10 pr-3 font-ui text-sm text-ink placeholder:text-ink-3 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
          />
        </label>
        <select aria-label="Role" className={selectClass} value={filters.role} onChange={setFilter('role')}>
          <option value="">All roles</option>
          <option value="SUPER_ADMIN">Super Admin</option>
          <option value="ADMIN">Admin</option>
          <option value="ENGINEER">Staff</option>
          <option value="EMPLOYEE">Employee</option>
        </select>
        <select aria-label="Status" className={selectClass} value={filters.status} onChange={setFilter('status')}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">Active and inactive</option>
        </select>
        <select aria-label="Source" className={selectClass} value={filters.source} onChange={setFilter('source')}>
          <option value="">All sources</option>
          <option value="idarah">Synced</option>
          <option value="legacy">Imported</option>
          <option value="manual">Added by hand</option>
        </select>
      </div>

      <div className="mt-3 flex min-h-[1.5rem] items-center gap-2 font-ui text-sm text-ink-2" aria-live="polite">
        {query.isFetching && <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />}
        {query.isSuccess && `${total} ${total === 1 ? 'user' : 'users'}`}
      </div>

      {query.isError && <Alert tone="error">{errorMessage(query.error, 'Could not load users.')}</Alert>}

      {query.isSuccess && users.length === 0 && (
        <div className="card mt-2 text-center font-ui text-sm text-ink-2">No users match these filters.</div>
      )}

      {users.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="card mt-2 hidden overflow-x-auto p-0 md:block">
            <table className="w-full font-ui text-sm">
              <thead className="bg-cream-dark text-left text-xs uppercase tracking-wider text-ink-3">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Signs in with</th>
                  <th className="px-4 py-3 font-medium">Department</th>
                  <th className="px-4 py-3 font-medium">Roles</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-gold-muted/40">
                    <td className="px-4 py-3">
                      <Link to={`/users/${u.id}`} className="font-medium text-primary hover:underline">
                        {u.name}
                      </Link>
                      <div className="text-xs text-ink-3">{SOURCE_LABELS[u.source]}</div>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-ink-2">{loginIdLabel(u)}</td>
                    <td className="max-w-[16rem] truncate px-4 py-3 text-ink-2" title={u.departments.join(', ')}>
                      {u.departments.join(', ') || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <RoleBadges user={u} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge active={u.isActive} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phone cards */}
          <ul className="mt-2 space-y-2 md:hidden">
            {users.map((u) => (
              <li key={u.id}>
                <Link to={`/users/${u.id}`} className="card block p-4 hover:border-gold">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-ui font-medium text-primary">{u.name}</span>
                    <StatusBadge active={u.isActive} />
                  </div>
                  <p className="mt-0.5 font-ui text-xs tabular-nums text-ink-3">
                    {loginIdLabel(u)} · {SOURCE_LABELS[u.source]}
                  </p>
                  {u.departments.length > 0 && <p className="mt-1 truncate font-ui text-sm text-ink-2">{u.departments.join(', ')}</p>}
                  <div className="mt-2">
                    <RoleBadges user={u} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {pages > 1 && (
            <nav className="mt-4 flex items-center justify-between font-ui text-sm" aria-label="Pages">
              <button
                type="button"
                className="btn-secondary"
                disabled={filters.page <= 1}
                onClick={() => goToPage(filters.page - 1)}
              >
                <ChevronLeft size={18} aria-hidden="true" /> Previous
              </button>
              <span className="text-ink-2">
                Page {filters.page} of {pages}
              </span>
              <button
                type="button"
                className="btn-secondary"
                disabled={filters.page >= pages}
                onClick={() => goToPage(filters.page + 1)}
              >
                Next <ChevronRight size={18} aria-hidden="true" />
              </button>
            </nav>
          )}
        </>
      )}

      {adding && <AddUserModal onClose={() => setAdding(false)} />}
    </section>
  );
}
