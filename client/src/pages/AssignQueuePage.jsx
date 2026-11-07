import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, LoaderCircle, X } from 'lucide-react';
import { cancelPool, listAssignQueue, listEngineers, queueCounts, ticketAction } from '../api/requests';
import PoolDialog from '../components/PoolDialog';
import StaffOptions from '../components/StaffOptions';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import RequestList, { Pager, Tabs } from '../components/RequestList';
import useAuth from '../hooks/useAuth';
import { formatDateTime } from '../utils/format';

const TABS = [
  ['unassigned', 'Waiting to be assigned'],
  ['to_close', 'Resolved — ready to close'],
];

const POOL = '__pool';

// One row's quick-assign control (7 Nov 2026): one box — a person, or "Send to a pool" at the bottom.
function QuickAssign({ ticket, engineers, onDone, onPool }) {
  const [engineerId, setEngineerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function assign() {
    setBusy(true);
    setError('');
    try {
      await ticketAction(ticket.number, 'assign', { engineerId });
      const name = engineers.find((e) => e.id === engineerId)?.name;
      onDone(`${ticket.number} assigned to ${name}.`);
    } catch (err) {
      setError(errorMessage(err, 'Could not assign.'));
      setBusy(false);
    }
  }

  return (
    <>
      <label className="sr-only" htmlFor={`eng-${ticket.id}`}>
        Who does {ticket.number}
      </label>
      <select
        id={`eng-${ticket.id}`}
        value={engineerId}
        onChange={(e) => {
          if (e.target.value === POOL) {
            setEngineerId('');
            onPool(ticket);
          } else setEngineerId(e.target.value);
        }}
        disabled={busy || !engineers.length}
        className="min-h-tap w-full min-w-0 basis-full rounded-btn border border-line bg-surface px-3 font-ui text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-primary-muted sm:w-auto sm:flex-1 sm:basis-auto sm:max-w-xs"
      >
        <option value="">{engineers.length ? 'Choose who does it' : 'No staff yet (Staff & occupations)'}</option>
        <StaffOptions staff={engineers} blockLeave />
        {!ticket.pool && engineers.length > 1 && (
          <optgroup label="Or several people">
            <option value={POOL}>Send to a pool — first to take it gets it…</option>
          </optgroup>
        )}
      </select>
      <button type="button" className="btn-primary" disabled={!engineerId || busy} onClick={assign}>
        {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Check size={18} aria-hidden="true" />} Assign
      </button>
      {ticket.pool && <PoolBadge ticket={ticket} onDone={onDone} />}
      <Link to={`/tickets/${ticket.number}`} state={{ from: '/assign' }} className="inline-flex min-h-tap items-center px-2 font-ui text-sm text-brand hover:underline">
        Open
      </Link>
      {error && <p className="w-full font-ui text-xs text-error">{error}</p>}
    </>
  );
}

// In a pool: how many were told, when it goes automatically, and take it back.
function PoolBadge({ ticket, onDone }) {
  const [busy, setBusy] = useState(false);
  const at = formatDateTime(ticket.pool.autoAssignAt);
  async function cancel() {
    setBusy(true);
    try {
      await cancelPool(ticket.number);
      onDone(`${ticket.number} taken out of the pool.`);
    } catch (err) {
      onDone(errorMessage(err, 'Could not take it out of the pool.'));
      setBusy(false);
    }
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="status-in-progress" title={`If nobody takes it, it goes automatically at ${at}`}>
        In pool · {ticket.pool.size} {ticket.pool.size === 1 ? 'person' : 'people'} · auto {at}
      </span>
      <button type="button" className="btn-secondary px-3" disabled={busy} onClick={cancel} aria-label={`Take ${ticket.number} out of the pool`} title="Take it out of the pool">
        {busy ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
      </button>
    </span>
  );
}

function QuickClose({ ticket, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function close() {
    setBusy(true);
    setError('');
    try {
      await ticketAction(ticket.number, 'close');
      onDone(`${ticket.number} closed.`);
    } catch (err) {
      setError(errorMessage(err, 'Could not close.'));
      setBusy(false);
    }
  }

  return (
    <>
      <span className="font-ui text-xs text-ink-2">
        Resolved by {ticket.assignedEngineer?.name || 'staff'} — check the fix, then close. Closing is final.
      </span>
      <span className="ml-auto flex gap-2">
        <Link to={`/tickets/${ticket.number}`} state={{ from: '/assign?view=to_close' }} className="btn-secondary">
          Review
        </Link>
        <button type="button" className="btn-primary" disabled={busy} onClick={close}>
          {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Close
        </button>
      </span>
      {error && <p className="w-full font-ui text-xs text-error">{error}</p>}
    </>
  );
}

// Super Admin: new tickets to assign (urgent first, then oldest) and resolved tickets to close.
export default function AssignQueuePage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'unassigned';
  const page = Number(params.get('page')) || 1;
  const [notice, setNotice] = useState('');
  const [pooling, setPooling] = useState(null);

  const query = useQuery({
    queryKey: ['requests', 'queue', 'assign', view, page],
    queryFn: () => listAssignQueue({ view, page }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const engineers = useQuery({ queryKey: ['requests', 'engineers'], queryFn: listEngineers, staleTime: 60_000 });
  const counts = useQuery({ queryKey: ['requests', 'counts'], queryFn: queueCounts, staleTime: 30_000 });

  const done = (message) => {
    setNotice(message);
    queryClient.invalidateQueries({ queryKey: ['requests'] });
  };

  return (
    <section className="space-y-4">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">{user.company?.name} · Admin</p>
        <h1 className="mt-1 text-3xl">Assign queue</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">
          New tickets and approved requests waiting for a staff member (high priority first, then oldest), and resolved tickets waiting for you to close.
        </p>
      </div>
      {notice && <Alert tone="success">{notice}</Alert>}
      {engineers.isError && <Alert tone="error">Could not load the staff list.</Alert>}
      <Tabs
        tabs={TABS}
        value={view}
        onChange={(v) => {
          setNotice('');
          setParams({ view: v });
        }}
        counts={{ unassigned: counts.data?.assignQueue, to_close: counts.data?.toClose }}
      />
      <RequestList
        query={query}
        from={`/assign?view=${view}`}
        emptyText={view === 'unassigned' ? 'Every ticket has someone on it.' : 'Nothing waiting to be closed.'}
        showEngineer={view !== 'unassigned'}
        onPriorityChanged={(fresh, message) => done(message)}
        renderActions={(t) =>
          view === 'unassigned' ? (
            <QuickAssign ticket={t} engineers={engineers.data || []} onDone={done} onPool={setPooling} />
          ) : (
            <QuickClose ticket={t} onDone={done} />
          )
        }
      />
      {query.data && <Pager page={page} total={query.data.total} pageSize={query.data.pageSize} onPage={(p) => setParams({ view, page: String(p) })} />}
      {pooling && (
        <PoolDialog
          ticket={pooling}
          staff={engineers.data || []}
          onClose={() => setPooling(null)}
          onDone={(fresh, message) => {
            setPooling(null);
            done(message);
          }}
        />
      )}
    </section>
  );
}
