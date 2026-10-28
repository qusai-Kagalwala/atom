import { AlarmClock, CircleCheck, Timer } from 'lucide-react';
import { clockText, durationText, timeState, useNow } from '../utils/timeFrame';

const TONE = {
  on_time: 'bg-primary-tint text-primary',
  due_soon: 'bg-warning-bg text-warning',
  overdue: 'bg-error-bg text-error',
  done: 'bg-success-bg text-success',
  done_late: 'bg-warning-bg text-warning',
};

// Small badge for lists: "1h 05m · due in 55m" / "Overdue by 20m" / "Done in 2h 10m".
export function TimeBadge({ t }) {
  const now = useNow(30_000);
  const s = timeState(t, now);
  if (s.state === 'none') return null;
  const text =
    s.state === 'overdue'
      ? `Overdue by ${durationText(s.late)}`
      : s.state === 'done' || s.state === 'done_late'
        ? `Done in ${durationText(s.elapsed)}`
        : `${durationText(s.elapsed)} · due in ${durationText(s.left)}`;
  return (
    <span className={`badge gap-1 ${TONE[s.state]}`} title={`Expected by ${clockText(t.dueBy)}`}>
      {s.state === 'overdue' ? <AlarmClock size={12} aria-hidden="true" /> : <Timer size={12} aria-hidden="true" />} {text}
    </span>
  );
}

// Ticket / request page: live timer from when it was raised until it is done, and the window.
export default function TimeFrame({ t, isService }) {
  const now = useNow(1000);
  const s = timeState(t, now);
  if (s.state === 'none') return null;
  const done = s.state === 'done' || s.state === 'done_late';
  return (
    <div className={`mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-btn px-4 py-3 font-ui text-sm ${TONE[s.state]}`} role="timer" aria-live="off">
      <span className="flex items-center gap-2">
        {done ? <CircleCheck size={18} aria-hidden="true" /> : s.state === 'overdue' ? <AlarmClock size={18} aria-hidden="true" /> : <Timer size={18} aria-hidden="true" />}
        <span>
          <span className="block text-xs uppercase tracking-wider opacity-80">{done ? (isService ? 'Delivered in' : 'Done in') : 'Open for'}</span>
          <span className="font-display text-xl tabular-nums">{durationText(s.elapsed, { withSeconds: !done })}</span>
        </span>
      </span>
      <span>
        <span className="block text-xs uppercase tracking-wider opacity-80">Expected</span>
        {clockText(t.dueFrom)} – {clockText(t.dueBy)}
      </span>
      <span className="font-medium">
        {s.state === 'overdue' && `Overdue by ${durationText(s.late)}`}
        {s.state === 'due_soon' && `Due in ${durationText(s.left)}`}
        {s.state === 'on_time' && `Due in ${durationText(s.left)}`}
        {s.state === 'done' && 'On time'}
        {s.state === 'done_late' && `Late by ${durationText(s.late)}`}
      </span>
    </div>
  );
}
