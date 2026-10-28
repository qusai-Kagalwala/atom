import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, LoaderCircle, Plus, Ticket } from 'lucide-react';
import { listMyRequests } from '../api/requests';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import useAuth from '../hooks/useAuth';
import { formatDateTime } from '../utils/format';
import { priorityBadge, priorityLabel, statusBadge, statusLabel } from '../utils/requests';
import { TimeBadge } from '../components/TimeFrame';

const TABS = [
  ['open', 'Open'],
  ['closed', 'Closed'],
  ['all', 'All'],
];
const PAGE_SIZE = 20;

export default function MyRequestsPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'open';
  const page = Number(params.get('page')) || 1;

  const query = useQuery({
    queryKey: ['requests', 'mine', status, page],
    queryFn: () => listMyRequests({ status, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const items = query.data?.requests || [];
  const total = query.data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const go = (next) => setParams((p) => ({ ...Object.fromEntries(p), ...next }));

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Track</p>
          <h1 className="mt-1 text-3xl">My tickets &amp; requests</h1>
          <p className="mt-1 font-ui text-sm text-ink-2">Everything you've raised, and anything raised on your behalf.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/request" className="btn-secondary">
            <Plus size={18} aria-hidden="true" /> Request something
          </Link>
          <Link to="/assistant" className="btn-primary">
            <Plus size={18} aria-hidden="true" /> Raise a ticket
          </Link>
        </div>
      </div>

      <div className="mt-5 flex gap-1 border-b border-line" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={status === key}
            onClick={() => go({ status: key, page: '1' })}
            className={`min-h-tap border-b-2 px-4 font-ui text-sm ${
              status === key ? 'border-primary font-medium text-primary' : 'border-transparent text-ink-2 hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2 font-ui text-xs text-ink-3">
          {query.isFetching && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
          {query.isSuccess && `${total} total`}
        </span>
      </div>

      {query.isError && (
        <div className="mt-4">
          <Alert tone="error">{errorMessage(query.error, 'Could not load your tickets.')}</Alert>
        </div>
      )}

      {query.isSuccess && items.length === 0 && (
        <div className="card mt-4 text-center">
          <Ticket size={24} className="mx-auto text-primary" aria-hidden="true" />
          <p className="mt-2 font-ui text-sm text-ink-2">
            {status === 'open' ? 'Nothing open right now.' : 'Nothing here yet.'}
          </p>
        </div>
      )}

      <ul className="mt-4 space-y-2">
        {items.map((t) => {
          const forMe = t.requester.id === user.id;
          return (
            <li key={t.id}>
              <Link to={`/tickets/${t.number}`} className="card block p-4 transition-colors hover:border-gold">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-ui text-xs tabular-nums text-ink-3">
                      {t.number}
                      {t.category && ` · ${t.category}`}
                    </p>
                    <p className="mt-0.5 truncate font-ui font-medium text-ink">{t.title}</p>
                  </div>
                  <span className={statusBadge(t.status)}>{statusLabel(t.status, { viewerIsRequester: forMe, type: t.type })}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-ui text-xs text-ink-2">
                  {t.priority !== 'NORMAL' && <span className={priorityBadge(t.priority)}>{priorityLabel(t.priority)}</span>}
                  <TimeBadge t={t} />
                  {!forMe && <span>For {t.requester.name}</span>}
                  {t.assignedEngineer && <span>Engineer: {t.assignedEngineer.name}</span>}
                  <span className="text-ink-3">Updated {formatDateTime(t.updatedAt)}</span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>

      {pages > 1 && (
        <nav className="mt-4 flex items-center justify-between font-ui text-sm" aria-label="Pages">
          <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => go({ page: String(page - 1) })}>
            <ChevronLeft size={18} aria-hidden="true" /> Previous
          </button>
          <span className="text-ink-2">
            Page {page} of {pages}
          </span>
          <button type="button" className="btn-secondary" disabled={page >= pages} onClick={() => go({ page: String(page + 1) })}>
            Next <ChevronRight size={18} aria-hidden="true" />
          </button>
        </nav>
      )}
    </section>
  );
}
