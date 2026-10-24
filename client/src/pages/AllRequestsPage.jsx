import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { LoaderCircle, Search } from 'lucide-react';
import { listAllRequests, listCategories, listEngineers } from '../api/requests';
import RequestList, { Pager } from '../components/RequestList';
import { PRIORITIES } from '../utils/requests';

const selectClass =
  'min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';

const STATUS_OPTIONS = [
  ['open', 'Open (not closed)'],
  ['unassigned', 'Waiting for an engineer'],
  ['active', 'Being worked on'],
  ['waiting', 'Waiting (requester / equipment)'],
  ['resolved', 'Resolved — ready to close'],
  ['closed', 'Closed'],
  ['rejected', 'Rejected'],
  ['all', 'Everything'],
];
const SORT_OPTIONS = [
  ['updated', 'Recently updated'],
  ['priority', 'Urgent first'],
  ['oldest', 'Oldest first'],
];
const PAGE_SIZE = 25;

// Super Admin: every ticket, with search and filters. Filters live in the URL so Back keeps them.
export default function AllRequestsPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') || '');
  const f = {
    q: params.get('q') || '',
    status: params.get('status') || 'open',
    priority: params.get('priority') || '',
    categoryId: params.get('categoryId') || '',
    engineerId: params.get('engineerId') || '',
    sort: params.get('sort') || 'updated',
    page: Number(params.get('page')) || 1,
  };

  const set = (patch) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      if (!('page' in patch)) next.delete('page');
      return next;
    });

  useEffect(() => {
    const t = setTimeout(() => {
      if (search.trim() !== f.q) set({ q: search.trim() });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const query = useQuery({
    queryKey: ['requests', 'all', f],
    queryFn: () =>
      listAllRequests({
        q: f.q || undefined,
        status: f.status,
        priority: f.priority || undefined,
        categoryId: f.categoryId || undefined,
        engineerId: f.engineerId || undefined,
        sort: f.sort,
        page: f.page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories, staleTime: 10 * 60_000 });
  const engineers = useQuery({ queryKey: ['requests', 'engineers'], queryFn: listEngineers, staleTime: 60_000 });

  const from = `/all?${params.toString()}`;

  return (
    <section className="space-y-4">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Super Admin</p>
        <h1 className="mt-1 text-3xl">All tickets &amp; requests</h1>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <label className="relative sm:col-span-2 lg:col-span-3">
          <span className="sr-only">Search tickets</span>
          <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ticket number, title, person, ITS / employee ID or location"
            className="block min-h-tap w-full rounded-btn border border-line bg-white pl-10 pr-3 font-ui text-sm text-ink placeholder:text-ink-3 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
          />
        </label>
        <select aria-label="Status" className={selectClass} value={f.status} onChange={(e) => set({ status: e.target.value === 'open' ? '' : e.target.value })}>
          {STATUS_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select aria-label="Priority" className={selectClass} value={f.priority} onChange={(e) => set({ priority: e.target.value })}>
          <option value="">Any priority</option>
          {Object.values(PRIORITIES).map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        <select aria-label="Category" className={selectClass} value={f.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
          <option value="">Any category</option>
          {(categories.data || []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select aria-label="Engineer" className={selectClass} value={f.engineerId} onChange={(e) => set({ engineerId: e.target.value })}>
          <option value="">Any engineer</option>
          <option value="none">Not assigned</option>
          {(engineers.data || []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <select aria-label="Sort" className={selectClass} value={f.sort} onChange={(e) => set({ sort: e.target.value === 'updated' ? '' : e.target.value })}>
          {SORT_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setSearch('');
            setParams({});
          }}
        >
          Clear filters
        </button>
      </div>

      <p className="flex min-h-[1.25rem] items-center gap-2 font-ui text-sm text-ink-2" aria-live="polite">
        {query.isFetching && <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />}
        {query.isSuccess && `${query.data.total} ${query.data.total === 1 ? 'ticket' : 'tickets'}`}
      </p>

      <RequestList query={query} from={from} emptyText="No tickets match these filters." />
      {query.data && <Pager page={f.page} total={query.data.total} pageSize={PAGE_SIZE} onPage={(p) => set({ page: String(p) })} />}
    </section>
  );
}
