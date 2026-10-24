import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Image as ImageIcon, LoaderCircle, Receipt, Search, Upload } from 'lucide-react';
import { listInvoices } from '../api/invoices';
import { Alert } from '../components/FormControls';
import InvoiceUploadForm from '../components/InvoiceUploadForm';
import Modal from '../components/Modal';
import { Pager } from '../components/RequestList';
import useAuth from '../hooks/useAuth';
import { timeAgo } from '../utils/format';
import { invoiceLabel } from '../utils/invoices';

const selectClass =
  'min-h-tap rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';
const PAGE_SIZE = 20;

// Engineers: invoices they uploaded + invoices on their assigned work. Super Admin: every invoice.
export default function InvoicesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') || '');
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const q = params.get('q') || '';
  const linked = params.get('linked') || '';
  const page = Number(params.get('page')) || 1;

  const set = (patch) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      if (!('page' in patch)) next.delete('page');
      return next;
    });

  useEffect(() => {
    const t = setTimeout(() => {
      if (search.trim() !== q) set({ q: search.trim() });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const query = useQuery({
    queryKey: ['invoices', 'list', q, linked, page],
    queryFn: () => listInvoices({ q: q || undefined, linked: linked || undefined, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const items = query.data?.invoices || [];
  const from = `/invoices${params.toString() ? `?${params}` : ''}`;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">
            {user.activeRole === 'SUPER_ADMIN' ? 'Super Admin' : 'Engineer'}
          </p>
          <h1 className="mt-1 text-3xl">Invoices</h1>
          <p className="mt-1 font-ui text-sm text-ink-2">
            {user.activeRole === 'SUPER_ADMIN'
              ? 'Every invoice, and the tickets it covers. Requesters never see invoices.'
              : 'Invoices you uploaded and invoices on tickets assigned to you.'}
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setUploading(true)}>
          <Upload size={18} aria-hidden="true" /> Upload invoice
        </button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative flex-1">
          <span className="sr-only">Search invoices</span>
          <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="INV number, ticket number, supplier or invoice number"
            className="block min-h-tap w-full rounded-btn border border-line bg-white pl-10 pr-3 font-ui text-sm text-ink placeholder:text-ink-3 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
          />
        </label>
        <select aria-label="Linked" className={selectClass} value={linked} onChange={(e) => set({ linked: e.target.value })}>
          <option value="">All invoices</option>
          <option value="linked">Linked to tickets</option>
          <option value="unlinked">Not linked yet</option>
        </select>
      </div>

      <p className="flex min-h-[1.25rem] items-center gap-2 font-ui text-sm text-ink-2" aria-live="polite">
        {query.isFetching && <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />}
        {query.isSuccess && `${query.data.total} ${query.data.total === 1 ? 'invoice' : 'invoices'}`}
      </p>

      {query.isError && <Alert tone="error">Could not load invoices.</Alert>}
      {query.isSuccess && !items.length && (
        <div className="card text-center">
          <Receipt size={24} className="mx-auto text-ink-3" aria-hidden="true" />
          <p className="mt-2 font-ui font-medium">{q || linked ? 'No invoices match' : 'No invoices yet'}</p>
          <p className="mt-1 font-ui text-sm text-ink-2">Upload one from here or from a ticket.</p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-white">
          {items.map((inv) => {
            const Icon = inv.fileType === 'pdf' ? FileText : ImageIcon;
            return (
              <li key={inv.id}>
                <Link
                  to={`/invoices/${inv.number}`}
                  state={{ from }}
                  className="flex items-start gap-3 px-4 py-3 font-ui hover:bg-gold-muted focus-visible:bg-gold-muted"
                >
                  <Icon size={20} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium tabular-nums text-ink">{inv.number}</span>
                      <span className="truncate text-sm text-ink-2">{invoiceLabel(inv)}</span>
                    </span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {inv.linked.length ? (
                        inv.linked.map((n) => (
                          <span key={n} className="badge bg-primary-muted text-primary">
                            {n}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-ink-3">Not linked to a ticket{inv.linkCount ? ' you work on' : ''}</span>
                      )}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-ink-3">
                    <span className="block">{timeAgo(inv.createdAt)}</span>
                    <span className="block">{inv.uploadedBy?.name}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {query.data && <Pager page={page} total={query.data.total} pageSize={PAGE_SIZE} onPage={(p) => set({ page: String(p) })} />}

      {uploading && (
        <Modal title="Upload invoice" onClose={() => setUploading(false)} busy={busy}>
          <InvoiceUploadForm
            onBusy={setBusy}
            onDone={(result) => {
              setUploading(false);
              queryClient.invalidateQueries({ queryKey: ['invoices'] });
              queryClient.invalidateQueries({ queryKey: ['requests'] });
              const message = result.linkedExisting
                ? `${result.invoice.number} already existed${result.added.length ? ` — linked to ${result.added.join(', ')}` : ''}.`
                : `${result.invoice.number} uploaded${result.added.length ? ` and linked to ${result.added.join(', ')}` : ''}.`;
              navigate(`/invoices/${result.invoice.number}`, { state: { from, notice: message } });
            }}
          />
        </Modal>
      )}
    </section>
  );
}
