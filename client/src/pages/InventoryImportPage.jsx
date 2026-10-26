import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, FileUp, LoaderCircle, Upload, X } from 'lucide-react';
import { importSnipeit, listImports } from '../api/inventory';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import { formatDateTime } from '../utils/format';
import { formatBytes } from '../utils/invoices';
import { statusLabel } from '../utils/assets';

function Stat({ label, value, tone }) {
  return (
    <div className="card p-3">
      <p className="font-ui text-xs uppercase tracking-wider text-ink-3">{label}</p>
      <p className={`mt-1 font-display text-2xl ${tone || 'text-brown'}`}>{value ?? 0}</p>
    </div>
  );
}

function List({ title, items, render, count }) {
  if (!items?.length) return null;
  return (
    <details className="card p-0 font-ui text-sm" open={items.length <= 10}>
      <summary className="cursor-pointer px-4 py-3 font-medium text-ink">
        {title} ({count ?? items.length})
      </summary>
      <ul className="max-h-72 divide-y divide-line overflow-y-auto border-t border-line">
        {items.map((x, i) => (
          <li key={i} className="px-4 py-1.5 text-ink-2">
            {render(x)}
          </li>
        ))}
      </ul>
      {count > items.length && <p className="border-t border-line px-4 py-2 text-xs text-ink-3">Showing the first {items.length}.</p>}
    </details>
  );
}

function Report({ r }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="New" value={r.created} />
        <Stat label="Updated" value={r.updated} />
        <Stat label="Unchanged" value={r.unchanged} />
        <Stat label="Rows with errors" value={r.errorCount} tone={r.errorCount ? 'text-error' : undefined} />
      </div>
      <p className="font-ui text-sm text-ink-2">
        {r.rows} rows · new categories {r.newCategories} · new places {r.newPlaces} ·{' '}
        {Object.entries(r.byStatus || {})
          .map(([k, n]) => `${statusLabel(k)} ${n}`)
          .join(' · ')}
      </p>
      <p className="font-ui text-sm text-ink-2">
        Flagged: <strong>{r.flagged.serialNeedsCheck}</strong> serials to check (damaged by Excel, left blank) ·{' '}
        <strong>{r.flagged.holderUnknown}</strong> in use with holder unknown
      </p>
      {r.overwroteAtomEdits > 0 && (
        <Alert tone="error">{r.overwroteAtomEdits} assets changed in ATOM since the last import will be overwritten with the Snipe-IT values.</Alert>
      )}
      {r.keptAtomEdits > 0 && <Alert tone="info">{r.keptAtomEdits} assets changed in ATOM are kept as they are (not updated from this file).</Alert>}
      <List title="Errors (these rows can't be imported)" items={r.errors} count={r.errorCount} render={(e) => `Row ${e.row} · ${e.tag}: ${e.reason}`} />
      <List title="Category fixes and merges" items={r.categoryChanges} render={(c) => `${c.change} (${c.count})`} />
      <List title="Changed in ATOM — will be overwritten" items={r.overwritten} render={(t) => t} />
      <List title="Changed in ATOM — kept" items={r.kept} render={(t) => t} />
      <List title="Tags added by hand in ATOM — not touched" items={r.conflicts} count={r.conflictCount} render={(t) => t} />
      <List title="Warnings" items={r.warnings} count={r.warningCount} render={(w) => `Row ${w.row} · ${w.tag}: ${w.reason}`} />
      <List title="In ATOM but not in this file — left as they are" items={r.notInFile} count={r.notInFileCount} render={(t) => t} />
    </div>
  );
}

