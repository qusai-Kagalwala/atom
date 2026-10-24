// Labels and timeline text for tickets. Plain language, never raw status codes.
import statuses from '@shared/statuses.json';

const STATUS = statuses.requestStatuses;
export const PRIORITIES = statuses.priorities;
export const REQUESTER_PRIORITIES = statuses.requesterPriorities;
export const FINAL_STATUSES = new Set(['CLOSED', 'REJECTED']);

// "Waiting for you" only makes sense to the person the ticket is for.
export function statusLabel(status, { viewerIsRequester = true } = {}) {
  if (status === 'WAITING_FOR_USER' && !viewerIsRequester) return 'Waiting for requester';
  return STATUS[status]?.label || status;
}

export const statusBadge = (status) => STATUS[status]?.badge || 'badge';
export const priorityLabel = (p) => PRIORITIES[p]?.label || p;
export const priorityBadge = (p) => PRIORITIES[p]?.badge || 'badge';

const ACTION_TEXT = {
  start: 'Started work',
  wait_user: 'Asked the requester for information',
  wait_equipment: 'Waiting for equipment',
  resume: 'Resumed work',
  resolve: 'Resolved',
  close: 'Closed',
  reject: 'Rejected',
  requester_replied: 'Replied — back to In progress',
};

// One line for a timeline event (comments are rendered separately as bubbles).
export function eventText(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'created':
      return d.raisedFor ? 'Raised this ticket on someone’s behalf' : 'Raised this ticket';
    case 'assigned':
      return d.previousEngineerId
        ? `Reassigned from ${d.previousEngineerName || 'another engineer'} to ${d.engineerName || 'an engineer'}`
        : `Assigned to ${d.engineerName || 'an engineer'}`;
    case 'status':
      return ACTION_TEXT[d.action] || `Changed status to ${statusLabel(e.toStatus)}`;
    case 'priority':
      return `Changed priority from ${priorityLabel(d.from)} to ${priorityLabel(d.to)}`;
    case 'category':
      return `Changed category from ${d.from || '—'} to ${d.to}`;
    default:
      return e.type;
  }
}

// Buttons on the ticket page, in display order.
export const ACTION_BUTTONS = {
  assign: { label: 'Assign', tone: 'primary' },
  start: { label: 'Start work', tone: 'primary' },
  wait_user: { label: 'Ask requester', tone: 'secondary', note: 'optional', noteLabel: 'What do you need from them?' },
  wait_equipment: { label: 'Waiting for equipment', tone: 'secondary', note: 'optional', noteLabel: 'What equipment? (optional)' },
  resume: { label: 'Resume work', tone: 'secondary' },
  resolve: { label: 'Resolve', tone: 'primary', note: 'required', noteLabel: 'What was the fix?' },
  close: { label: 'Close', tone: 'primary' },
  reject: { label: 'Reject', tone: 'danger', note: 'required', noteLabel: 'Why is it rejected? (the requester sees this)' },
};
