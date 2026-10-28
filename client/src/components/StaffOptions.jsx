// <option>s for a staff picker, grouped by occupation ("Carpenter", "Electrician", …).
// staff: [{ id, name, occupation, open_work }] from the API (already in occupation order).
//   showOpen  "(3 open)" after each name · currentId  marks and disables the current one
export default function StaffOptions({ staff = [], showOpen = true, currentId = null }) {
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
        <option key={s.id} value={s.id} disabled={s.id === currentId}>
          {s.name}
          {showOpen ? ` (${s.open_work} open)` : ''}
          {s.id === currentId ? ' — current' : ''}
        </option>
      ))}
    </optgroup>
  ));
}
