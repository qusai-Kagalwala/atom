import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, LoaderCircle, LogOut } from 'lucide-react';
import { changePasswordRequest, meRequest } from '../api/auth';
import { errorMessage } from '../api/http';
import { saveUser } from '../auth/storage';
import AuthLayout from '../components/AuthLayout';
import { Alert, Field, PasswordInput } from '../components/FormControls';
import useAuth from '../hooks/useAuth';
import { MIN_PASSWORD, newPasswordErrors } from '../utils/passwordRules';

// First sign-in with a temporary password (the Employee ID, or one a Super Admin gave):
// the person must choose their own before anything else in ATOM works (Phase 3.1).
export default function SetPasswordPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!user.mustChangePassword) return <Navigate to="/" replace />;

  const check = () => {
    const e = newPasswordErrors(next, confirm);
    if (!current) e.current = 'Enter the password you signed in with.';
    if (!e.next && user.employeeId && next === user.employeeId) e.next = "Your new password can't be your Employee ID.";
    return e;
  };
  const errors = touched ? check() : {};

  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(check()).length) return;
    setBusy(true);
    setError('');
    try {
      await changePasswordRequest(current, next); // saves the fresh token
      const fresh = await meRequest();
      saveUser(fresh);
      queryClient.setQueryData(['auth', 'me'], fresh);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Could not set your password.'));
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      prompt="Welcome! You signed in with a temporary password. Choose your own to continue."
      below={
        <button type="button" onClick={logout} className="inline-flex items-center gap-1 text-primary hover:underline">
          <LogOut size={14} aria-hidden="true" /> Sign out
        </button>
      }
    >
      {error && (
        <div className="mt-5">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
        <p className="font-ui text-sm text-ink-2">
          Employee ID <span className="tabular-nums font-medium text-ink">{user.employeeId}</span>
        </p>
        <Field id="current" label="Temporary password" hint="Your Employee ID, or the password a Super Admin gave you." error={errors.current}>
          <PasswordInput id="current" autoComplete="current-password" value={current} error={errors.current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field id="next" label="New password" hint={`At least ${MIN_PASSWORD} characters.`} error={errors.next}>
          <PasswordInput id="next" autoComplete="new-password" value={next} error={errors.next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field id="confirm" label="Confirm new password" error={errors.confirm}>
          <PasswordInput id="confirm" autoComplete="new-password" value={confirm} error={errors.confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <button type="submit" disabled={busy} className="btn-primary w-full">
          {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <KeyRound size={18} aria-hidden="true" />}
          Set password and continue
        </button>
      </form>
    </AuthLayout>
  );
}
