import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Image as ImageIcon, Link2, LoaderCircle, Receipt, Search, Upload } from 'lucide-react';
import { linkInvoice, listInvoices } from '../api/invoices';
import { errorMessage } from '../api/http';
import { Alert } from './FormControls';
import InvoiceUploadForm from './InvoiceUploadForm';
import Modal from './Modal';
import { invoiceLabel } from '../utils/invoices';

function LinkExistingModal({ ticket, onClose, onDone }) {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const query = useQuery({
    queryKey: ['invoices', 'list', 'picker', q],
    queryFn: () => listInvoices({ q: q || undefined, pageSize: 10 }),
  });
  const linkedHere = new Set(ticket.invoices.map((i) => i.number));

  async function pick(inv) {
    setBusy(inv.number);
    setError('');
    try {
      await linkInvoice(inv.number, [ticket.number]);
      onDone(`${inv.number} linked to ${ticket.number}.`);
    } catch (err) {
      setError(errorMessage(err, 'Could not link.'));
      setBusy(null);
    }
  }

  return (
    <Modal title="Link an existing invoice" onClose={onClose} busy={Boolean(busy)}>
      <div className="space-y-3">
        {error && <Alert tone="error">{error}</Alert>}
        <label className="relative block">
          <span className="sr-only">Search invoices</span>
          <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="INV number, ticket, supplier…"
            className="block min-h-tap w-full rounded-btn border border-line bg-white pl-10 pr-3 font-ui text-sm text-ink placeholder:text-ink-3 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
          />
        </label>
        {query.isPending && (
          <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
            <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> Loading…
          </p>
        )}
        {query.isError && <Alert tone="error">Could not load invoices.</Alert>}
        {query.isSuccess && !query.data.invoices.length && <p className="font-ui text-sm text-ink-3">No invoices found.</p>}
        <ul className="divide-y divide-line">
          {(query.data?.invoices || []).map((inv) => (
            <li key={inv.id} className="flex items-center gap-3 py-2 font-ui text-sm">
              <span className="min-w-0 flex-1">
                <span className="block font-medium tabular-nums">{inv.number}</span>
                <span className="block truncate text-xs text-ink-2">{invoiceLabel(inv)}</span>
              </span>
              {linkedHere.has(inv.number) ? (
                <span className="text-xs text-ink-3">Already linked</span>
              ) : (
                <button type="button" className="btn-secondary" disabled={Boolean(busy)} onClick={() => pick(inv)}>
                  {busy === inv.number ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}
                  Link
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

// Ticket page: invoices on this ticket (Super Admins + the assigned engineer only).
export default function TicketInvoices({ ticket, onChanged }) {
  const queryClient = useQueryClient();
  const [modal, setModal] = useState(null); // 'upload' | 'link'
  const [busy, setBusy] = useState(false);
  const from = `/tickets/${ticket.number}`;

  const refresh = (message) => {
    setModal(null);
    queryClient.invalidateQueries({ queryKey: ['invoices'] });
    onChanged(message);
  };

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xl">
          <Receipt size={20} className="text-ink-3" aria-hidden="true" /> Invoices
        </h2>
        {ticket.permissions.canLinkInvoices && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={() => setModal('link')}>
              <Link2 size={16} aria-hidden="true" /> Link existing
            </button>
            <button type="button" className="btn-primary" onClick={() => setModal('upload')}>
              <Upload size={16} aria-hidden="true" /> Upload invoice
            </button>
          </div>
        )}
      </div>
      <p className="mt-1 font-ui text-xs text-ink-3">Only the Admin and the assigned staff member see invoices.</p>

      {ticket.invoices.length ? (
        <ul className="mt-3 divide-y divide-line">
          {ticket.invoices.map((inv) => {
            const Icon = inv.fileType === 'pdf' ? FileText : ImageIcon;
            return (
              <li key={inv.id}>
                <Link
                  to={`/invoices/${inv.number}`}
                  state={{ from }}
                  className="flex items-center gap-3 py-2.5 font-ui text-sm hover:bg-gold-muted focus-visible:bg-gold-muted"
                >
                  <Icon size={18} className="shrink-0 text-primary" aria-hidden="true" />
                  <span className="font-medium tabular-nums text-ink">{inv.number}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-2">{invoiceLabel(inv)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 font-ui text-sm text-ink-3">No invoices linked yet.</p>
      )}

      {modal === 'upload' && (
        <Modal title={`Upload invoice for ${ticket.number}`} onClose={() => setModal(null)} busy={busy}>
          <InvoiceUploadForm
            tickets={[ticket.number]}
            onBusy={setBusy}
            onDone={(r) =>
              refresh(
                r.linkedExisting
                  ? `${r.invoice.number} already existed${r.added.length ? ` — linked to ${ticket.number}` : ` and was already linked to ${ticket.number}`}.`
                  : `${r.invoice.number} uploaded and linked to ${ticket.number}.`
              )
            }
          />
        </Modal>
      )}
      {modal === 'link' && <LinkExistingModal ticket={ticket} onClose={() => setModal(null)} onDone={refresh} />}
    </section>
  );
}
