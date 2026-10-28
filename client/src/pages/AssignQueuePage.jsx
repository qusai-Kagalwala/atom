import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, LoaderCircle } from 'lucide-react';
import { listAssignQueue, listEngineers, queueCounts, ticketAction } from '../api/requests';
import StaffOptions from '../components/StaffOptions';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import RequestList, { Pager, Tabs } from '../components/RequestList';

const TABS = [
  ['unassigned', 'Waiting for an engineer'],
  ['to_close', 'Resolved — ready to close'],
];

// One row's quick-assign control.
function QuickAssign({ ticket, engineers, onDone }) {
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
        Engineer for {ticket.number}
      </label>
      <select
        id={`eng-${ticket.id}`}
        value={engineerId}
        onChange={(e) => setEngineerId(e.target.value)}
        disabled={busy || !engineers.length}
        className="min-h-tap min-w-0 flex-1 rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted sm:max-w-xs"
      >
        <option value="">{engineers.length ? 'Choose who does it' : 'No staff yet (Staff & occupations)'}</option>
        <StaffOptions staff={engineers} />
      </select>
      <button type="button" className="btn-primary" disabled={!engineerId || busy} onClick={assign}>
        {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Check size={18} aria-hidden="true" />} Assign
      </button>
      <Link to={`/tickets/${ticket.number}`} state={{ from: '/assign' }} className="font-ui text-sm text-primary hover:underline">
        Open
      </Link>
      {error && <p className="w-full font-ui text-xs text-error">{error}</p>}
    </>
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
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'unassigned';
  const page = Number(params.get('page')) || 1;
  const [notice, setNotice] = useState('');

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
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Super Admin</p>
        <h1 className="mt-1 text-3xl">Assign queue</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">
          New tickets and approved requests waiting for an engineer (high priority first, then oldest), and resolved tickets waiting for you to close.
        </p>
      </div>
      {notice && <Alert tone="success">{notice}</Alert>}
      {engineers.isError && <Alert tone="error">Could not load engineers.</Alert>}
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
        emptyText={view === 'unassigned' ? 'Every ticket has an engineer.' : 'Nothing waiting to be closed.'}
        showEngineer={view !== 'unassigned'}
        onPriorityChanged={(fresh, message) => done(message)}
        renderActions={(t) =>
          view === 'unassigned' ? (
            <QuickAssign ticket={t} engineers={engineers.data || []} onDone={done} />
          ) : (
            <QuickClose ticket={t} onDone={done} />
          )
        }
      />
      {query.data && <Pager page={page} total={query.data.total} pageSize={query.data.pageSize} onPage={(p) => setParams({ view, page: String(p) })} />}
    </section>
  );
}
