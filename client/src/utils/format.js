// Shared display helpers.
const DATE_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : DATE_TIME.format(d);
}

export function formatDuration(start, end) {
  if (!start || !end) return '—';
  const ms = new Date(end) - new Date(start);
  if (!(ms >= 0)) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export const SOURCE_LABELS = {
  idarah: 'Synced',
  hr: 'HR list',
  legacy: 'Imported',
  manual: 'Added by hand',
};

// "ITS 30328701" / "Employee ID 1002"
export function loginIdLabel(u) {
  return u.loginType === 'ITS' ? `ITS ${u.itsNumber}` : `Employee ID ${u.employeeId}`;
}

// "just now", "5 min ago", "3 h ago", "2 days ago", then the date.
export function timeAgo(value) {
  if (!value) return '—';
  const ms = Date.now() - new Date(value).getTime();
  if (Number.isNaN(ms)) return '—';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d} day${d === 1 ? '' : 's'} ago`;
  return formatDateTime(value);
}
