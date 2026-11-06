import { useMemo, useState } from 'react';
import { LoaderCircle, Users } from 'lucide-react';
import { sendToPool } from '../api/requests';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from './FormControls';
import Modal from './Modal';

const leaveDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// Send an unassigned ticket to a pool (Phase 2): whole occupations (Engineer, Software development, Help desk…),
// everyone available, and/or chosen people. Staff on leave are never in it. The first to "Take it" gets it;
// after 12 hours with no taker it goes to the member with the fewest ongoing tickets.
//   staff: [{ id, name, occupation, occupationId, open_work, onLeaveUntil }] (the eligible-engineers list)
export default function PoolDialog({ ticket, staff = [], onClose, onDone }) {
  const occupations = useMemo(() => {
    const m = new Map();
    for (const s of staff) {
      const key = s.occupationId || s.occupation;
      if (!m.has(key)) m.set(key, { id: s.occupationId, name: s.occupation || 'Staff', people: [] });
      m.get(key).people.push(s);
    }
    return [...m.values()];
  }, [staff]);
  const [everyone, setEveryone] = useState(false);
  const [occIds, setOccIds] = useState(() =>
    ticket.suggestedOccupationId && occupations.some((o) => o.id === ticket.suggestedOccupationId) ? [ticket.suggestedOccupationId] : []
  );
  const [people, setPeople] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const available = staff.filter((s) => !s.onLeaveUntil);
  const members = available.filter((s) => everyone || occIds.includes(s.occupationId) || people.includes(s.id));
  const ready = members.length > 0 && (everyone || occIds.length > 0 || people.length >= 2);
  const toggle = (list, set, id) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  async function submit(e) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      const fresh = await sendToPool(ticket.number, { all: everyone, occupationIds: everyone ? [] : occIds, engineerIds: everyone ? [] : people, note });
      onDone(fresh, `${ticket.number} sent to ${members.length} ${members.length === 1 ? 'person' : 'people'}. The first to take it gets it.`);
    } catch (err) {
      setError(errorMessage(err, 'Could not send it to the pool.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Send ${ticket.number} to a pool`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="pool-form" className="btn-primary" disabled={!ready || busy}>
            {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Users size={18} aria-hidden="true" />} Send to {members.length || ''}{' '}
            {members.length === 1 ? 'person' : 'people'}
          </button>
        </>
      }
    >
      <form id="pool-form" onSubmit={submit} className="space-y-4">
        <p className="font-ui text-sm text-ink-2">
          Everyone chosen is told. The first to tap <span className="font-medium text-ink">Take it</span> gets it. If nobody takes it within 12 hours, it goes to the
          one with the fewest ongoing tickets. People on leave are left out.
        </p>
        {error && <Alert tone="error">{error}</Alert>}

        <fieldset className="space-y-2">
          <legend className="font-ui text-sm font-medium text-ink">Who</legend>
          <label className={`flex min-h-tap cursor-pointer items-center gap-3 rounded-btn border px-3 py-2 ${everyone ? 'border-brand bg-primary-muted' : 'border-line bg-surface'}`}>
            <input type="checkbox" className="h-5 w-5 accent-brand" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
            <span className="font-ui text-sm text-ink">
              Everyone available <span className="text-ink-3">({available.length})</span>
            </span>
          </label>
          {!everyone &&
            occupations.map((o) => {
              const free = o.people.filter((p) => !p.onLeaveUntil).length;
              const on = occIds.includes(o.id);
              return (
                <label
                  key={o.id || o.name}
                  className={`flex min-h-tap cursor-pointer items-center gap-3 rounded-btn border px-3 py-2 ${on ? 'border-brand bg-primary-muted' : 'border-line bg-surface'} ${free ? '' : 'opacity-60'}`}
                >
                  <input type="checkbox" className="h-5 w-5 accent-brand" checked={on} disabled={!free || !o.id} onChange={() => toggle(occIds, setOccIds, o.id)} />
                  <span className="font-ui text-sm text-ink">
                    All {o.name} <span className="text-ink-3">({free} available{o.people.length > free ? `, ${o.people.length - free} on leave` : ''})</span>
                    {o.id && o.id === ticket.suggestedOccupationId && <span className="ml-1 text-xs text-gold-dark">· matches the category</span>}
                  </span>
                </label>
              );
            })}
        </fieldset>

        {!everyone && (
          <details className="rounded-btn border border-line bg-surface px-3 py-2" open={!occupations.length}>
            <summary className="min-h-tap cursor-pointer py-2 font-ui text-sm text-brand">Or pick people {people.length > 0 && `(${people.length})`}</summary>
            <ul className="max-h-60 space-y-1 overflow-y-auto pb-2">
              {staff.map((s) => (
                <li key={s.id}>
                  <label className={`flex min-h-tap cursor-pointer items-center gap-3 ${s.onLeaveUntil ? 'opacity-60' : ''}`}>
                    <input
                      type="checkbox"
                      className="h-5 w-5 accent-brand"
                      checked={people.includes(s.id) || occIds.includes(s.occupationId)}
                      disabled={Boolean(s.onLeaveUntil) || occIds.includes(s.occupationId)}
                      onChange={() => toggle(people, setPeople, s.id)}
                    />
                    <span className="min-w-0 font-ui text-sm text-ink">
                      {s.name}{' '}
                      <span className="text-ink-3">
                        · {s.occupation} · {s.open_work} open{s.onLeaveUntil ? ` · on leave till ${leaveDate(s.onLeaveUntil)}` : ''}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </details>
        )}

        <Field id="pool-note" label="Note for them (optional)">
          <TextInput id="pool-note" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {!ready && !everyone && !occIds.length && people.length === 1 && <p className="font-ui text-xs text-ink-3">For one person, use Assign instead.</p>}
      </form>
    </Modal>
  );
}
