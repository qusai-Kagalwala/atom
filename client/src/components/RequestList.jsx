import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, LoaderCircle, MapPin, Ticket } from 'lucide-react';
import { errorMessage } from '../api/http';
import { Alert } from './FormControls';
import { timeAgo } from '../utils/format';
import { FINAL_STATUSES, priorityBadge, priorityLabel, staffLabel, statusBadge, statusLabel } from '../utils/requests';
import PriorityChange from './PriorityChange';
import { TimeBadge } from './TimeFrame';

// Card list of tickets used by the work queue, assign queue and All tickets.
// `renderActions(ticket)` adds per-row buttons (quick assign / close) under the card.
// onPriorityChanged: Super Admin lists — a "Priority" control on each open row.
export default function RequestList({ query, emptyText = 'Nothing here.', renderActions, showEngineer = true, from, onPriorityChanged }) {
  if (query.isError) return <Alert tone="error">{errorMessage(query.error, 'Could not load the list.')}</Alert>;
  if (query.isPending) {
    return (
      <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
        <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading…
      </p>
    );
  }
  const items = query.data.requests;
  if (!items.length) {
    return (
      <div className="card text-center">
        <Ticket size={24} className="mx-auto text-primary" aria-hidden="true" />
        <p className="mt-2 font-ui text-sm text-ink-2">{emptyText}</p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((t) => (
        <li key={t.id} className="card p-0">
          <Link to={`/tickets/${t.number}`} state={{ from }} className="block rounded-card p-4 transition-colors hover:bg-gold-muted/40">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-ui text-xs tabular-nums text-ink-3">
                  {t.number}
                  {t.category && ` · ${t.category}`}
                </p>
                <p className="mt-0.5 truncate font-ui font-medium text-ink">{t.title}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <TimeBadge t={t} />
                {t.priority !== 'NORMAL' && <span className={priorityBadge(t.priority)}>{priorityLabel(t.priority)}</span>}
                <span className={statusBadge(t.status)}>{statusLabel(t.status, { viewerIsRequester: false, type: t.type })}</span>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-ui text-xs text-ink-2">
              <span>For {t.requester.name}</span>
              {t.location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin size={12} aria-hidden="true" /> {t.location}
                </span>
              )}
              {showEngineer && <span>{t.assignedEngineer ? staffLabel(t.assignedEngineer) : 'Not assigned'}</span>}
              <span className="text-ink-3" title={t.createdAt}>
                Raised {timeAgo(t.createdAt)}
                {t.statusSince && t.statusSince !== t.createdAt && ` · this status ${timeAgo(t.statusSince)}`}
              </span>
            </div>
          </Link>
          {(renderActions || (onPriorityChanged && !FINAL_STATUSES.has(t.status))) && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2">
              {renderActions?.(t)}
              {onPriorityChanged && !FINAL_STATUSES.has(t.status) && (
                <span className="ml-auto">
                  <PriorityChange ticket={t} compact onDone={onPriorityChanged} />
                </span>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Pager({ page, total, pageSize, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav className="mt-4 flex items-center justify-between font-ui text-sm" aria-label="Pages">
      <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeft size={18} aria-hidden="true" /> Previous
      </button>
      <span className="text-ink-2">
        Page {page} of {pages}
      </span>
      <button type="button" className="btn-secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next <ChevronRight size={18} aria-hidden="true" />
      </button>
    </nav>
  );
}

export function Tabs({ tabs, value, onChange, counts = {} }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          onClick={() => onChange(key)}
          className={`min-h-tap shrink-0 border-b-2 px-4 font-ui text-sm ${
            value === key ? 'border-primary font-medium text-primary' : 'border-transparent text-ink-2 hover:text-ink'
          }`}
        >
          {label}
          {counts[key] > 0 && <span className="ml-1.5 rounded-full bg-primary px-1.5 text-xs text-white">{counts[key]}</span>}
        </button>
      ))}
    </div>
  );
}
