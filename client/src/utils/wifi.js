// Guest Wi-Fi helpers (shared by the Admin and HOD pages).
const fmt = (d) =>
  new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export const expiryText = fmt;

// "2 d 4 h", "3 h 12 min", "45 s"
export function timeLeft(to, now = Date.now()) {
  const s = Math.floor((new Date(to).getTime() - now) / 1000);
  if (s <= 0) return 'expired';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h ${m} min`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${s % 60} s`;
  return `${s} s`;
}

export function passMessage(p) {
  return [
    `Assalamu Alaikum ${p.recipient?.name || ''},`.trim(),
    '',
    'Your guest Wi-Fi access at Aljamea-tus-Saifiyah:',
    `Wi-Fi network (SSID): ${p.ssid}`,
    `Username: ${p.username}`,
    `Password: ${p.password}`,
    `Valid until: ${fmt(p.expiresAt)}`,
    '',
    'Connect to the network, then sign in with the username and password above.',
  ].join('\n');
}

// wa.me needs the number in international form, digits only. 10-digit numbers are taken as India (+91).
export function whatsappLink(p) {
  let digits = String(p.recipient?.mobile || '').replace(/\D/g, '');
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) digits = `91${digits.slice(1)}`;
  const text = encodeURIComponent(passMessage(p));
  return digits ? `https://wa.me/${digits}?text=${text}` : `https://wa.me/?text=${text}`;
}

// Bulk list: one person per line — "ITS" (8 digits, details looked up) or "Name, Mobile, Email[, Count]".
export function parsePeople(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      if (/^\d{8}$/.test(line)) return { key: i, its: line, name: '', mobile: '', email: '', count: 1, lookup: true };
      const [a = '', b = '', c = '', d = ''] = line.split(/[,\t;]/).map((x) => x.trim());
      if (/^\d{8}$/.test(a)) return { key: i, its: a, name: b, mobile: c, email: d, count: 1, lookup: !b };
      const count = /^\d+$/.test(d) ? Number(d) : 1;
      return { key: i, its: '', name: a, mobile: b, email: c, count, lookup: false };
    });
}
