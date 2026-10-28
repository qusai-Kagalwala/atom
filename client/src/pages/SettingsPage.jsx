import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Mail, Save, Timer } from 'lucide-react';
import { getSettings, saveTimeFrames, setEmailEnabled } from '../api/settings';
import { errorMessage } from '../api/http';
import { Alert, TextInput } from '../components/FormControls';
import { priorityLabel } from '../utils/requests';
import { windowText } from '../utils/timeFrame';
import { formatDateTime } from '../utils/format';

// Minutes ↔ "hours" in the form (whole minutes stored).
const toHours = (m) => String(Math.round((m / 60) * 100) / 100);
const toMinutes = (h) => Math.round(Number(h) * 60);

function TimeFrames({ frames, onSaved }) {
  const [rows, setRows] = useState(() => frames.map((f) => ({ priority: f.priority, from: toHours(f.minMinutes), to: toHours(f.maxMinutes) })));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const set = (p, k) => (e) => setRows((r) => r.map((x) => (x.priority === p ? { ...x, [k]: e.target.value } : x)));

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await saveTimeFrames(rows.map((r) => ({ priority: r.priority, minMinutes: toMinutes(r.from), maxMinutes: toMinutes(r.to) })));
      setMsg({ tone: 'success', text: 'Saved. New tickets and priority changes use these times.' });
      onSaved();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not save.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-xl">
          <Timer size={20} aria-hidden="true" /> Time frames
        </h2>
        <p className="font-ui text-sm text-ink-2">
          Counted 24/7 from when a ticket or request is raised until it is done. Past “up to” it shows as overdue, and Super Admins and the engineer are told.
        </p>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.priority} className="grid items-end gap-2 font-ui text-sm sm:grid-cols-[8rem_1fr_1fr_1fr]">
            <span className="font-medium text-ink sm:pb-3">{priorityLabel(r.priority)}</span>
            <label>
              <span className="mb-1 block text-xs text-ink-3">From (hours)</span>
              <TextInput type="number" min="0" step="0.25" value={r.from} onChange={set(r.priority, 'from')} aria-label={`${priorityLabel(r.priority)} from, hours`} />
            </label>
            <label>
              <span className="mb-1 block text-xs text-ink-3">Up to (hours)</span>
              <TextInput type="number" min="0.25" step="0.25" value={r.to} onChange={set(r.priority, 'to')} aria-label={`${priorityLabel(r.priority)} up to, hours`} />
            </label>
            <span className="text-ink-2 sm:pb-3">= {windowText({ minMinutes: toMinutes(r.from) || 0, maxMinutes: toMinutes(r.to) || 0 })}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <button type="button" className="btn-primary" onClick={save} disabled={busy}>
          {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Save size={18} aria-hidden="true" />} Save time frames
        </button>
      </div>
    </section>
  );
}

function Email({ email, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function toggle(on) {
    setBusy(true);
    setError('');
    try {
      await setEmailEnabled(on);
      onChanged();
    } catch (err) {
      setError(errorMessage(err, 'Could not change it.'));
    } finally {
      setBusy(false);
    }
  }
  const STATUS = { sent: 'status-resolved', queued: 'status-waiting', failed: 'status-rejected' };
  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl">
            <Mail size={20} aria-hidden="true" /> Email notifications
          </h2>
          <p className="font-ui text-sm text-ink-2">Every in-app notification is also emailed to people who have an email address in ATOM.</p>
        </div>
        <label className="flex min-h-tap items-center gap-2 font-ui text-sm font-medium">
          <input type="checkbox" role="switch" checked={email.emailEnabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} className="h-6 w-6 rounded border-line text-primary" />
          {email.emailEnabled ? 'Email is on' : 'Email is off'}
        </label>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {!email.smtpConfigured && (
        <Alert tone="info">SMTP is not set in the server .env (SMTP_HOST, SMTP_FROM…). Emails wait in the queue and are sent once it is set.</Alert>
      )}
      <p className="font-ui text-sm text-ink-2">
        Waiting {email.counts.queued} · sent today {email.counts.sentToday} · failed this week {email.counts.failedThisWeek}
      </p>
      {email.emails.length > 0 && (
        <ul className="divide-y divide-line font-ui text-sm">
          {email.emails.map((m) => (
            <li key={m.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="block text-ink">{m.subject}</span>
                <span className="block text-xs text-ink-3">
                  {m.to} · {formatDateTime(m.at)}
                  {m.error && ` · ${m.error}`}
                </span>
              </span>
              <span className={STATUS[m.status]}>{m.status === 'queued' ? 'Waiting' : m.status === 'sent' ? 'Sent' : 'Failed'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Super Admin: time frames per priority and email notifications.
export default function SettingsPage() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: getSettings });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['settings'] });
    queryClient.invalidateQueries({ queryKey: ['time-frames'] });
  };
  return (
    <section className="space-y-5">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Super Admin</p>
        <h1 className="mt-1 text-3xl">Settings</h1>
      </div>
      {q.isPending && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
      {q.isError && <Alert tone="error">Could not load settings.</Alert>}
      {q.data && (
        <>
          <TimeFrames key={q.data.timeFrames.map((f) => f.updatedAt).join()} frames={q.data.timeFrames} onSaved={refresh} />
          <Email email={q.data.email} onChanged={refresh} />
        </>
      )}
    </section>
  );
}
