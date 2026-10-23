import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, KeyRound, LoaderCircle } from 'lucide-react';
import { errorMessage } from '../api/http';
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
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(() => URL_ERRORS[params.get('error')] || '');

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

  const year = new Date().getFullYear();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-cream px-4 py-10">
      <div className="card w-full max-w-sm p-6 sm:p-8">
        <header className="text-center">
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Aljamea-tus-Saifiyah</p>
          <h1 className="mt-2 text-4xl">ATOM</h1>
          <p className="mt-1 font-ui text-sm text-ink-2">AVIT Ticketing &amp; Operations Manager</p>
          <div className="mt-4 flex items-center justify-center gap-3 text-gold" aria-hidden="true">
            <span className="h-px w-12 bg-gold/50" />
            <span className="text-xs">◆</span>
            <span className="h-px w-12 bg-gold/50" />
          </div>
          <p className="mt-4 font-ui text-sm text-ink-2">Sign in with your ITS number or Employee ID.</p>
        </header>

        {error && (
          <div role="alert" className="mt-5 rounded-btn border border-error/20 bg-error-bg px-3 py-2.5 font-ui text-sm text-error">
            {error}
          </div>
        )}

        <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
          <div>
            <label htmlFor="identifier" className="mb-1.5 block font-ui text-sm font-medium text-ink">
              ITS number or Employee ID
            </label>
            <input
              id="identifier"
              name="username"
              inputMode="numeric"
              autoComplete="username"
              autoFocus
              maxLength={12}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value.replace(/\D/g, ''))}
              className="block min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui tabular-nums text-ink placeholder:text-ink-3 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
              placeholder="e.g. 30328701"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block font-ui text-sm font-medium text-ink">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                maxLength={256}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="block min-h-tap w-full rounded-btn border border-line bg-white py-0 pl-3 pr-12 font-ui text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-0 flex min-w-tap items-center justify-center text-ink-3 hover:text-ink"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

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

        <div className="mt-5 text-center font-ui text-sm">
          <Link to="/forgot-password" className="font-medium text-primary hover:text-primary-dark hover:underline">
            Forgot password?
          </Link>
          <p className="mt-1 text-xs text-ink-3">Using your ITS number? Reset your password on eJamaat.</p>
        </div>
      </div>

      <footer className="mt-6 text-center font-ui text-xs text-ink-3">
        <p>Access is restricted to authorised AJSM staff only.</p>
        <p className="mt-1">
          © {year} Aljamea-tus-Saifiyah · ATOM v{import.meta.env.VITE_ATOM_VERSION}
        </p>
      </footer>
    </div>
  );
}