// Super Admin: Snipe-IT CSV → preview → import. Re-run it whenever Snipe-IT changes, until switch-over.
export default function InventoryImportPage() {
  const queryClient = useQueryClient();
  const input = useRef(null);
  const [file, setFile] = useState(null);
  const [keepAtomEdits, setKeepAtomEdits] = useState(true);
  const [skipErrors, setSkipErrors] = useState(false);
  const [busy, setBusy] = useState(null); // 'preview' | 'commit'
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const history = useQuery({ queryKey: ['inventory', 'imports'], queryFn: listImports });

  function reset() {
    setPreview(null);
    setResult(null);
    setError('');
  }

  async function run(commit) {
    setBusy(commit ? 'commit' : 'preview');
    setError('');
    try {
      const r = await importSnipeit(file, { commit, keepAtomEdits, skipErrors });
      if (commit) {
        setResult(r);
        setPreview(null);
        queryClient.invalidateQueries({ queryKey: ['inventory'] });
      } else setPreview(r);
    } catch (err) {
      setError(errorMessage(err, 'Could not read the file.'));
    } finally {
      setBusy(null);
    }
  }

  const options = (
    <div className="space-y-2 font-ui text-sm">
      <label className="flex min-h-tap items-start gap-3">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={keepAtomEdits} onChange={(e) => { setKeepAtomEdits(e.target.checked); reset(); }} />
        <span>
          Keep changes made in ATOM
          <span className="block text-xs text-ink-3">Assets assigned, moved or edited in ATOM since the last import are not overwritten by Snipe-IT.</span>
        </span>
      </label>
      <label className="flex min-h-tap items-start gap-3">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={skipErrors} onChange={(e) => { setSkipErrors(e.target.checked); reset(); }} />
        <span>
          Skip rows with errors
          <span className="block text-xs text-ink-3">Import everything else; the rows listed under Errors are left out.</span>
        </span>
      </label>
    </div>
  );

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link to="/inventory" className="inline-flex items-center gap-1 font-ui text-sm text-primary hover:underline">
        <ArrowLeft size={16} aria-hidden="true" /> Inventory
      </Link>
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Super Admin</p>
        <h1 className="mt-1 text-3xl">Import from Snipe-IT</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">
          In Snipe-IT, export <strong>Reports → Custom Asset Report</strong> as CSV and upload it here <strong>without opening it in Excel</strong> (Excel damages serial numbers). You
          see a preview first; nothing is saved until you press Import. Re-import whenever Snipe-IT changes — assets are matched by Asset Tag.
        </p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {result && (
        <Alert tone="success">
          <span className="flex items-center gap-2">
            <CheckCircle2 size={16} aria-hidden="true" /> Imported: {result.created} new, {result.updated} updated, {result.unchanged} unchanged.
            <Link to="/inventory" className="font-medium underline">
              Open the inventory
            </Link>
          </span>
        </Alert>
      )}

      <section className="card space-y-4">
        {file ? (
          <div className="flex items-center gap-3 rounded-btn border border-line bg-cream-dark px-3 py-2 font-ui text-sm">
            <FileUp size={18} className="shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <span className="shrink-0 text-xs text-ink-3">{formatBytes(file.size)}</span>
            <button type="button" onClick={() => { setFile(null); reset(); }} className="flex min-h-tap min-w-tap items-center justify-center text-ink-3 hover:text-ink" aria-label="Remove file" disabled={Boolean(busy)}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <button type="button" className="btn-secondary w-full" onClick={() => input.current?.click()}>
            <FileUp size={18} aria-hidden="true" /> Choose the CSV file
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) {
              setFile(f);
              reset();
            }
          }}
        />
        {options}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" disabled={!file || Boolean(busy)} onClick={() => run(false)}>
            {busy === 'preview' ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : null} Preview
          </button>
          {preview && (
            <button type="button" className="btn-primary" disabled={Boolean(busy) || preview.blocked} onClick={() => run(true)}>
              {busy === 'commit' ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Upload size={18} aria-hidden="true" />} Import
            </button>
          )}
        </div>
        {preview?.blocked && (
          <Alert tone="error">
            {preview.errorCount} row(s) have errors. Fix them in Snipe-IT and export again, or tick “Skip rows with errors” and preview again.
          </Alert>
        )}
      </section>

      {preview && (
        <section className="space-y-2">
          <h2 className="text-xl">Preview — nothing saved yet</h2>
          <Report r={preview} />
        </section>
      )}
      {result && (
        <section className="space-y-2">
          <h2 className="text-xl">Result</h2>
          <Report r={result} />
        </section>
      )}

      {history.data?.length > 0 && (
        <section className="card p-0">
          <h2 className="border-b border-line px-4 py-3 text-xl">Earlier imports</h2>
          <ul className="divide-y divide-line">
            {history.data.map((h) => (
              <li key={h.id} className="px-4 py-2.5 font-ui text-sm">
                <p className="text-ink">
                  {formatDateTime(h.at)} · {h.by?.name || '—'} · {h.fileName || 'CSV'}
                </p>
                <p className="text-xs text-ink-3">
                  {h.rows} rows · new {h.summary.created} · updated {h.summary.updated} · unchanged {h.summary.unchanged}
                  {h.summary.skippedErrors ? ` · skipped ${h.summary.skippedErrors} with errors` : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
