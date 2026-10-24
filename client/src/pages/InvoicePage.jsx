import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Link2, LoaderCircle, Pencil, Unlink } from 'lucide-react';
import { getInvoice, linkInvoice, unlinkInvoice, updateInvoice } from '../api/invoices';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import InvoiceFile from '../components/InvoiceFile';
import Modal from '../components/Modal';
import { formatDateTime } from '../utils/format';
import { formatBytes, formatInvoiceDate, splitTicketNumbers } from '../utils/invoices';
import { statusBadge, statusLabel } from '../utils/requests';

const textareaClass =
  'block w-full rounded-btn border border-line bg-white px-3 py-2 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';

function EditModal({ invoice, onClose, onDone }) {
  const [f, setF] = useState({
    supplier: invoice.supplier || '',
    reference: invoice.reference || '',
    invoiceDate: invoice.invoiceDate || '',
    note: invoice.note || '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    setError('');
    try {
      onDone(await updateInvoice(invoice.number, f), 'Details saved.');
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Edit ${invoice.number}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy}>
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Field id="e-supplier" label="Supplier">
          <TextInput id="e-supplier" value={f.supplier} onChange={set('supplier')} maxLength={120} />
        </Field>
        <Field id="e-reference" label="Invoice number" hint="The supplier's own number">
          <TextInput id="e-reference" value={f.reference} onChange={set('reference')} maxLength={80} />
        </Field>
        <Field id="e-date" label="Invoice date">
          <TextInput id="e-date" type="date" value={f.invoiceDate} onChange={set('invoiceDate')} />
        </Field>
        <Field id="e-note" label="Note">
          <textarea id="e-note" rows={3} maxLength={1000} value={f.note} onChange={set('note')} className={textareaClass} />
        </Field>
      </div>
    </Modal>
  );
}

function LinkModal({ invoice, onClose, onDone }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { ok, bad } = splitTicketNumbers(text);

  async function save() {
    if (bad.length) return setError(`Not a ticket number: ${bad.join(', ')}`);
    if (!ok.length) return setError('Enter at least one ticket number.');
    setBusy(true);
    setError('');
    try {
      const r = await linkInvoice(invoice.number, ok);
      const parts = [];
      if (r.added.length) parts.push(`Linked to ${r.added.join(', ')}.`);
      if (r.already.length) parts.push(`Already linked: ${r.already.join(', ')}.`);
      onDone(r.invoice, parts.join(' '));
    } catch (err) {
      setError(errorMessage(err, 'Could not link.'));
      setBusy(false);
    }
    return undefined;
  }

  return (
    <Modal
      title={`Link ${invoice.number} to tickets`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy}>
            {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Link2 size={18} aria-hidden="true" />} Link
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert tone="error">{error}</Alert>}
        <Field id="l-tickets" label="Ticket numbers" hint="One or more, e.g. T-1001, T-1002">
          <TextInput id="l-tickets" value={text} onChange={(e) => setText(e.target.value)} placeholder="T-1001, T-1002" />
        </Field>
      </div>
    </Modal>
  );
}

