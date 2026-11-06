import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Hand, LoaderCircle } from 'lucide-react';
import { listPoolQueue, listWorkQueue, takeTicket } from '../api/requests';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import RequestList, { Pager, Tabs } from '../components/RequestList';
import useAuth from '../hooks/useAuth';
import { roleLabel } from '../utils/roles';

const TABS = [
  ['pool', 'Available to take'],
  ['active', 'All open'],
  ['to_start', 'To start'],
  ['in_progress', 'In progress'],
  ['waiting', 'Waiting'],
  ['resolved', 'Resolved'],
];
const EMPTY = {
  pool: 'Nothing offered to you right now.',
  active: 'Nothing assigned to you right now.',
  to_start: 'Nothing waiting for you to start.',
  in_progress: 'Nothing in progress.',
  waiting: 'Nothing waiting on the requester or equipment.',
  resolved: 'Nothing resolved and waiting to be closed.',
};

// Pool (Phase 2): take a ticket offered to several people — the first to take it gets it.
function TakeButton({ ticket, onDone }) {
  const [busy, setBusy] = useState(false);
  async function take() {
    setBusy(true);
    try {
      await takeTicket(ticket.number);
      onDone({ tone: 'success', text: `${ticket.number} is yours now.` });
    } catch (err) {
      onDone({ tone: 'error', text: errorMessage(err, 'Could not take it.') });
      setBusy(false);
    }
  }
  return (
    <button type="button" className="btn-primary" disabled={busy} onClick={take}>
      {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Hand size={18} aria-hidden="true" />} Take it
    </button>
  );
}

// Staff: tickets assigned to me, and tickets offered to me in a pool. High priority first, then oldest.
export default function WorkQueuePage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const group = params.get('group') || 'active';
  const page = Number(params.get('page')) || 1;
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState(null);
  const query = useQuery({
    queryKey: ['requests', 'queue', 'work', group, page],
    queryFn: () => (group === 'pool' ? listPoolQueue({ page }) : listWorkQueue({ group, page })),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const pool = useQuery({ queryKey: ['requests', 'queue', 'pool-count'], queryFn: () => listPoolQueue({ page: 1 }), refetchInterval: 60_000 });

  return (
    <section className="space-y-4">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">
          {user.company?.name} · {roleLabel(user.activeRole, user)}
        </p>
        <h1 className="mt-1 text-3xl">My work queue</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">Tickets assigned to you, and ones offered to you to take. High-priority ones are at the top.</p>
      </div>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Tabs tabs={TABS} value={group} onChange={(g) => { setNotice(null); setParams({ group: g }); }} counts={{ pool: pool.data?.total }} />
      <RequestList
        query={query}
        emptyText={EMPTY[group]}
        showEngineer={false}
        from={`/work-queue?group=${group}`}
        renderActions={
          group === 'pool'
            ? (t) => (
                <TakeButton
                  ticket={t}
                  onDone={(n) => {
                    setNotice(n);
                    queryClient.invalidateQueries({ queryKey: ['requests'] });
                  }}
                />
              )
            : undefined
        }
      />
      {query.data && <Pager page={page} total={query.data.total} pageSize={query.data.pageSize} onPage={(p) => setParams({ group, page: String(p) })} />}
    </section>
  );
}
