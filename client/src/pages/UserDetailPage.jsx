import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, KeyRound, LoaderCircle, Pencil, Power, ShieldAlert } from 'lucide-react';
import {
  getUser,
  grantRole,
  listServiceUnits,
  removeRole,
  resetUserPassword,
  setUserStatus,
  tagUnit,
  untagUnit,
  updateUser,
} from '../api/users';
import { errorMessage } from '../api/http';
import { Alert, Field, PasswordInput, TextInput } from '../components/FormControls';
import Modal from '../components/Modal';
import useAuth from '../hooks/useAuth';
import { formatDateTime, loginIdLabel, SOURCE_LABELS } from '../utils/format';
import { MIN_PASSWORD, newPasswordErrors } from '../utils/passwordRules';
import { roleBadgeClass, roleLabel } from '../utils/roles';

const ROLE_ORDER = ['EMPLOYEE', 'ENGINEER', 'SUPER_ADMIN'];
const ROLE_HELP = {
  EMPLOYEE: 'AI assistant, raise tickets and requests, track own items.',
  ENGINEER: 'Works on assigned tickets and requests in their service units.',
  SUPER_ADMIN: 'Everything: assign, close, approve, manage users, inventory and reports.',
};

function Section({ title, children, action }) {
  return (
    <section className="card">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl">{title}</h2>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

// A switch row (roles, service units). `busy` shows a spinner on the one being saved.
function Toggle({ on, label, help, disabled, busy, onClick, badgeClass }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-tap w-full items-center justify-between gap-3 rounded-btn border px-4 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        on ? 'border-primary bg-primary-tint' : 'border-line bg-white hover:border-gold'
      }`}
    >
      <span className="min-w-0">
        <span className={badgeClass || 'font-ui text-sm font-medium text-ink'}>{label}</span>
        {help && <span className="mt-0.5 block font-ui text-xs text-ink-2">{help}</span>}
      </span>
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
          on ? 'border-primary bg-primary text-white' : 'border-line-dark bg-white'
        }`}
        aria-hidden="true"
      >
        {busy ? <LoaderCircle size={14} className="animate-spin" /> : on && <Check size={14} />}
      </span>
    </button>
  );
}

function EditDetailsModal({ user, onClose, onSaved }) {
  const [form, setForm] = useState({ name: user.hasName ? user.name : '', email: user.email || '', mobile: user.mobile || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSaved(await updateUser(user.id, form));
      onClose();
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Edit details"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="edit-details" className="btn-primary" disabled={busy}>
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Save
          </button>
        </>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      <form id="edit-details" onSubmit={submit} className="mt-3 space-y-4" noValidate>
        <Field id="ed-name" label="Name" hint={user.employeeId ? `Leave empty to show "Employee ${user.employeeId}".` : undefined}>
          <TextInput id="ed-name" value={form.name} onChange={set('name')} maxLength={200} />
        </Field>
        <Field id="ed-email" label="Email" hint="Needed for the forgot-password email.">
          <TextInput id="ed-email" type="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field id="ed-mobile" label="Mobile">
          <TextInput id="ed-mobile" inputMode="tel" value={form.mobile} onChange={set('mobile')} />
        </Field>
      </form>
    </Modal>
  );
}

function StatusModal({ user, onClose, onSaved }) {
  const activating = !user.isActive;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSaved(await setUserStatus(user.id, activating, reason));
      onClose();
    } catch (err) {
      setError(errorMessage(err, 'Could not change the status.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={activating ? 'Activate user' : 'Deactivate user'}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="status-form" className={activating ? 'btn-primary' : 'btn-danger'} disabled={busy || reason.trim().length < 3}>
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />}
            {activating ? 'Activate' : 'Deactivate'}
          </button>
        </>
      }
    >
      <p className="font-ui text-sm text-ink-2">
        {activating
          ? `${user.name} will be able to sign in again.`
          : `${user.name} will be signed out on their next action and can't sign in. Nothing is deleted.`}
      </p>
      {!activating && user.source === 'idarah' && (
        <p className="mt-2 font-ui text-xs text-ink-3">The Idarah sync will not reactivate someone you deactivate here.</p>
      )}
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      <form id="status-form" onSubmit={submit} className="mt-4" noValidate>
        <Field id="reason" label="Reason" hint="Kept in the user's history.">
          <TextInput id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
      </form>
    </Modal>
  );
}

