import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Send } from 'lucide-react';
import { departmentView, requestMore } from '../../api/wifi';
import { errorMessage } from '../../api/http';
import { Alert, Field, TextInput } from '../FormControls';
import { formatDateTime } from '../../utils/format';
import Countdown from './Countdown';
import GivePasses from './GivePasses';
import PassList from './PassList';

const STATUS = { open: ['Waiting', 'status-waiting'], done: ['Done', 'status-resolved'], declined: ['Declined', 'status-rejected'] };

// HOD (Masool): the department's passes, give them out, share them, ask for more.
export default function HodView({ department }) {
  const queryClient = useQueryClient();
  const key = ['wifi', 'department', department.id];
  const q = useQuery({ queryKey: key, queryFn: () => departmentView(department.id) });
  const [req, setReq] = useState({ count: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  async function ask(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      queryClient.setQueryData(key, await requestMore(department.id, { count: Number(req.count), reason: req.reason }));
      setReq({ count: '', reason: '' });
      setMsg({ tone: 'success', text: 'Request sent to AVIT.' });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not send the request.') });
    } finally {
      setBusy(false);
    }
  }

  if (q.isPending) return <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />;
  if (q.isError) return <Alert tone="error">Could not load the passes.</Alert>;
  const { batches, passes, requests } = q.data;
  const available = batches.filter((b) => b.left > 0);
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {batches.length === 0 && <p className="font-ui text-sm text-ink-2">No passes for {department.name} right now. Ask AVIT for some below.</p>}
        {batches.map((b) => (
          <div key={b.id} className="card space-y-1">
            <p className="font-ui text-xs uppercase tracking-wider text-ink-3">{b.ssid}</p>
            <h3 className="text-xl">{b.name}</h3>
            <p className="font-ui text-sm text-ink-2">
              <strong className="text-2xl text-ink">{b.left}</strong> left of {b.allocated} · {b.given} given
            </p>
            <Countdown to={b.expiresAt} />
          </div>
        ))}
      </div>

      <section className="card space-y-3">
        <h2 className="text-xl">Give passes</h2>
        <GivePasses
          batches={available}
          departmentId={department.id}
          onDone={refresh}
        />
      </section>

      <section className="card space-y-3">
        <h2 className="text-xl">Given passes</h2>
        <PassList passes={passes} onChanged={refresh} />
      </section>

      <section className="card space-y-3">
        <h2 className="text-xl">Need more?</h2>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <form onSubmit={ask} className="grid gap-3 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
          <Field id="req-count" label="How many">
            <TextInput id="req-count" type="number" min="1" value={req.count} onChange={(e) => setReq((r) => ({ ...r, count: e.target.value }))} />
          </Field>
          <Field id="req-reason" label="What for">
            <TextInput id="req-reason" maxLength={500} value={req.reason} onChange={(e) => setReq((r) => ({ ...r, reason: e.target.value }))} placeholder="e.g. Visitors for the Urs programme on Friday" />
          </Field>
          <button type="submit" className="btn-primary sm:mb-6" disabled={busy || !(Number(req.count) > 0) || req.reason.trim().length < 3}>
            {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />} Ask AVIT
          </button>
        </form>
        {requests.length > 0 && (
          <ul className="divide-y divide-line font-ui text-sm">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span>
                  {r.count} passes · {r.reason}
                  <span className="block text-xs text-ink-3">
                    {formatDateTime(r.at)}
                    {r.note && ` · ${r.note}`}
                  </span>
                </span>
                <span className={STATUS[r.status][1]}>{STATUS[r.status][0]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
