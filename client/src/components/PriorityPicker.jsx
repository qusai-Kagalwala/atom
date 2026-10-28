import { useQuery } from '@tanstack/react-query';
import { Timer } from 'lucide-react';
import { getTimeFrames } from '../api/requests';
import { PRIORITIES, REQUESTER_PRIORITIES } from '../utils/requests';
import { windowText } from '../utils/timeFrame';

// "How urgent?" — High / Normal / Low, each with its time frame (24/7, from when it is raised).
export default function PriorityPicker({ value, onChange, name = 'priority', note }) {
  const frames = useQuery({ queryKey: ['time-frames'], queryFn: getTimeFrames, staleTime: 10 * 60_000 });
  const frameOf = (p) => frames.data?.find((f) => f.priority === p);
  const order = [...REQUESTER_PRIORITIES].reverse(); // High first
  return (
    <fieldset>
      <legend className="mb-1.5 font-ui text-sm font-medium text-ink">How urgent?</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {order.map((p) => (
          <label
            key={p}
            className={`flex min-h-tap cursor-pointer flex-col items-center justify-center rounded-btn border px-3 py-1 text-center font-ui text-sm ${
              value === p ? 'border-primary bg-primary-tint text-primary' : 'border-line text-ink hover:border-gold'
            }`}
          >
            <input type="radio" name={name} value={p} checked={value === p} onChange={() => onChange(p)} className="sr-only" />
            {PRIORITIES[p].requesterLabel}
            {frameOf(p) && <span className="text-xs text-ink-3">{windowText(frameOf(p))}</span>}
          </label>
        ))}
      </div>
      {frameOf(value) && (
        <p className="mt-2 flex items-center gap-1 font-ui text-xs text-ink-2">
          <Timer size={14} aria-hidden="true" /> Expected within {windowText(frameOf(value))} of sending (any day, any time).
          {note && ` ${note}`}
        </p>
      )}
    </fieldset>
  );
}
