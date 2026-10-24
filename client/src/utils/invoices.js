// "1.2 MB", "340 KB"
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

// "2026-10-20" → "20 Oct 2026" (date only, no time zone shifts)
export function formatInvoiceDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

// One line describing an invoice: "Croma · LR-55 · 20 Oct 2026"
export function invoiceLabel(inv) {
  return [inv.supplier, inv.reference, formatInvoiceDate(inv.invoiceDate)].filter(Boolean).join(' · ') || 'No details added';
}

export const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';
export const ACCEPTED_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
export const MAX_BYTES = 10 * 1024 * 1024;

// "T-1001, 1002" → ["T-1001", "T-1002"]; invalid entries returned separately.
export function splitTicketNumbers(text) {
  const ok = [];
  const bad = [];
  for (const part of String(text || '').split(/[\s,]+/).filter(Boolean)) {
    const m = /^(?:([TR])-?)?(\d{1,9})$/i.exec(part);
    if (!m) bad.push(part);
    else {
      const n = `${(m[1] || 'T').toUpperCase()}-${m[2]}`;
      if (!ok.includes(n)) ok.push(n);
    }
  }
  return { ok, bad };
}
