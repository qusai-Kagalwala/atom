import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { expiryText, timeLeft } from '../../utils/wifi';

// "Expires in 2 d 4 h 10 min" — ticks every second. Red in the last hour.
export default function Countdown({ to, className = '' }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = new Date(to).getTime() - now;
  const tone = left <= 0 ? 'text-error' : left < 3600_000 ? 'text-error' : 'text-ink-2';
  return (
    <span className={`inline-flex items-center gap-1.5 font-ui text-sm ${tone} ${className}`} title={expiryText(to)}>
      <Timer size={16} aria-hidden="true" />
      {left <= 0 ? 'Expired — being removed' : <>Expires in <strong className="tabular-nums">{timeLeft(to, now)}</strong></>}
    </span>
  );
}
