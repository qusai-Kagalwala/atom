import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpDown, LoaderCircle, Send } from 'lucide-react';
import { getTimeFrames, triageTicket } from '../api/requests';
import { errorMessage } from '../api/http';
import { Alert, Field } from './FormControls';
import Modal from './Modal';
import { PRIORITIES, priorityBadge, priorityLabel } from '../utils/requests';
import { windowText } from '../utils/timeFrame';

const areaClass =
  'block w-full rounded-btn border border-line bg-white px-3 py-2 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';

// Super Admin: change a ticket's / request's priority, with an optional message. The requester and
// the engineer are told (in-app + email); the time frame is recalculated from when it was raised.
export default function PriorityChange({ ticket, onDone, compact = false }) {
  const frames = useQuery({ queryKey: ['time-frames'], queryFn: getTimeFrames, staleTime: 10 * 60_000 });
  const [open, setOpen] = useState(false);
  const [priority, setPriority] = useState(ticket.priority);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const frameOf = (p) => frames.data?.find((f) => f.priority === p);

  async function save() {
    setBusy(true);
    setError('');
    try {
      const fresh = await triageTicket(ticket.number, { priority, message });
      setOpen(false);
      onDone(fresh, `Priority changed to ${priorityLabel(priority)}. ${ticket.requester?.name || 'The requester'} has been told.`);
    } catch (err) {
      setError(errorMessage(err, 'Could not change the priority.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setPriority(ticket.priority);
          setMessage('');
          setError('');
          setOpen(true);
        }}
        className={compact ? 'inline-flex min-h-tap items-center gap-1 font-ui text-sm text-primary hover:underline' : 'btn-secondary'}
      >
        <ArrowUpDown size={16} aria-hidden="true" /> {compact ? 'Priority' : 'Change priority'}
      </button>
      {open && (
        <Modal
          title={`Priority of ${ticket.number}`}
          onClose={() => setOpen(false)}
          busy={busy}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={save} disabled={busy || priority === ticket.priority}>
                {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />} Change and notify
              </button>
            </>
          }
        >
          <div className="space-y-4">
            {error && <Alert tone="error">{error}</Alert>}
            <p className="font-ui text-sm text-ink-2">
              Now: <span className={priorityBadge(ticket.priority)}>{priorityLabel(ticket.priority)}</span>
            </p>
            <fieldset>
              <legend className="mb-1.5 font-ui text-sm font-medium text-ink">New priority</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {Object.keys(PRIORITIES).map((p) => (
                  <label
                    key={p}
                    className={`flex min-h-tap cursor-pointer flex-col items-center justify-center rounded-btn border px-3 py-1 text-center font-ui text-sm ${
                      priority === p ? 'border-primary bg-primary-tint text-primary' : 'border-line text-ink hover:border-gold'
                    }`}
                  >
                    <input type="radio" name="new-priority" value={p} checked={priority === p} onChange={() => setPriority(p)} className="sr-only" />
                    {priorityLabel(p)}
                    {frameOf(p) && <span className="text-xs text-ink-3">{windowText(frameOf(p))}</span>}
                  </label>
                ))}
              </div>
            </fieldset>
            <Field id="priority-message" label="Message to the requester (optional)" hint="Sent with the change, in the app and by email. The assigned staff member sees it too.">
              <textarea id="priority-message" rows={3} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} className={areaClass} />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}
