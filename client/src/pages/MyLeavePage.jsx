import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, LoaderCircle, Send, X } from 'lucide-react';
import { applyLeave, cancelLeave, myLeave } from '../api/leave';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import LeaveCard from '../components/LeaveCard';
import { leaveDay } from '../utils/leave';

const selectClass = 'block min-h-tap w-full rounded-btn border border-line bg-surface px-3 font-ui text-sm text-ink';

// Staff: apply for leave (the Admin approves it), see and cancel your own leave.
export default function MyLeavePage() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['leave', 'mine'], queryFn: myLeave });
  const [form, setForm] = useState({ type: 'LEAVE', startDate: '', endDate: '', note: '' });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const set = (patch) => {
    setMsg(null);
    setForm((f) => ({ ...f, ...patch }));
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['leave'] });

  async function submit(e) {
    e.preventDefault();
    setBusy('apply');
    setMsg(null);
    try {
      await applyLeave({ ...form, endDate: form.endDate || form.startDate });
      setForm({ type: form.type, startDate: '', endDate: '', note: '' });
      setMsg({ tone: 'success', text: 'Sent to your Admin for approval. You will be told when it is decided.' });
      refresh();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not send it.') });
    } finally {
      setBusy('');
    }
  }

  async function cancel(id) {
    setBusy(id);
    setMsg(null);
    try {
      await cancelLeave(id);
      setMsg({ tone: 'success', text: 'Leave cancelled.' });
      refresh();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not cancel it.') });
    } finally {
      setBusy('');
    }
  }

  const data = q.data;
  const ready = form.type && form.startDate && (!form.endDate || form.endDate >= form.startDate);

  return (
    <section className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-3xl">
          <CalendarDays size={26} className="text-brand" aria-hidden="true" /> My leave
        </h1>
        <p className="mt-1 font-ui text-sm text-ink-2">Ask for leave with the dates. It counts only once your Admin approves it; while you are on leave no work is given to you.</p>
      </div>

      {q.isPending && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
      {q.isError && <Alert tone="error">{errorMessage(q.error, 'Leave is only for staff of this company.')}</Alert>}

      {data?.onLeave && <Alert tone="info">You are on leave until {leaveDay(data.onLeave.endDate)}.</Alert>}

      {data && (
        <form onSubmit={submit} className="card space-y-4">
          <h2 className="text-xl">Ask for leave</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field id="lv-type" label="Type">
              <select id="lv-type" className={selectClass} value={form.type} onChange={(e) => set({ type: e.target.value })}>
                {Object.entries(data.types).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="lv-start" label="First day">
              <TextInput id="lv-start" type="date" min={data.today} value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} />
            </Field>
            <Field id="lv-end" label="Last day" hint="Leave empty for one day.">
              <TextInput id="lv-end" type="date" min={form.startDate || data.today} value={form.endDate} onChange={(e) => set({ endDate: e.target.value })} />
            </Field>
          </div>
          <Field id="lv-note" label="Note (optional)">
            <TextInput id="lv-note" maxLength={500} value={form.note} placeholder="e.g. Family function in Surat" onChange={(e) => set({ note: e.target.value })} />
          </Field>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          <button type="submit" className="btn-primary" disabled={!ready || Boolean(busy)}>
            {busy === 'apply' ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />} Send for approval
          </button>
        </form>
      )}

      {data && (
        <div>
          <h2 className="text-xl">My leave</h2>
          {!data.leaves.length && <p className="mt-2 font-ui text-sm text-ink-3">Nothing yet.</p>}
          <ul className="mt-3 space-y-3">
            {data.leaves.map((l) => (
              <LeaveCard key={l.id} leave={l}>
                {(l.status === 'PENDING' || (l.status === 'APPROVED' && l.startDate > data.today)) && l.endDate >= data.today && (
                  <button type="button" className="btn-secondary" disabled={Boolean(busy)} onClick={() => cancel(l.id)}>
                    {busy === l.id ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <X size={16} aria-hidden="true" />} Cancel
                  </button>
                )}
              </LeaveCard>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
