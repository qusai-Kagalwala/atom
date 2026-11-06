import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Check, LoaderCircle, X } from 'lucide-react';
import { decideLeave, cancelLeave, listLeave, staffBoard } from '../api/leave';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import Modal from '../components/Modal';
import { Tabs } from '../components/RequestList';
import LeaveCard from '../components/LeaveCard';
import { leaveDay } from '../utils/leave';
import useAuth from '../hooks/useAuth';

const TABS = [
  ['pending', 'To approve'],
  ['current', 'Approved'],
  ['staff', 'Who is available'],
  ['all', 'All leave'],
];

// Approve / reject / cancel, with a note (required for reject and cancel).
function DecideModal({ leave, kind, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const needsNote = kind !== 'approve';
  const ready = !needsNote || note.trim().length >= 3;
  const title = { approve: 'Approve leave', reject: 'Reject leave', cancel: 'Cancel approved leave' }[kind];

  async function submit(e) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      const l = kind === 'cancel' ? await cancelLeave(leave.id, note) : await decideLeave(leave.id, kind, note);
      onDone(l, kind);
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Back
          </button>
          <button type="submit" form="leave-form" className={kind === 'approve' ? 'btn-primary' : 'btn-danger'} disabled={!ready || busy}>
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} {title.split(' ')[0]}
          </button>
        </>
      }
    >
      <form id="leave-form" onSubmit={submit} className="space-y-3">
        <p className="font-ui text-sm text-ink">
          <span className="font-medium">{leave.person.name}</span> · {leave.typeLabel} · {leaveDay(leave.startDate)}
          {leave.endDate !== leave.startDate && ` – ${leaveDay(leave.endDate)}`}
        </p>
        {kind === 'approve' && leave.openWork > 0 && (
          <Alert tone="warning">
            {leave.person.name} has {leave.openWork} open {leave.openWork === 1 ? 'job' : 'jobs'}. Reassign {leave.openWork === 1 ? 'it' : 'them'} before the leave starts.
          </Alert>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        <Field id="leave-note" label={needsNote ? 'Reason (required — they see it)' : 'Note (optional — they see it)'}>
          <TextInput id="leave-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function Board() {
  const q = useQuery({ queryKey: ['leave', 'staff'], queryFn: staffBoard });
  if (q.isPending) return <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />;
  if (q.isError) return <Alert tone="error">{errorMessage(q.error, 'Could not load.')}</Alert>;
  if (!q.data.staff.length) return <p className="font-ui text-sm text-ink-3">No staff yet.</p>;
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {q.data.staff.map((s) => (
        <li key={s.id} className="card flex items-start justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="break-words font-ui font-medium text-ink">{s.name}</p>
            <p className="font-ui text-xs text-ink-3">{[s.occupation, s.itsNumber ? `ITS ${s.itsNumber}` : s.employeeId && `Employee ID ${s.employeeId}`].filter(Boolean).join(' · ')}</p>
            <p className="mt-1 font-ui text-xs text-ink-2">
              {s.openWork === 0 ? 'No ongoing work' : `${s.openWork} ongoing ${s.openWork === 1 ? 'job' : 'jobs'}`}
              {s.nextLeave && ` · next leave ${leaveDay(s.nextLeave.start)}`}
              {s.pending > 0 && ` · ${s.pending} waiting for approval`}
            </p>
          </div>
          {s.onLeaveUntil ? (
            <span className="status-waiting shrink-0">On leave till {leaveDay(s.onLeaveUntil)}</span>
          ) : (
            <span className="status-resolved shrink-0">Available</span>
          )}
        </li>
      ))}
    </ul>
  );
}

// The Admin (or someone given "Staff leave"): approve / reject leave, see who is on leave.
export default function StaffLeavePage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('pending');
  const [acting, setActing] = useState(null);
  const [notice, setNotice] = useState('');
  const view = tab === 'staff' ? null : tab;
  const q = useQuery({ queryKey: ['leave', 'list', view], queryFn: () => listLeave(view), enabled: Boolean(view) });
  const pendingQ = useQuery({ queryKey: ['leave', 'list', 'pending'], queryFn: () => listLeave('pending') });

  return (
    <section className="space-y-5">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">{user.company?.name} · Admin</p>
        <h1 className="mt-1 flex items-center gap-2 text-3xl">
          <CalendarCheck size={26} className="text-brand" aria-hidden="true" /> Staff leave
        </h1>
        <p className="mt-1 font-ui text-sm text-ink-2">Approve or reject leave. People on approved leave show as &ldquo;On leave&rdquo; and can&apos;t be given work until they are back.</p>
      </div>
      {notice && <Alert tone="success">{notice}</Alert>}
      <Tabs tabs={TABS} value={tab} onChange={(t) => { setTab(t); setNotice(''); }} counts={{ pending: pendingQ.data?.leaves.length || 0 }} />

      {tab === 'staff' && <Board />}
      {view && q.isPending && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
      {view && q.isError && <Alert tone="error">{errorMessage(q.error, 'Could not load.')}</Alert>}
      {view && q.isSuccess && !q.data.leaves.length && (
        <p className="font-ui text-sm text-ink-3">{tab === 'pending' ? 'Nothing waiting for approval.' : tab === 'current' ? 'Nobody is on leave or has leave coming up.' : 'No leave yet.'}</p>
      )}
      {view && q.isSuccess && (
        <ul className="space-y-3">
          {q.data.leaves.map((l) => (
            <LeaveCard key={l.id} leave={l} showPerson>
              {l.status === 'PENDING' && (
                <>
                  <button type="button" className="btn-primary" onClick={() => setActing({ leave: l, kind: 'approve' })}>
                    <Check size={16} aria-hidden="true" /> Approve
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setActing({ leave: l, kind: 'reject' })}>
                    <X size={16} aria-hidden="true" /> Reject
                  </button>
                </>
              )}
              {l.status === 'APPROVED' && l.endDate >= q.data.today && (
                <button type="button" className="btn-secondary" onClick={() => setActing({ leave: l, kind: 'cancel' })}>
                  <X size={16} aria-hidden="true" /> Cancel leave
                </button>
              )}
            </LeaveCard>
          ))}
        </ul>
      )}

      {acting && (
        <DecideModal
          leave={acting.leave}
          kind={acting.kind}
          onClose={() => setActing(null)}
          onDone={(l, kind) => {
            setActing(null);
            setNotice(`${l.person.name}'s leave ${kind === 'approve' ? 'approved' : kind === 'reject' ? 'rejected' : 'cancelled'}. They have been told.`);
            queryClient.invalidateQueries({ queryKey: ['leave'] });
            queryClient.invalidateQueries({ queryKey: ['requests'] });
          }}
        />
      )}
    </section>
  );
}
