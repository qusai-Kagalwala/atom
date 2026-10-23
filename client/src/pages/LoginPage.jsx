import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { KeyRound, LoaderCircle } from 'lucide-react';
import { errorMessage } from '../api/http';
import AuthLayout from '../components/AuthLayout';
import { Alert, Field, PasswordInput, TextInput } from '../components/FormControls';
import useAuth from '../hooks/useAuth';

// Shown when another page sends the user back here (axios interceptor / role removal).
const URL_ERRORS = {
  session_expired: 'Your session has expired. Please sign in again.',
  removed: 'Your ATOM access has been removed.',
  role_changed: 'Your role has changed. Please sign in again.',
};

export default function LoginPage() {
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(() => URL_ERRORS[params.get('error')] || '');
  const notice = location.state?.notice; // e.g. after a password reset

  if (isAuthenticated) return <Navigate to="/" replace />;

  const canSubmit = identifier.length > 0 && password.length > 0 && !submitting;

  async function onSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setSubmitting(true);
    try {
      await login(identifier, password);
      const from = location.state?.from;
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Could not sign in. Please try again.'));
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      prompt="Sign in with your ITS number or Employee ID."
      below={
        <>
          <Link to="/forgot-password" className="font-medium text-primary hover:text-primary-dark hover:underline">
            Forgot password?
          </Link>
          <p className="mt-1 text-xs text-ink-3">Using your ITS number? Reset your password on eJamaat.</p>
        </>
      }
    >
      <div className="mt-5 space-y-3">
        {notice && !error && <Alert tone="success">{notice}</Alert>}
        {error && <Alert tone="error">{error}</Alert>}
      </div>

      <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
        <Field id="identifier" label="ITS number or Employee ID">
          <TextInput
            id="identifier"
            name="username"
            inputMode="numeric"
            autoComplete="username"
            autoFocus
            maxLength={12}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value.replace(/\D/g, ''))}
            className="tabular-nums"
            placeholder="e.g. 30328701"
          />
        </Field>

        <Field id="password" label="Password">
          <PasswordInput
            id="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <button type="submit" disabled={!canSubmit} className="btn-primary w-full">
          {submitting ? (
            <>
              <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Signing in…
            </>
          ) : (
            <>
              <KeyRound size={18} aria-hidden="true" /> Sign in
            </>
          )}
        </button>
      </form>
    </AuthLayout>
  );
}
