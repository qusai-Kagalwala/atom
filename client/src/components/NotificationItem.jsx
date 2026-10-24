import { CircleCheck, CircleX, Lock, MessageSquare, Ticket, UserCheck } from 'lucide-react';
import { timeAgo } from '../utils/format';

const ICONS = {
  'ticket.created': Ticket,
  'ticket.assign': UserCheck,
  'ticket.resolve': CircleCheck,
  'ticket.close': Lock,
  'ticket.reject': CircleX,
  'ticket.comment': MessageSquare,
};

// One notification row (bell dropdown and the Notifications page).
export default function NotificationItem({ n, onOpen, compact = false }) {
  const Icon = ICONS[n.type] || Ticket;
  return (
    <button
      type="button"
      onClick={() => onOpen(n)}
      className={`flex w-full items-start gap-3 px-4 text-left font-ui hover:bg-gold-muted focus-visible:bg-gold-muted ${
        compact ? 'py-2.5' : 'py-3'
      } ${n.read ? '' : 'bg-cream-dark'}`}
    >
      <Icon size={18} aria-hidden="true" className={`mt-0.5 shrink-0 ${n.read ? 'text-ink-3' : 'text-primary'}`} />
      <span className="min-w-0 flex-1">
        <span className={`block text-sm ${n.read ? 'text-ink-2' : 'font-medium text-ink'}`}>{n.title}</span>
        {n.body && <span className="mt-0.5 block truncate text-xs text-ink-2">{n.body}</span>}
        <span className="mt-0.5 block text-xs text-ink-3">{timeAgo(n.createdAt)}</span>
      </span>
      {!n.read && (
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gold" aria-label="Unread" role="img" />
      )}
    </button>
  );
}
