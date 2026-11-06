// Leave dates are calendar days (YYYY-MM-DD), shown as "Fri 7 Nov 2026".
export const leaveDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const leaveSpan = (l) => (l.startDate === l.endDate ? leaveDay(l.startDate) : `${leaveDay(l.startDate)} – ${leaveDay(l.endDate)}`);
