import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BarChart3, Bot, Boxes, FileDown, LoaderCircle, ShoppingCart } from 'lucide-react';
import { getAnalytics } from '../api/reports';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import PeriodPicker from '../components/PeriodPicker';
import useAuth from '../hooks/useAuth';
import { duration, initialPeriod, pctText, showDay } from '../utils/period';
import { priorityLabel, statusLabel } from '../utils/requests';

// Company Admin (Phase 15): how the company is doing over a period. Tickets raised in the period;
// "open now" and "overdue now" are today. Counts open the matching list in All tickets & requests.
function Stat({ label, value, hint, tone = '' }) {
  return (
    <div className="card p-4">
      <p className="font-ui text-xs uppercase tracking-wider text-ink-3">{label}</p>
      <p className={`mt-1 font-display text-2xl leading-tight ${tone || 'text-brown'}`}>{value}</p>
      {hint && <p className="mt-0.5 font-ui text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

// Label · bar · count rows. link(row) → where a click goes (optional).
function Bars({ title, rows, label = (r) => r.label, link }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="card space-y-2">
      <h2 className="text-xl">{title}</h2>
      {rows.length === 0 ? (
        <p className="font-ui text-sm text-ink-3">Nothing in this period.</p>
      ) : (
        <ul className="space-y-1.5 font-ui text-sm">
          {rows.map((r) => {
            const inner = (
              <>
                <span className="min-w-0 flex-1 truncate text-ink">{label(r)}</span>
                <span className="hidden h-2 w-1/3 overflow-hidden rounded-full bg-cream-dark sm:block" aria-hidden="true">
                  <span className="block h-full rounded-full bg-primary" style={{ width: `${(r.count / max) * 100}%` }} />
                </span>
                <span className="w-10 text-right tabular-nums text-ink-2">{r.count}</span>
              </>
            );
            return (
              <li key={r.key}>
                {link ? (
                  <Link to={link(r)} className="flex min-h-tap items-center gap-3 rounded-btn px-1 hover:bg-gold-muted">
                    {inner}
                  </Link>
                ) : (
                  <span className="flex min-h-tap items-center gap-3 px-1">{inner}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PerDay({ days }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const total = days.reduce((n, d) => n + d.count, 0);
  return (
    <div className="card space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl">Tickets raised per day</h2>
        <p className="font-ui text-xs text-ink-3">{total} in {days.length} days</p>
      </div>
      <div className="flex h-32 items-end gap-px" role="img" aria-label={`Tickets per day, highest ${max}`}>
        {days.map((d) => (
          <span key={d.day} className="group relative flex h-full min-w-0 flex-1 items-end" title={`${showDay(d.day)}: ${d.count}`}>
            <span className={`block w-full rounded-t-sm ${d.count ? 'bg-primary' : 'bg-cream-dark'}`} style={{ height: `${Math.max(d.count ? 6 : 2, (d.count / max) * 100)}%` }} />
          </span>
        ))}
      </div>
      <div className="flex justify-between font-ui text-xs text-ink-3">
        <span>{showDay(days[0].day)}</span>
        <span>{showDay(days[days.length - 1].day)}</span>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { user } = useAuth();
  const [period, setPeriod] = useState(() => initialPeriod('30d'));
  const q = useQuery({
    queryKey: ['analytics', period.from, period.to],
    queryFn: () => getAnalytics({ from: period.from, to: period.to }),
    placeholderData: keepPreviousData,
  });
  const a = q.data;
  const h = a?.headline;

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">{user.company?.name} · Admin</p>
          <h1 className="mt-1 flex items-center gap-2 text-3xl">
            <BarChart3 size={26} className="text-primary" aria-hidden="true" /> Analytics
          </h1>
          {a && (
            <p className="mt-1 font-ui text-sm text-ink-2">
              {showDay(a.period.from)} – {showDay(a.period.to)} · tickets raised in this period
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <PeriodPicker value={period} onChange={setPeriod} />
          <Link to="/reports" className="btn-secondary">
            <FileDown size={18} aria-hidden="true" /> Reports
          </Link>
        </div>
      </div>

      {q.isError && <Alert tone="error">{errorMessage(q.error, 'Could not load the numbers.')}</Alert>}
      {q.isPending && (
        <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
          <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading…
        </p>
      )}

      {a && (
        <div className={`space-y-5 ${q.isFetching ? 'opacity-70' : ''}`}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Raised" value={h.raised} hint={`${h.stillOpen} still open`} />
            <Stat label="Success rate" value={pctText(h.successRate)} hint={`${h.done} done · ${h.rejected} rejected`} />
            <Stat label="Within time frame" value={pctText(h.withinTimeFrame)} hint="of the resolved ones" />
            <Stat label="Overdue now" value={h.overdueNow} tone={h.overdueNow ? 'text-error' : ''} hint="open past their window" />
            <Stat label="Avg first response" value={duration(h.avgResponseMinutes)} hint="raised → work started" />
            <Stat label="Avg resolution" value={duration(h.avgResolutionMinutes)} hint="raised → resolved" />
            <Stat label="AI chats" value={a.assistant.chats} hint={`${pctText(a.assistant.solvedRate)} solved without a ticket`} />
            <Stat label="Service requests" value={a.serviceRequests.requests} hint={`${a.serviceRequests.delivered} items delivered`} />
          </div>

          <PerDay days={a.perDay} />

          <div className="grid gap-5 lg:grid-cols-2">
            <Bars title="By category" rows={a.byCategory} link={(r) => (r.key === 'none' ? '/all?status=all' : `/all?status=all&categoryId=${r.key}`)} />
            <Bars title="Top departments" rows={a.byDepartment} />
            <Bars title="By status" rows={a.byStatus} label={(r) => statusLabel(r.key, { viewerIsRequester: false })} />
            <Bars title="By priority" rows={a.byPriority} label={(r) => priorityLabel(r.key)} link={(r) => `/all?status=all&priority=${r.key}`} />
          </div>

          <div className="card space-y-3">
            <h2 className="text-xl">Staff workload</h2>
            {a.staff.length === 0 ? (
              <p className="font-ui text-sm text-ink-3">No staff in this company yet.</p>
            ) : (
              <ul className="divide-y divide-line font-ui text-sm">
                {a.staff.map((s) => (
                  <li key={s.id}>
                    <Link to={`/all?status=all&engineerId=${s.id}`} className="flex min-h-tap flex-wrap items-center gap-x-4 gap-y-1 px-1 py-2 hover:bg-gold-muted">
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">{s.name}</span>
                        <span className="block text-xs text-ink-3">{s.occupation}</span>
                      </span>
                      <span className="text-xs text-ink-2">
                        <span className="font-medium text-ink">{s.openNow}</span> open now · {s.assigned} assigned · {s.done} done
                        {s.avgResolutionMinutes != null && ` · avg ${duration(s.avgResolutionMinutes)}`}
                        {s.withinTimeFrame != null && ` · ${pctText(s.withinTimeFrame)} on time`}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="card space-y-1 font-ui text-sm">
              <h2 className="flex items-center gap-2 text-xl">
                <ShoppingCart size={18} className="text-primary" aria-hidden="true" /> Requests
              </h2>
              <p className="text-ink-2">
                {a.serviceRequests.requests} requests · {a.serviceRequests.approved} items approved · {a.serviceRequests.rejected} not approved ·{' '}
                {a.serviceRequests.pending} waiting
              </p>
              {a.serviceRequests.stockDelivered > 0 && <p className="text-ink-2">{a.serviceRequests.stockDelivered} pieces handed out from stock</p>}
            </div>
            <div className="card space-y-1 font-ui text-sm">
              <h2 className="flex items-center gap-2 text-xl">
                <Boxes size={18} className="text-primary" aria-hidden="true" /> Assets
              </h2>
              {a.assets.total + a.assets.retired === 0 ? (
                <p className="text-ink-3">No inventory in this company.</p>
              ) : (
                <p className="text-ink-2">
                  {a.assets.inUse} in use · {a.assets.inStore} in store · {a.assets.inRepair} in repair · {a.assets.retired} retired
                  {a.assets.toRecover > 0 && (
                    <>
                      {' · '}
                      <Link to="/onboarding?tab=recover" className="font-medium text-error hover:underline">
                        {a.assets.toRecover} to recover
                      </Link>
                    </>
                  )}
                </p>
              )}
            </div>
            <div className="card space-y-1 font-ui text-sm">
              <h2 className="flex items-center gap-2 text-xl">
                <Bot size={18} className="text-primary" aria-hidden="true" /> AI assistant
              </h2>
              <p className="text-ink-2">
                {a.assistant.chats} chats · {a.assistant.solved} solved · {a.assistant.tickets} became tickets
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
