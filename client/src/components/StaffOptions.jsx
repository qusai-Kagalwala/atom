// <option>s for a staff picker, grouped by occupation ("Carpenter", "Electrician", …).
// staff: [{ id, name, occupation, open_work, onLeaveUntil }] from the API (already in occupation order).
//   showOpen    "(3 open)" after each name · currentId  marks and disables the current one
//   blockLeave  people on approved leave today can't be picked (assigning work); filters leave it off
const leaveDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export default function StaffOptions({ staff = [], showOpen = true, currentId = null, blockLeave = false }) {
  const groups = [];
  for (const s of staff) {
    const name = s.occupation || 'Staff';
    let g = groups.find((x) => x.name === name);
    if (!g) groups.push((g = { name, items: [] }));
    g.items.push(s);
  }
  return groups.map((g) => (
    <optgroup key={g.name} label={g.name}>
      {g.items.map((s) => (
        <option key={s.id} value={s.id} disabled={s.id === currentId || (blockLeave && Boolean(s.onLeaveUntil))}>
          {s.name}
          {showOpen ? ` (${s.open_work} open)` : ''}
          {s.onLeaveUntil ? ` — on leave till ${leaveDate(s.onLeaveUntil)}` : ''}
          {s.id === currentId ? ' — current' : ''}
        </option>
      ))}
    </optgroup>
  ));
}
