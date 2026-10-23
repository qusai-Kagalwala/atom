import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { KeyRound, LoaderCircle } from 'lucide-react';
import { resetPasswordRequest } from '../api/auth';
import { errorMessage } from '../api/http';
import AuthLayout from '../components/AuthLayout';
import { Alert, Field, PasswordInput } from '../components/FormControls';
import { MIN_PASSWORD, newPasswordErrors } from '../utils/passwordRules';

// Opened from the reset email: /Atom/reset-password?token=…
export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') || '';

  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [linkDead, setLinkDead] = useState(!token);

  const fieldErrors = touched ? newPasswordErrors(next, confirm) : {};

  async function onSubmit(e) {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(newPasswordErrors(next, confirm)).length || submitting) return;
    setError('');
    setSubmitting(true);
    try {
      const data = await resetPasswordRequest(token, next);
      navigate('/login', { replace: true, state: { notice: data.message } });
    } catch (err) {
      if (err.response?.data?.code === 'bad_link') setLinkDead(true);
      setError(errorMessage(err, 'Could not reset your password. Please try again.'));
      setSubmitting(false);
    }
  }

  const backLinks = (
    <>
      <Link to="/forgot-password" className="font-medium text-primary hover:text-primary-dark hover:underline">
        Request a new link
      </Link>
      <span className="mx-2 text-ink-3">·</span>
      <Link to="/login" className="font-medium text-primary hover:text-primary-dark hover:underline">
        Sign in
      </Link>
    </>
  );

  if (linkDead) {
    return (
      <AuthLayout below={backLinks}>
        <div className="mt-5">
          <Alert tone="error">
            {error || 'This reset link is invalid or has expired. Please request a new one.'}
          </Alert>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout prompt="Choose a new password for your Employee ID." below={backLinks}>
      {error && (
        <div className="mt-5">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
        <Field id="new-password" label="New password" hint={`At least ${MIN_PASSWORD} characters.`} error={fieldErrors.next}>
          <PasswordInput
            id="new-password"
            autoComplete="new-password"
            autoFocus
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

        <button type="submit" disabled={submitting} className="btn-primary w-full">
          {submitting ? (
            <>
              <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Saving…
            </>
          ) : (
            <>
              <KeyRound size={18} aria-hidden="true" /> Set new password
            </>
          )}
        </button>
      </form>
    </AuthLayout>
  );
}
