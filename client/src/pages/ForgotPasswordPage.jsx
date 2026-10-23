import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LoaderCircle, Mail } from 'lucide-react';
import { forgotPasswordRequest } from '../api/auth';
import { errorMessage } from '../api/http';
import AuthLayout from '../components/AuthLayout';
import { Alert, Field, TextInput } from '../components/FormControls';

// Employee-ID users only. ITS users reset on eJamaat.
export default function ForgotPasswordPage() {
  const [employeeId, setEmployeeId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { tone, message }

  async function onSubmit(e) {
    e.preventDefault();
    if (!employeeId || submitting) return;
    setResult(null);
    setSubmitting(true);
    try {
      const data = await forgotPasswordRequest(employeeId);
      setResult({ tone: data.sent ? 'success' : 'info', message: data.message });
    } catch (err) {
      setResult({ tone: 'error', message: errorMessage(err, 'Could not send the reset link. Please try again.') });
    } finally {
      setSubmitting(false);
    }
  }

  const sent = result?.tone === 'success';

  return (
    <AuthLayout
      prompt="Enter your Employee ID. If an email is on file, we'll send you a reset link."
      below={
        <>
          <Link to="/login" className="font-medium text-primary hover:text-primary-dark hover:underline">
            Back to sign in
          </Link>
          <p className="mt-1 text-xs text-ink-3">Using your ITS number? Reset your password on eJamaat.</p>
        </>
      }
    >
      {result && (
        <div className="mt-5">
          <Alert tone={result.tone}>{result.message}</Alert>
        </div>
      )}

      {!sent && (
        <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
          <Field id="employeeId" label="Employee ID">
            <TextInput
              id="employeeId"
              name="username"
              inputMode="numeric"
              autoComplete="username"
              autoFocus
              maxLength={12}
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value.replace(/\D/g, ''))}
              className="tabular-nums"
            />
          </Field>

          <button type="submit" disabled={!employeeId || submitting} className="btn-primary w-full">
            {submitting ? (
              <>
                <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Sending…
              </>
            ) : (
              <>
                <Mail size={18} aria-hidden="true" /> Send reset link
              </>
            )}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
