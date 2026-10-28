// Time frames and the live timer (decided 28 Oct 2026): 24/7, from when it was raised until done.
import { useEffect, useState } from 'react';

// 30 → "30 min", 120 → "2 hours", 90 → "1 h 30 min", 2880 → "2 days"
export function minutesText(m) {
  if (m < 60) return `${m} min`;
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
export const windowText = (t) => (t ? `${minutesText(t.minMinutes)} – ${minutesText(t.maxMinutes)}` : '');

// ms → "1h 05m" / "12m" / "2d 3h"; withSeconds → "01:05:09"
export function durationText(ms, { withSeconds = false } = {}) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (withSeconds) {
    const h = Math.floor(s / 3600);
    const p = (n) => String(n).padStart(2, '0');
    return `${h >= 24 ? `${Math.floor(h / 24)}d ` : ''}${p(h % 24)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const TIME = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
const DAY = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
// "1:00 pm" today, otherwise "29 Oct, 1:00 pm"
export function clockText(d) {
  const date = new Date(d);
  const today = new Date().toDateString() === date.toDateString();
  return today ? TIME.format(date) : `${DAY.format(date)}, ${TIME.format(date)}`;
}

// Re-renders every `ms` so timers move.
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

// → { state: 'on_time' | 'due_soon' | 'overdue' | 'done' | 'done_late' | 'none', elapsed, left, late }
export function timeState(t, now) {
  if (!t?.dueBy) return { state: 'none' };
  const start = new Date(t.createdAt).getTime();
  const due = new Date(t.dueBy).getTime();
  if (t.doneAt) {
    const end = new Date(t.doneAt).getTime();
    return { state: end > due ? 'done_late' : 'done', elapsed: end - start, late: end - due };
  }
  const elapsed = now - start;
  if (now > due) return { state: 'overdue', elapsed, late: now - due };
  const left = due - now;
  return { state: left <= 0.25 * (due - start) ? 'due_soon' : 'on_time', elapsed, left };
}
