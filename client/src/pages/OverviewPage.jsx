import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { LayoutDashboard, LoaderCircle } from 'lucide-react';
import { getOverview } from '../api/reports';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import PeriodPicker from '../components/PeriodPicker';
import { duration, initialPeriod, pctText, showDay } from '../utils/period';

// Super Admin (Phase 15): every company's headline numbers side by side. Details are on each
// company's Analytics page (open the company first).
const ROWS = [
  ['raised', 'Tickets raised', (v) => v],
  ['stillOpen', 'Still open', (v) => v],
  ['done', 'Done', (v) => v],
  ['rejected', 'Rejected', (v) => v],
  ['successRate', 'Success rate', pctText],
  ['withinTimeFrame', 'Within time frame', pctText],
  ['overdueNow', 'Overdue now', (v) => v],
  ['avgResponseMinutes', 'Avg first response', duration],
  ['avgResolutionMinutes', 'Avg resolution', duration],
];

export default function OverviewPage() {
  const [period, setPeriod] = useState(() => initialPeriod('30d'));
  const q = useQuery({
    queryKey: ['analytics', 'overview', period.from, period.to],
    queryFn: () => getOverview({ from: period.from, to: period.to }),
    placeholderData: keepPreviousData,
  });
  const list = q.data?.companies || [];

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Super Admin</p>
          <h1 className="mt-1 flex items-center gap-2 text-3xl">
            <LayoutDashboard size={26} className="text-brand" aria-hidden="true" /> Overview
          </h1>
          {q.data && (
            <p className="mt-1 font-ui text-sm text-ink-2">
              All companies · {showDay(q.data.period.from)} – {showDay(q.data.period.to)}
            </p>
          )}
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>
      {q.isError && <Alert tone="error">{errorMessage(q.error, 'Could not load the numbers.')}</Alert>}
      {q.isPending && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}

      {/* One card per company (phones and desktop alike — three companies fit side by side). */}
      <div className={`grid gap-4 md:grid-cols-3 ${q.isFetching ? 'opacity-70' : ''}`}>
        {list.map((c) => (
          <div key={c.code} className="card space-y-2">
            <h2 className="flex flex-wrap items-center gap-2 text-2xl">
              {c.name}
              {!c.isOpen && <span className="status-closed">Closed</span>}
            </h2>
            <dl className="divide-y divide-line font-ui text-sm">
              {ROWS.map(([k, label, show]) => (
                <div key={k} className="flex items-center justify-between gap-3 py-1.5">
                  <dt className="text-ink-2">{label}</dt>
                  <dd className={`tabular-nums font-medium ${k === 'overdueNow' && c[k] ? 'text-error' : 'text-ink'}`}>{show(c[k])}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      <p className="font-ui text-xs text-ink-3">For charts, staff workload and PDF reports, open a company and go to Analytics or Reports.</p>
    </section>
  );
}
