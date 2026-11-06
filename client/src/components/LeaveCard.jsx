import { CalendarDays } from 'lucide-react';
import { formatDateTime } from '../utils/format';
import { leaveSpan } from '../utils/leave';

const STATUS = {
  PENDING: ['Waiting for approval', 'status-waiting'],
  APPROVED: ['Approved', 'status-resolved'],
  REJECTED: ['Rejected', 'status-rejected'],
  CANCELLED: ['Cancelled', 'status-closed'],
};

// One leave: dates, type, status, notes, who decided. children = buttons.
export default function LeaveCard({ leave: l, showPerson = false, children }) {
  const [label, cls] = STATUS[l.status] || [l.status, 'badge'];
  return (
    <li className="card space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {showPerson && (
            <p className="break-words font-ui font-medium text-ink">
              {l.person.name}
              <span className="font-normal text-ink-3">
                {' · '}
                {[l.person.occupation, l.person.itsNumber ? `ITS ${l.person.itsNumber}` : l.person.employeeId && `Employee ID ${l.person.employeeId}`]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </p>
          )}
          <p className="flex flex-wrap items-center gap-1.5 font-ui text-sm text-ink">
            <CalendarDays size={16} className="text-brand" aria-hidden="true" />
            <span className="font-medium">{leaveSpan(l)}</span>
            <span className="text-ink-3">
              · {l.days} {l.days === 1 ? 'day' : 'days'} · {l.typeLabel}
            </span>
          </p>
        </div>
        <span className={`${cls} shrink-0`}>{l.current ? 'On leave now' : label}</span>
      </div>
      {l.note && <p className="whitespace-pre-wrap font-ui text-sm text-ink-2">“{l.note}”</p>}
      <p className="font-ui text-xs text-ink-3">
        Asked {formatDateTime(l.requestedAt)}
        {l.decidedAt && ` · ${l.status === 'REJECTED' ? 'Rejected' : 'Approved'} by ${l.decidedBy || 'Admin'}, ${formatDateTime(l.decidedAt)}`}
        {l.cancelledAt && ` · Cancelled by ${l.cancelledBy || 'someone'}, ${formatDateTime(l.cancelledAt)}`}
      </p>
      {l.decisionNote && <p className="font-ui text-sm text-ink-2">Note: {l.decisionNote}</p>}
      {children && <div className="flex flex-wrap gap-2 pt-1">{children}</div>}
    </li>
  );
}
