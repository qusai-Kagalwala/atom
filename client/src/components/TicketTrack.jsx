import { Check, Ticket, Truck } from 'lucide-react';

// Where a ticket or service request is on its way: a track that fills as the work moves. The marker on the
// current step is a ticket (tickets) or a delivery truck (service requests). Statuses are shared/statuses.json:
// the waiting states sit "in progress, on hold", Closed counts as finished, Rejected shows no track.
const FLOW = {
  TICKET: [['OPEN', 'Open'], ['ASSIGNED', 'Assigned'], ['IN_PROGRESS', 'In progress'], ['RESOLVED', 'Resolved']],
  SERVICE_REQUEST: [
    ['PENDING_APPROVAL', 'Approval'],
    ['OPEN', 'Open'],
    ['ASSIGNED', 'Assigned'],
    ['IN_PROGRESS', 'In progress'],
    ['RESOLVED', 'Delivered'],
  ],
};
const SAME_STEP = { WAITING_FOR_USER: 'IN_PROGRESS', WAITING_FOR_EQUIPMENT: 'IN_PROGRESS', CLOSED: 'RESOLVED' };

export default function TicketTrack({ status, type }) {
  const steps = FLOW[type] || FLOW.TICKET;
  const at = steps.findIndex(([key]) => key === (SAME_STEP[status] || status));
  if (status === 'REJECTED' || at < 0) return null;

  const finished = status === 'RESOLVED' || status === 'CLOSED';
  const onHold = status === 'WAITING_FOR_USER' || status === 'WAITING_FOR_EQUIPMENT';
  const Marker = type === 'SERVICE_REQUEST' ? Truck : Ticket;

  return (
    <ol aria-label="Progress" className="mt-5 grid grid-cols-1" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map(([key, label], i) => {
        const done = i < at || (i === at && finished);
        const current = i === at && !finished;
        return (
          <li key={key} aria-current={current ? 'step' : undefined} className="relative flex flex-col items-center text-center">
            {i > 0 && (
              // The line from the previous step to this one; it fills once this step is reached.
              <span aria-hidden="true" className="absolute right-1/2 top-4 -mt-px h-0.5 w-full bg-line">
                {i <= at && <span className="anim-grow absolute inset-0 bg-brand" style={{ '--i': i }} />}
              </span>
            )}
            <span
              aria-hidden="true"
              className={[
                'relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 font-ui text-xs',
                done ? 'anim-pop border-brand bg-primary text-white' : '',
                current ? 'anim-pop-ring border-gold bg-surface text-brand' : '',
                !done && !current ? 'border-line bg-surface text-ink-3' : '',
              ].join(' ')}
              style={done || current ? { animationDelay: `${i * 160}ms` } : undefined}
            >
              {done ? <Check size={16} /> : current ? <Marker size={15} /> : i + 1}
            </span>
            <span className={`mt-2 font-ui text-xs ${current ? 'font-medium text-ink' : done ? 'text-ink-2' : 'text-ink-3'}`}>{label}</span>
            {current && onHold && <span className="font-ui text-[11px] text-warning">on hold</span>}
            <span className="sr-only">{done ? ' (done)' : current ? ' (current step)' : ' (not reached yet)'}</span>
          </li>
        );
      })}
    </ol>
  );
}
