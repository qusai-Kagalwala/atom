import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, LoaderCircle, LogOut, Pencil } from 'lucide-react';
import { changePasswordRequest, sessionRequest, setNotifyKeepRequest, setNotifyRequest, signOutEverywhereRequest, updateContactRequest, updatePreferencesRequest } from '../api/auth';
import { saveToken } from '../auth/storage';
import { errorMessage } from '../api/http';
import { Alert, Field, PasswordInput, TextInput } from '../components/FormControls';
import DeviceCard from '../components/DeviceCard';
import ThemePicker from '../components/ThemePicker';
import UserName from '../components/UserName';
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

const notOnFile = <span className="text-ink-3">Not on file</span>;

// My email and mobile (7 Nov 2026): add or correct them; saved straight away, kept by the sync.
function ContactCard({ user }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ email: '', mobile: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const missing = !user.email || !user.mobile;

  function start() {
    setForm({ email: user.email || '', mobile: user.mobile || '' });
    setMsg(null);
    setEditing(true);
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const fresh = await updateContactRequest({ email: form.email, mobile: form.mobile });
      queryClient.setQueryData(['auth', 'me'], fresh);
      setEditing(false);
      setMsg({ tone: 'success', text: 'Saved.' });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not save.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" id="contact">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl">My contact details</h2>
        {!editing && (
          <button type="button" className="btn-secondary" onClick={start}>
            <Pencil size={16} aria-hidden="true" /> {missing ? 'Add' : 'Edit'}
          </button>
        )}
      </div>
      <p className="mt-1 font-ui text-sm text-ink-2">
        Used for emails from ATOM{user.loginType === 'EMPLOYEE_ID' ? ' and to reset your password' : ''}, and so staff can reach you about your requests.
      </p>
      {!editing ? (
        <dl className="mt-2 divide-y divide-line">
          <Detail label="Email">{user.email || notOnFile}</Detail>
          <Detail label="Mobile">{user.mobile ? <span className="tabular-nums">{user.mobile}</span> : notOnFile}</Detail>
        </dl>
      ) : (
        <form onSubmit={save} className="mt-3 space-y-4" noValidate>
          <Field id="ct-email" label="Email">
            <TextInput id="ct-email" type="email" autoComplete="email" maxLength={254} value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          </Field>
          <Field id="ct-mobile" label="Mobile" hint="10 digits, e.g. 9820012345.">
            <TextInput
              id="ct-mobile"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={16}
              value={form.mobile}
              onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Check size={18} aria-hidden="true" />} Save
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {msg && (
        <div className="mt-3">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
    </section>
  );
}

// How I get notified (6 Nov 2026): In app and / or Email — at least one on.
function NotifyCard({ user }) {
  const queryClient = useQueryClient();
  const [prefs, setPrefs] = useState(user.notify || { inApp: true, email: true });
  const [keep, setKeep] = useState(user.notify?.keepDays ? String(user.notify.keepDays) : '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function change(key, value) {
    const next = { ...prefs, [key]: value };
    if (!next.inApp && !next.email) {
      setMsg({ tone: 'error', text: 'Keep at least one way on.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const saved = await setNotifyRequest(next);
      setPrefs((p) => ({ ...p, ...saved }));
      setMsg({ tone: 'success', text: 'Saved.' });
      queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not save.') });
    } finally {
      setBusy(false);
    }
  }

  async function changeKeep(value) {
    setKeep(value);
    setBusy(true);
    setMsg(null);
    try {
      await setNotifyKeepRequest(value ? Number(value) : null);
      setMsg({ tone: 'success', text: value ? 'Saved. Older notifications will be cleared.' : 'Saved. Notifications are kept.' });
      queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not save.') });
    } finally {
      setBusy(false);
    }
  }

  const row = (key, label, hint) => (
    <label className="flex min-h-tap cursor-pointer items-start gap-3 py-2 font-ui text-sm text-ink">
      <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-brand" checked={prefs[key]} disabled={busy} onChange={(e) => change(key, e.target.checked)} />
      <span>
        {label}
        <span className="block text-xs text-ink-3">{hint}</span>
      </span>
    </label>
  );

  return (
    <section className="card">
      <h2 className="text-xl">How I get notified</h2>
      <p className="mt-1 font-ui text-sm text-ink-2">Choose one or both.</p>
      <div className="mt-3 divide-y divide-line">
        {row('inApp', 'In app', 'The bell count, pop-ups and phone notifications. Off: they still go to your Notifications list, already read.')}
        {row('email', 'Email', user.email ? `Sent to ${user.email}.` : 'No email address is on file for you, so nothing can be sent yet.')}
      </div>
      <div className="mt-3 border-t border-line pt-3">
        <Field id="notify-keep" label="Clear old notifications" hint="Notifications older than this are deleted from your list automatically.">
          <select
            id="notify-keep"
            className="block min-h-tap w-full rounded-btn border border-line bg-surface px-3 font-ui text-sm text-ink sm:w-64"
            value={keep}
            disabled={busy}
            onChange={(e) => changeKeep(e.target.value)}
          >
            <option value="">Never — keep them all</option>
            <option value="7">After 1 week</option>
            <option value="15">After 15 days</option>
            <option value="30">After 1 month</option>
          </select>
        </Field>
      </div>
      {msg && (
        <div className="mt-2">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
    </section>
  );
}

// This device's sign-in, and "Sign out of all other devices" (6 Nov 2026).
function SessionCard() {
  const me = useQuery({ queryKey: ['auth', 'me', 'session'], queryFn: sessionRequest });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  async function everywhere() {
    setBusy(true);
    setMsg(null);
    try {
      const { token } = await signOutEverywhereRequest();
      saveToken(token);
      setMsg({ tone: 'success', text: 'Every other device is signed out. This one stays signed in.' });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not do that.') });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2 className="text-xl">Signed in</h2>
      <p className="mt-1 font-ui text-sm text-ink-2">
        {me.data?.keepSignedIn
          ? 'This device stays signed in until you sign out (or don’t open ATOM for 90 days).'
          : 'This device signs out 8 hours after you signed in. Tick “Keep me signed in” on the sign-in page to stay signed in.'}
      </p>
      <p className="mt-2 font-ui text-sm text-ink-2">Lost a phone, or signed in on someone else’s computer? Sign out everywhere else:</p>
      <button type="button" className="btn-secondary mt-3" disabled={busy} onClick={everywhere}>
        {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <LogOut size={18} aria-hidden="true" />} Sign out of all other devices
      </button>
      {msg && (
        <div className="mt-3">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
    </section>
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
      <p className="mt-1 font-ui text-sm text-ink-2">Optional. You'll stay signed in on this device; other devices will be signed out.</p>

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

// Which of your two names ATOM shows for you (only when an Arabic name is on file).
function NameLanguageCard({ user }) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState('');

  async function choose(nameLanguage) {
    if (nameLanguage === user.nameLanguage || saving) return;
    setError('');
    setSaving(nameLanguage);
    try {
      const fresh = await updatePreferencesRequest({ nameLanguage });
      queryClient.setQueryData(['auth', 'me'], fresh);
    } catch (err) {
      setError(errorMessage(err, 'Could not save your choice.'));
    } finally {
      setSaving(null);
    }
  }

  const options = [
    { value: 'en', label: user.name, dir: 'ltr', font: 'font-ui' },
    { value: 'ar', label: user.nameArabic, dir: 'rtl', font: 'font-arabic text-lg' },
  ];

  return (
    <section className="card">
      <h2 className="text-xl">Show my name in</h2>
      <p className="mt-1 font-ui text-sm text-ink-2">Used on your home page and in the top bar.</p>
      <div role="radiogroup" aria-label="Show my name in" className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {options.map((o) => {
          const selected = user.nameLanguage === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={Boolean(saving)}
              onClick={() => choose(o.value)}
              className={`flex min-h-tap w-full min-w-0 items-center justify-between gap-3 rounded-btn border px-4 py-3 text-left transition-colors ${
                selected ? 'border-brand bg-primary-tint' : 'border-line bg-surface hover:border-gold'
              }`}
            >
              <span className="min-w-0">
                <span className="block font-ui text-xs uppercase tracking-wider text-ink-3">
                  {o.value === 'en' ? 'English' : 'Arabic'}
                </span>
                <span dir={o.dir} lang={o.value} className={`block truncate text-ink ${o.font}`}>
                  {o.label}
                </span>
              </span>
              {saving === o.value ? (
                <LoaderCircle size={18} className="shrink-0 animate-spin text-ink-3" aria-hidden="true" />
              ) : (
                selected && <Check size={18} className="shrink-0 text-brand" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
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
        <h1 className="mt-1 text-3xl">
          <UserName user={user} />
        </h1>
      </header>

      <section className="card">
        <dl className="divide-y divide-line">
          <Detail label={isIts ? 'ITS number' : 'Employee ID'}>
            <span className="tabular-nums">{isIts ? user.itsNumber : user.employeeId}</span>
            <span
              className={`badge ml-2 border bg-surface ${isIts ? 'border-brand text-brand' : 'border-gold-dark text-gold-dark'}`}
            >
              {isIts ? 'ITS' : 'Employee ID'}
            </span>
          </Detail>
          <Detail label="Roles">
            <span className="flex flex-wrap gap-1.5">
              {sortRoles(user.roles).map((role) => (
                <span key={role} className={roleBadgeClass(role)}>
                  {roleLabel(role, user)}
                  {user.staffCompany && (role === 'ADMIN' || role === 'ENGINEER') ? ` · ${user.staffCompany.name}` : ''}
                </span>
              ))}
            </span>
          </Detail>
        </dl>
      </section>

      <ContactCard user={user} />

      {user.nameArabic && <NameLanguageCard user={user} />}

      <section className="card" id="appearance">
        <h2 className="text-xl">Appearance</h2>
        <p className="mt-1 font-ui text-sm text-ink-2">Pick a colour and light or dark. Your choice is saved to your account, so it follows you to other devices.</p>
        <div className="mt-4">
          <ThemePicker />
        </div>
      </section>

      <NotifyCard user={user} />

      <DeviceCard />

      <SessionCard />

      {isIts ? (
        <Alert tone="info">Your password is managed by ITS. Change or reset it there.</Alert>
      ) : (
        <ChangePasswordCard />
      )}
    </div>
  );
}
