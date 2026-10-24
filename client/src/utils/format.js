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
  legacy: 'Imported',
  manual: 'Added by hand',
};

// "ITS 30328701" / "Employee ID 1002"
export function loginIdLabel(u) {
  return u.loginType === 'ITS' ? `ITS ${u.itsNumber}` : `Employee ID ${u.employeeId}`;
}