function PasswordModal({ user, onClose }) {
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const errors = touched ? newPasswordErrors(next, confirm) : {};

  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(newPasswordErrors(next, confirm)).length) return;
    setBusy(true);
    try {
      const r = await resetUserPassword(user.id, next);
      setResult({ tone: 'success', message: r.message });
    } catch (err) {
      setResult({ tone: 'error', message: errorMessage(err, 'Could not reset the password.') });
    } finally {
      setBusy(false);
    }
  }

  const done = result?.tone === 'success';

  return (
    <Modal
      title="Reset password"
      onClose={onClose}
      busy={busy}
      footer={
        done ? (
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" form="pw-form" className="btn-primary" disabled={busy}>
              {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Reset password
            </button>
          </>
        )
      }
    >
      {result && <Alert tone={result.tone}>{result.message}</Alert>}
      {!done && (
        <form id="pw-form" onSubmit={submit} className="mt-3 space-y-4" noValidate>
          <p className="font-ui text-sm text-ink-2">
            Sets a new password for {loginIdLabel(user)}. Any emailed reset link stops working.
          </p>
          <Field id="np" label="New password" hint={`At least ${MIN_PASSWORD} characters.`} error={errors.next}>
            <PasswordInput id="np" autoComplete="new-password" value={next} error={errors.next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field id="np2" label="Confirm new password" error={errors.confirm}>
            <PasswordInput id="np2" autoComplete="new-password" value={confirm} error={errors.confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        </form>
      )}
    </Modal>
  );
}

export default function UserDetailPage() {
  const { id } = useParams();
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState(null); // 'edit' | 'status' | 'password'
  const [pendingKey, setPendingKey] = useState(null);
  const [actionError, setActionError] = useState('');

  const userQuery = useQuery({ queryKey: ['users', 'detail', id], queryFn: () => getUser(id), retry: false });
  const unitsQuery = useQuery({ queryKey: ['service-units'], queryFn: listServiceUnits, staleTime: 5 * 60_000 });

  const saved = (fresh) => {
    queryClient.setQueryData(['users', 'detail', id], fresh);
    queryClient.invalidateQueries({ queryKey: ['users'], exact: false, refetchType: 'none' });
  };

  const mutation = useMutation({
    mutationFn: ({ fn }) => fn(),
    onMutate: ({ key }) => {
      setPendingKey(key);
      setActionError('');
    },
    onSuccess: (fresh) => saved(fresh),
    onError: (err) => setActionError(errorMessage(err, 'Could not save the change.')),
    onSettled: () => setPendingKey(null),
  });

  if (userQuery.isPending) {
    return (
      <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
        <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading…
      </p>
    );
  }
  if (userQuery.isError) {
    return (
      <div className="space-y-4">
        <Link to="/users" className="inline-flex items-center gap-1 font-ui text-sm text-primary hover:underline">
          <ArrowLeft size={16} aria-hidden="true" /> All users
        </Link>
        <Alert tone="error">{errorMessage(userQuery.error, 'Could not load this user.')}</Alert>
      </div>
    );
  }

  const u = userQuery.data;
  const isSelf = u.id === me.id;
  const busy = mutation.isPending;
  const toggleRole = (role) =>
    mutation.mutate({ key: `role:${role}`, fn: () => (u.roles.includes(role) ? removeRole(u.id, role) : grantRole(u.id, role)) });
  const toggleUnit = (unit) =>
    mutation.mutate({
      key: `unit:${unit.id}`,
      fn: () => (u.serviceUnits.some((s) => s.id === unit.id) ? untagUnit(u.id, unit.id) : tagUnit(u.id, unit.id)),
    });

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link to="/users" className="inline-flex items-center gap-1 font-ui text-sm text-primary hover:underline">
        <ArrowLeft size={16} aria-hidden="true" /> All users
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-3xl">{u.name}</h1>
          {u.nameArabic && (
            <p dir="rtl" lang="ar" className="font-arabic text-lg text-ink-2">
              {u.nameArabic}
            </p>
          )}
          <p className="mt-1 flex flex-wrap items-center gap-2 font-ui text-sm text-ink-2">
            <span className="tabular-nums">{loginIdLabel(u)}</span>
            <span aria-hidden="true">·</span>
            <span>{SOURCE_LABELS[u.source]}</span>
            <span className={u.isActive ? 'status-resolved' : 'status-closed'}>{u.isActive ? 'Active' : 'Inactive'}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {u.loginType === 'EMPLOYEE_ID' && (
            <button type="button" className="btn-secondary" onClick={() => setDialog('password')}>
              <KeyRound size={18} aria-hidden="true" /> Reset password
            </button>
          )}
          {!(isSelf && u.isActive) && (
            <button type="button" className={u.isActive ? 'btn-secondary text-error' : 'btn-primary'} onClick={() => setDialog('status')}>
              <Power size={18} aria-hidden="true" /> {u.isActive ? 'Deactivate' : 'Activate'}
            </button>
          )}
        </div>
      </header>

      {actionError && <Alert tone="error">{actionError}</Alert>}

      <Section
        title="Details"
        action={
          u.editable && (
            <button type="button" className="btn-secondary" onClick={() => setDialog('edit')}>
              <Pencil size={16} aria-hidden="true" /> Edit
            </button>
          )
        }
      >
        <dl className="grid gap-x-6 gap-y-3 font-ui text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink-3">Email</dt>
            <dd className="text-ink">{u.email || <span className="text-ink-3">Not on file</span>}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink-3">Mobile</dt>
            <dd className="tabular-nums text-ink">{u.mobile || <span className="text-ink-3">Not on file</span>}</dd>
          </div>
        </dl>
        {!u.editable && <p className="mt-3 font-ui text-xs text-ink-3">Name, email and mobile come from the Idarah view.</p>}
      </Section>

      <Section title="Roles">
        <div className="grid gap-2">
          {ROLE_ORDER.map((role) => {
            const on = u.roles.includes(role);
            const ownSa = isSelf && role === 'SUPER_ADMIN' && on;
            return (
              <Toggle
                key={role}
                on={on}
                label={roleLabel(role)}
                badgeClass={on ? roleBadgeClass(role) : undefined}
                help={ownSa ? 'You can\'t remove your own Super Admin role.' : ROLE_HELP[role]}
                disabled={busy || ownSa || (on && u.roles.length === 1)}
                busy={pendingKey === `role:${role}`}
                onClick={() => toggleRole(role)}
              />
            );
          })}
        </div>
        {u.roles.length === 1 && (
          <p className="mt-2 font-ui text-xs text-ink-3">Every user keeps at least one role. To stop access, deactivate instead.</p>
        )}
      </Section>

      {u.roles.includes('ENGINEER') && (
        <Section title="Service units">
          <p className="mb-3 font-ui text-sm text-ink-2">The teams this engineer works for. They only see work in these units.</p>
          {unitsQuery.isError && <Alert tone="error">Could not load service units.</Alert>}
          <div className="grid gap-2 sm:grid-cols-2">
            {(unitsQuery.data || []).map((unit) => (
              <Toggle
                key={unit.id}
                on={u.serviceUnits.some((s) => s.id === unit.id)}
                label={unit.name}
                help={unit.isActive ? undefined : 'Not live yet (backend only).'}
                disabled={busy}
                busy={pendingKey === `unit:${unit.id}`}
                onClick={() => toggleUnit(unit)}
              />
            ))}
          </div>
        </Section>
      )}

      <Section title="Departments & posts">
        {u.posts.length === 0 ? (
          <p className="font-ui text-sm text-ink-3">None.</p>
        ) : (
          <ul className="divide-y divide-line font-ui text-sm">
            {u.posts.map((p, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className={p.isActive ? 'text-ink' : 'text-ink-3 line-through'}>{p.department}</span>
                <span className="text-ink-2">
                  {[p.post, p.postTbq].filter(Boolean).join(' · ') || '—'}
                  {!p.isActive && <span className="ml-2 text-xs text-ink-3">(past)</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="History">
        {u.history.length === 0 ? (
          <p className="font-ui text-sm text-ink-3">No changes recorded.</p>
        ) : (
          <ol className="space-y-3 font-ui text-sm">
            {u.history.map((h, i) => (
              <li key={i} className="flex gap-3">
                <ShieldAlert size={16} className="mt-0.5 shrink-0 text-gold-dark" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-ink">
                    {h.text}
                    {h.reason && <span className="text-ink-2"> — “{h.reason}”</span>}
                  </p>
                  <p className="text-xs text-ink-3">
                    {formatDateTime(h.at)} · {h.by}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {dialog === 'edit' && <EditDetailsModal user={u} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog === 'status' && <StatusModal user={u} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog === 'password' && <PasswordModal user={u} onClose={() => setDialog(null)} />}
    </div>
  );
}