function UnlinkModal({ invoice, ticket, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (reason.trim().length < 3) return setError('Enter a reason (at least 3 characters).');
    setBusy(true);
    setError('');
    try {
      onDone(await unlinkInvoice(invoice.number, ticket, reason.trim()), `Unlinked from ${ticket}.`);
    } catch (err) {
      setError(errorMessage(err, 'Could not unlink.'));
      setBusy(false);
    }
    return undefined;
  }

  return (
    <Modal
      title={`Unlink from ${ticket}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-danger" onClick={save} disabled={busy}>
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Unlink
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert tone="error">{error}</Alert>}
        <p className="font-ui text-sm text-ink-2">The link stays in the history. You can link it again later.</p>
        <Field id="u-reason" label="Reason">
          <textarea id="u-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className={textareaClass} />
        </Field>
      </div>
    </Modal>
  );
}

function Detail({ label, children }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-ink-3">{label}</dt>
      <dd className="text-ink">{children || <span className="text-ink-3">—</span>}</dd>
    </div>
  );
}

export default function InvoicePage() {
  const { number } = useParams();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [modal, setModal] = useState(null); // 'edit' | 'link' | { unlink: 'T-1001' }
  const [notice, setNotice] = useState(location.state?.notice || '');
  const from = typeof location.state?.from === 'string' ? location.state.from : null;
  const back = from && from.startsWith('/tickets/') ? { to: from, label: `Back to ${from.split('/').pop()}` } : { to: from || '/invoices', label: 'Invoices' };

  const key = ['invoices', 'detail', number];
  const query = useQuery({ queryKey: key, queryFn: () => getInvoice(number), retry: false });

  const done = (fresh, message) => {
    queryClient.setQueryData(key, fresh);
    queryClient.invalidateQueries({ queryKey: ['invoices', 'list'] });
    queryClient.invalidateQueries({ queryKey: ['requests'] });
    setModal(null);
    setNotice(message);
  };

  if (query.isPending) {
    return (
      <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
        <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading…
      </p>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-4">
        <Link to={back.to} className="inline-flex items-center gap-1 font-ui text-sm text-primary hover:underline">
          <ArrowLeft size={16} aria-hidden="true" /> {back.label}
        </Link>
        <Alert tone="error">{errorMessage(query.error, 'Could not load this invoice.')}</Alert>
      </div>
    );
  }

  const inv = query.data;
  const active = inv.links.filter((l) => !l.unlinkedAt);
  const ended = inv.links.filter((l) => l.unlinkedAt);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link to={back.to} className="inline-flex items-center gap-1 font-ui text-sm text-primary hover:underline">
        <ArrowLeft size={16} aria-hidden="true" /> {back.label}
      </Link>
      {notice && <Alert tone="success">{notice}</Alert>}

      <header className="card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-ui text-xs text-ink-3">
              {inv.fileType === 'pdf' ? 'PDF' : 'Image'} · {formatBytes(inv.sizeBytes)}
              {inv.originalName ? ` · ${inv.originalName}` : ''}
            </p>
            <h1 className="mt-1 text-2xl tabular-nums sm:text-3xl">{inv.number}</h1>
          </div>
          {inv.permissions.canEdit && (
            <button type="button" className="btn-secondary" onClick={() => setModal('edit')}>
              <Pencil size={16} aria-hidden="true" /> Edit details
            </button>
          )}
        </div>
        <dl className="mt-4 grid gap-x-6 gap-y-3 font-ui text-sm sm:grid-cols-2">
          <Detail label="Supplier">{inv.supplier}</Detail>
          <Detail label="Invoice number">{inv.reference}</Detail>
          <Detail label="Invoice date">{formatInvoiceDate(inv.invoiceDate)}</Detail>
          <Detail label="Uploaded">
            {inv.uploadedBy?.name} · {formatDateTime(inv.createdAt)}
          </Detail>
        </dl>
        {inv.note && <p className="mt-4 whitespace-pre-wrap font-ui text-sm text-ink">{inv.note}</p>}
      </header>

      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl">Linked tickets</h2>
          {inv.permissions.canLink && (
            <button type="button" className="btn-secondary" onClick={() => setModal('link')}>
              <Link2 size={16} aria-hidden="true" /> Link to tickets
            </button>
          )}
        </div>
        {active.length ? (
          <ul className="mt-3 divide-y divide-line">
            {active.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 font-ui text-sm">
                <Link to={`/tickets/${l.request.number}`} state={{ from: `/invoices/${inv.number}` }} className="font-medium tabular-nums text-primary hover:underline">
                  {l.request.number}
                </Link>
                <span className="min-w-0 flex-1 truncate text-ink">{l.request.title}</span>
                <span className={statusBadge(l.request.status)}>{statusLabel(l.request.status)}</span>
                <span className="w-full text-xs text-ink-3 sm:w-auto">
                  Linked by {l.linkedBy?.name} · {formatDateTime(l.linkedAt)}
                </span>
                {inv.permissions.canUnlink && (
                  <button
                    type="button"
                    className="flex min-h-tap items-center gap-1 text-xs text-error hover:underline"
                    onClick={() => setModal({ unlink: l.request.number })}
                  >
                    <Unlink size={14} aria-hidden="true" /> Unlink
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 font-ui text-sm text-ink-3">Not linked to {inv.otherLinks ? 'any ticket you work on' : 'any ticket yet'}.</p>
        )}
        {inv.otherLinks > 0 && (
          <p className="mt-2 font-ui text-xs text-ink-3">
            Also linked to {inv.otherLinks} other {inv.otherLinks === 1 ? 'ticket' : 'tickets'} you don't work on.
          </p>
        )}
        {ended.length > 0 && (
          <details className="mt-4 font-ui text-sm">
            <summary className="cursor-pointer text-ink-2">Earlier links ({ended.length})</summary>
            <ul className="mt-2 space-y-2">
              {ended.map((l) => (
                <li key={l.id} className="text-ink-2">
                  <span className="tabular-nums">{l.request.number}</span>: unlinked by {l.unlinkedBy?.name} · {formatDateTime(l.unlinkedAt)}
                  <span className="block text-xs text-ink-3">“{l.unlinkReason}”</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="card">
        <h2 className="mb-3 text-xl">File</h2>
        <InvoiceFile invoice={inv} />
      </section>

      {modal === 'edit' && <EditModal invoice={inv} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'link' && <LinkModal invoice={inv} onClose={() => setModal(null)} onDone={done} />}
      {modal?.unlink && <UnlinkModal invoice={inv} ticket={modal.unlink} onClose={() => setModal(null)} onDone={done} />}
    </div>
  );
}
