import { useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '../components/FormControls';
import { listAllRequests } from '../api/requests';
import RequestList, { Pager } from '../components/RequestList';

const PAGE_SIZE = 25;

// Super Admin: service requests waiting for a decision, oldest first. Decisions are made per item
// on the request page.
export default function ApprovalsPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page')) || 1;
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');
  const query = useQuery({
    queryKey: ['requests', 'approvals', page],
    queryFn: () => listAllRequests({ status: 'approval', type: 'SERVICE_REQUEST', sort: 'oldest', page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  return (
    <section className="space-y-4">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Super Admin</p>
        <h1 className="mt-1 text-3xl">Approvals</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">Service requests waiting for your decision, oldest first. Open one to approve or reject each item.</p>
      </div>
      {notice && <Alert tone="success">{notice}</Alert>}
      <RequestList
        query={query}
        emptyText="Nothing waiting for approval."
        showEngineer={false}
        from={`/approvals${page > 1 ? `?page=${page}` : ''}`}
        onPriorityChanged={(fresh, message) => {
          setNotice(message);
          queryClient.invalidateQueries({ queryKey: ['requests'] });
        }}
      />
      {query.data && <Pager page={page} total={query.data.total} pageSize={PAGE_SIZE} onPage={(p) => setParams(p > 1 ? { page: String(p) } : {})} />}
    </section>
  );
}
