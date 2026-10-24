import { useRef, useState } from 'react';
import { FileUp, Link2, LoaderCircle, X } from 'lucide-react';
import { uploadInvoice } from '../api/invoices';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from './FormControls';
import { ACCEPT, ACCEPTED_TYPES, MAX_BYTES, formatBytes, splitTicketNumbers } from '../utils/invoices';

const textareaClass =
  'block w-full rounded-btn border border-line bg-white px-3 py-2 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';

// Upload one invoice. `tickets` = fixed ticket numbers (from a ticket page) — the ticket field is hidden.
// A duplicate file offers "link the existing one instead" (same file, linkExisting=true).
export default function InvoiceUploadForm({ tickets: fixedTickets, onDone, onBusy }) {
  const fileInput = useRef(null);
  const [file, setFile] = useState(null);
  const [fields, setFields] = useState({ supplier: '', reference: '', invoiceDate: '', note: '', tickets: '' });
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => {
    setFields((f) => ({ ...f, [k]: e.target.value }));
    setDuplicate(null);
  };

  function pick(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    setError('');
    setDuplicate(null);
    if (!f) return;
    if (!ACCEPTED_TYPES.has(f.type)) return setError('Invoices must be a PDF, JPG, PNG or WebP file.');
    if (f.size > MAX_BYTES) return setError('The invoice must be 10 MB or smaller.');
    return setFile(f);
  }

  const parsed = fixedTickets ? { ok: fixedTickets, bad: [] } : splitTicketNumbers(fields.tickets);

  async function send(linkExisting = false) {
    setError('');
    if (!file) return setError('Choose the invoice file.');
    if (parsed.bad.length) return setError(`Not a ticket number: ${parsed.bad.join(', ')}`);
    setBusy(true);
    onBusy?.(true);
    try {
      const result = await uploadInvoice(
        {
          supplier: fields.supplier.trim(),
          reference: fields.reference.trim(),
          invoiceDate: fields.invoiceDate,
          note: fields.note.trim(),
          requestNumbers: parsed.ok.join(','),
          linkExisting: linkExisting ? 'true' : undefined,
        },
        file
      );
      onDone(result);
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.duplicate) setDuplicate(err.response.data.duplicate);
      else setError(errorMessage(err, 'Could not upload the invoice.'));
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
    return undefined;
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        send(false);
      }}
      noValidate
    >
      {error && <Alert tone="error">{error}</Alert>}
      {duplicate && (
        <Alert tone="info">
          <p>
            <strong>This invoice already exists ({duplicate.number}).</strong>{' '}
            {parsed.ok.length ? `Link it to ${parsed.ok.join(', ')} instead?` : 'Add the ticket numbers above to link it instead.'}
          </p>
          {parsed.ok.length > 0 && (
            <button type="button" className="btn-primary mt-2" onClick={() => send(true)} disabled={busy}>
              {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Link2 size={18} aria-hidden="true" />}
              Link {duplicate.number}
            </button>
          )}
        </Alert>
      )}

      <div>
        <p className="mb-1.5 font-ui text-sm font-medium text-ink">Invoice file</p>
        {file ? (
          <div className="flex items-center gap-3 rounded-btn border border-line bg-cream-dark px-3 py-2 font-ui text-sm">
            <FileUp size={18} className="shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <span className="shrink-0 text-xs text-ink-3">{formatBytes(file.size)}</span>
            <button
              type="button"
              onClick={() => {
                setFile(null);
                setDuplicate(null);
              }}
              className="flex min-h-tap min-w-tap items-center justify-center rounded-btn text-ink-3 hover:text-ink"
              aria-label="Remove file"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <button type="button" className="btn-secondary w-full" onClick={() => fileInput.current?.click()}>
            <FileUp size={18} aria-hidden="true" /> Choose file
          </button>
        )}
        <input ref={fileInput} type="file" accept={ACCEPT} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={pick} />
        <p className="mt-1 font-ui text-xs text-ink-3">PDF, JPG, PNG or WebP, up to 10 MB. No amounts needed.</p>
      </div>

      {fixedTickets ? (
        <p className="font-ui text-sm text-ink-2">Will be linked to {fixedTickets.join(', ')}.</p>
      ) : (
        <Field id="inv-tickets" label="Link to tickets (optional)" hint="Ticket numbers, e.g. T-1001, T-1002">
          <TextInput id="inv-tickets" value={fields.tickets} onChange={set('tickets')} placeholder="T-1001, T-1002" />
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="inv-supplier" label="Supplier (optional)">
          <TextInput id="inv-supplier" value={fields.supplier} onChange={set('supplier')} maxLength={120} />
        </Field>
        <Field id="inv-reference" label="Invoice number (optional)" hint="The supplier's own number">
          <TextInput id="inv-reference" value={fields.reference} onChange={set('reference')} maxLength={80} />
        </Field>
        <Field id="inv-date" label="Invoice date (optional)">
          <TextInput id="inv-date" type="date" value={fields.invoiceDate} onChange={set('invoiceDate')} />
        </Field>
      </div>
      <Field id="inv-note" label="Note (optional)">
        <textarea id="inv-note" rows={2} maxLength={1000} value={fields.note} onChange={set('note')} className={textareaClass} />
      </Field>

      <div className="flex justify-end">
        <button type="submit" className="btn-primary" disabled={busy || !file}>
          {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <FileUp size={18} aria-hidden="true" />}
          Upload invoice
        </button>
      </div>
    </form>
  );
}
