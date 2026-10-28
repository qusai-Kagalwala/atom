import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileUp, LoaderCircle, Upload, X } from 'lucide-react';
import { importInventoryFile } from '../api/inventory';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import { formatDateTime } from '../utils/format';

const show = (v) => (v == null || v === '' ? '(empty)' : String(v));

// Super Admin: import an inventory .xlsx exported from ATOM (after it was shared and edited).
export default function InventoryFilePage() {
  const queryClient = useQueryClient();
  const input = useRef(null);
  const [file, setFile] = useState(null);
  const [opts, setOpts] = useState({ overwrite: false, allowNew: true, skipErrors: false });
  const [busy, setBusy] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const tick = (k) => (e) => {
    setOpts((o) => ({ ...o, [k]: e.target.checked }));
    setPreview(null);
  };

  async function run(commit) {
    setBusy(commit ? 'commit' : 'preview');
    setError('');
    try {
      const r = await importInventoryFile(file, { commit, ...opts });
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

  const p = preview;
  const blocked = p && p.errors.length > 0 && !opts.skipErrors;
  return (
    <section className="mx-auto max-w-4xl space-y-5">
      <Link to="/inventory" className="inline-flex items-center gap-1 font-ui text-sm text-primary hover:underline">
        <ArrowLeft size={16} aria-hidden="true" /> Inventory
      </Link>
      <div>
        <h1 className="text-3xl">Import inventory file</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">
          The .xlsx exported from Inventory, after it was shared and edited. Assets are matched by Asset tag. Only the white columns are applied —
          what the file says is saved, and an emptied cell clears that field. Status and who it is assigned to are never changed here.
        </p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {result && (
        <Alert tone="success">
          Imported: {result.updated} updated, {result.created} added, {result.unchanged} unchanged
          {result.changedSinceExport.length > 0 && `, ${result.changedSinceExport.length} skipped (changed in ATOM after the export)`}
          {result.errors.length > 0 && `, ${result.errors.length} rows with errors left out`}.
        </Alert>
      )}

      <div className="card space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={input}
            type="file"
            accept=".xlsx"
            className="sr-only"
            id="inv-file"
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setPreview(null);
              setResult(null);
              setError('');
            }}
          />
          <label htmlFor="inv-file" className="btn-secondary cursor-pointer">
            <Upload size={18} aria-hidden="true" /> Choose .xlsx
          </label>
          {file && (
            <span className="flex items-center gap-2 font-ui text-sm text-ink">
              {file.name}
              <button
                type="button"
                aria-label="Remove file"
                className="text-ink-3 hover:text-error"
                onClick={() => {
                  setFile(null);
                  setPreview(null);
                  if (input.current) input.current.value = '';
                }}
              >
                <X size={16} />
              </button>
            </span>
          )}
        </div>
        <div className="space-y-1 font-ui text-sm">
          <label className="flex min-h-tap items-center gap-2">
            <input type="checkbox" checked={opts.allowNew} onChange={tick('allowNew')} className="h-5 w-5 rounded border-line text-primary" />
            Add rows with new asset tags as new assets (in store)
          </label>
          <label className="flex min-h-tap items-center gap-2">
            <input type="checkbox" checked={opts.overwrite} onChange={tick('overwrite')} className="h-5 w-5 rounded border-line text-primary" />
            Overwrite assets changed in ATOM after this file was exported
          </label>
          <label className="flex min-h-tap items-center gap-2">
            <input type="checkbox" checked={opts.skipErrors} onChange={tick('skipErrors')} className="h-5 w-5 rounded border-line text-primary" />
            Skip rows with errors
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" disabled={!file || busy} onClick={() => run(false)}>
            {busy === 'preview' && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Preview
          </button>
          {p && (
            <button type="button" className="btn-primary" disabled={busy || blocked} onClick={() => run(true)}>
              {busy === 'commit' ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <FileUp size={18} aria-hidden="true" />} Import
            </button>
          )}
        </div>
      </div>

      {p && (
        <div className="space-y-3">
          <Alert tone={blocked ? 'error' : 'info'}>
            Preview — nothing saved yet. {p.rows} rows · {p.updated} to update · {p.created} to add · {p.unchanged} unchanged
            {p.newPlaces > 0 && ` · ${p.newPlaces} new places`}
            {p.clears > 0 && ` · ${p.clears} fields will be emptied`}
            {p.exportedAt && ` · file exported ${formatDateTime(p.exportedAt)}`}
            {blocked && '. Fix the rows with errors, or tick “Skip rows with errors”.'}
          </Alert>
          {p.errors.length > 0 && (
            <details className="card p-0 font-ui text-sm" open>
              <summary className="cursor-pointer px-4 py-3 font-medium text-error">Rows with errors ({p.errors.length})</summary>
              <ul className="max-h-72 divide-y divide-line overflow-y-auto border-t border-line">
                {p.errors.map((e) => (
                  <li key={e.row} className="px-4 py-1.5 text-ink-2">
                    Row {e.row}
                    {e.tag && ` · ${e.tag}`}: {e.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {p.changedSinceExport.length > 0 && (
            <details className="card p-0 font-ui text-sm">
              <summary className="cursor-pointer px-4 py-3 font-medium text-warning">
                Changed in ATOM after the export — {opts.overwrite ? 'will be overwritten' : 'skipped'} ({p.changedSinceExport.length})
              </summary>
              <p className="border-t border-line px-4 py-2 text-ink-2">{p.changedSinceExport.map((x) => x.tag).join(', ')}</p>
            </details>
          )}
          {p.newTags.length > 0 && (
            <details className="card p-0 font-ui text-sm">
              <summary className="cursor-pointer px-4 py-3 font-medium text-ink">New assets ({p.newTags.length})</summary>
              <p className="border-t border-line px-4 py-2 text-ink-2">{p.newTags.join(', ')}</p>
            </details>
          )}
          {p.newSkipped.length > 0 && (
            <p className="font-ui text-sm text-ink-2">New tags not added (the tick is off): {p.newSkipped.join(', ')}</p>
          )}
          {p.changes.length > 0 && (
            <details className="card p-0 font-ui text-sm" open={p.changes.length <= 20}>
              <summary className="cursor-pointer px-4 py-3 font-medium text-ink">Changes ({p.updated})</summary>
              <ul className="max-h-96 divide-y divide-line overflow-y-auto border-t border-line">
                {p.changes.map((c) => (
                  <li key={c.tag} className="px-4 py-2">
                    <span className="font-medium tabular-nums text-ink">{c.tag}</span>
                    <ul className="mt-0.5 text-ink-2">
                      {c.fields.map((f) => (
                        <li key={f.field}>
                          {f.field}: {'from' in f ? <>{show(f.from)} → </> : null}
                          <span className={f.to == null || f.to === '' ? 'text-error' : 'text-ink'}>{show(f.to)}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
