// Report / analytics periods as YYYY-MM-DD in India time (Phase 15).
const TZ = 'Asia/Kolkata';
export const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function monthBounds(day, back = 0) {
  const d = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  const from = d.toISOString().slice(0, 10);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return { from, to: addDays(d.toISOString().slice(0, 10), -1) };
}
export const PRESETS = [
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['month', 'This month'],
  ['lastMonth', 'Last month'],
  ['90d', 'Last 90 days'],
  ['custom', 'Custom'],
];
export function presetRange(key) {
  const t = todayLocal();
  if (key === '7d') return { from: addDays(t, -6), to: t };
  if (key === '90d') return { from: addDays(t, -89), to: t };
  if (key === 'month') return { from: monthBounds(t).from, to: t };
  if (key === 'lastMonth') return monthBounds(t, 1);
  return { from: addDays(t, -29), to: t };
}
export const showDay = (d) => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
export function duration(min) {
  if (min == null) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60 ? `${min % 60} min` : ''}`.trim();
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
export const pctText = (v) => (v == null ? '—' : `${v}%`);

// { preset, from, to } for the period pickers.
export function initialPeriod(preset = '30d') {
  return { preset, ...presetRange(preset) };
}
