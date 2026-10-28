import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { listWorkQueue } from '../api/requests';
import RequestList, { Pager, Tabs } from '../components/RequestList';

const TABS = [
  ['active', 'All open'],
  ['to_start', 'To start'],
  ['in_progress', 'In progress'],
  ['waiting', 'Waiting'],
  ['resolved', 'Resolved'],
];
const EMPTY = {
  active: 'Nothing assigned to you right now.',
  to_start: 'Nothing waiting for you to start.',
  in_progress: 'Nothing in progress.',
  waiting: 'Nothing waiting on the requester or equipment.',
  resolved: 'Nothing resolved and waiting to be closed.',
};

// Engineer: tickets assigned to me. High priority first, then oldest.
export default function WorkQueuePage() {
  const [params, setParams] = useSearchParams();
  const group = params.get('group') || 'active';
  const page = Number(params.get('page')) || 1;
  const query = useQuery({
    queryKey: ['requests', 'queue', 'work', group, page],
    queryFn: () => listWorkQueue({ group, page }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  return (
    <section className="space-y-4">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Engineer</p>
        <h1 className="mt-1 text-3xl">My work queue</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">Tickets assigned to you. High-priority ones are at the top.</p>
      </div>
      <Tabs tabs={TABS} value={group} onChange={(g) => setParams({ group: g })} />
      <RequestList query={query} emptyText={EMPTY[group]} showEngineer={false} from="/work-queue" />
      {query.data && <Pager page={page} total={query.data.total} pageSize={query.data.pageSize} onPage={(p) => setParams({ group, page: String(p) })} />}
    </section>
  );
}
