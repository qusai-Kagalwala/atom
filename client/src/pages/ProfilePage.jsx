import { useState } from 'react';
import { KeyRound, LoaderCircle } from 'lucide-react';
import { changePasswordRequest } from '../api/auth';
import { errorMessage } from '../api/http';
import { Alert, Field, PasswordInput } from '../components/FormControls';
import useAuth from '../hooks/useAuth';
import { MIN_PASSWORD, newPasswordErrors } from '../utils/passwordRules';
import { roleBadgeClass, roleLabel, sortRoles } from '../utils/roles';

function Detail({ label, children }) {
  return (
    <div className="flex flex-col gap-0.5 py-3 sm:flex-row sm:items-center sm:gap-4">
      <dt className="w-40 shrink-0 font-ui text-xs uppercase tracking-wider text-ink-3">{label}</dt>
      <dd className="font-ui text-sm text-ink">{children}</dd>
    </div>
  );
}

// Change password is optional and only for employee-ID users (Decisions §2).
function ChangePasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  const fieldErrors = touched ? newPasswordErrors(next, confirm) : {};

  async function onSubmit(e) {
    e.preventDefault();
    setTouched(true);
    if (!current || Object.keys(newPasswordErrors(next, confirm)).length || submitting) return;
    setResult(null);
    setSubmitting(true);
    try {
      const data = await changePasswordRequest(current, next);
      setResult({ tone: 'success', message: data.message });
      setCurrent('');
      setNext('');
      setConfirm('');
      setTouched(false);
    } catch (err) {
      setResult({ tone: 'error', message: errorMessage(err, 'Could not change your password.') });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card">
      <h2 className="text-xl">Change password</h2>
      <p className="mt-1 font-ui text-sm text-ink-2">Optional. You'll stay signed in on this device.</p>

      {result && (
        <div className="mt-4">
          <Alert tone={result.tone}>{result.message}</Alert>
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-4 max-w-sm space-y-4" noValidate>
        <Field id="current-password" label="Current password" error={touched && !current ? 'Enter your current password.' : ''}>
          <PasswordInput
            id="current-password"
            autoComplete="current-password"
            value={current}
            error={touched && !current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field id="new-password" label="New password" hint={`At least ${MIN_PASSWORD} characters.`} error={fieldErrors.next}>
          <PasswordInput
            id="new-password"
            autoComplete="new-password"
            value={next}
            error={fieldErrors.next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field id="confirm-password" label="Confirm new password" error={fieldErrors.confirm}>
          <PasswordInput
            id="confirm-password"
            autoComplete="new-password"
            value={confirm}
            error={fieldErrors.confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting ? (
            <>
              <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Saving…
            </>
          ) : (
            <>
              <KeyRound size={18} aria-hidden="true" /> Change password
            </>
          )}
        </button>
      </form>
    </section>
  );
}

export default function ProfilePage() {
  const { user } = useAuth();
  const isIts = user.loginType === 'ITS';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Profile</p>
        <h1 className="mt-1 text-3xl">{user.name}</h1>
      </header>

      <section className="card">
        <dl className="divide-y divide-line">
          <Detail label={isIts ? 'ITS number' : 'Employee ID'}>
            <span className="tabular-nums">{isIts ? user.itsNumber : user.employeeId}</span>
            <span
              className={`badge ml-2 border bg-white ${isIts ? 'border-primary text-primary' : 'border-gold-dark text-gold-dark'}`}
            >
              {isIts ? 'ITS' : 'Employee ID'}
            </span>
          </Detail>
          <Detail label="Email">{user.email || <span className="text-ink-3">Not on file</span>}</Detail>
          <Detail label="Roles">
            <span className="flex flex-wrap gap-1.5">
              {sortRoles(user.roles).map((role) => (
                <span key={role} className={roleBadgeClass(role)}>
                  {roleLabel(role)}
                </span>
              ))}
            </span>
          </Detail>
        </dl>
      </section>

      {isIts ? (
        <Alert tone="info">Your password is managed by eJamaat. Change or reset it there.</Alert>
      ) : (
        <ChangePasswordCard />
      )}
    </div>
  );
}
