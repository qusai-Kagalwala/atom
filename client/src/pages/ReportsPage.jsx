import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Eye, ExternalLink, FileDown, LoaderCircle, Search } from 'lucide-react';
import { fetchReport } from '../api/reports';
import { listCategories, listEngineers } from '../api/requests';
import { listAssetCategories, searchInventoryPeople } from '../api/inventory';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import PeriodPicker from '../components/PeriodPicker';
import StaffOptions from '../components/StaffOptions';
import useAuth from '../hooks/useAuth';
import { initialPeriod, todayLocal } from '../utils/period';

// Company Admin (Phase 15): choose a report and its filters, PREVIEW the PDF here, then download the
// same file. Built on the server (pdfmake) for the active company.
const REPORTS = [
  ['tickets', 'Tickets raised', 'Every ticket raised in the period, with category, department, staff and status.'],
  ['performance', 'Performance', 'Success rate, response and resolution times, time frames, categories and departments.'],
  ['workload', 'Staff workload', 'Open, assigned and done per staff member, with average resolution and on-time %.'],
  ['assets', 'Asset list', 'This company’s assets with status, place and holder.'],
  ['person', 'Assets held by one person', 'What one person holds from this company — with a signature line for handover.'],
  ['invoices', 'Invoices with linked tickets', 'Invoices in the period and the tickets / requests they belong to.'],
  ['monthly', 'Monthly summary', 'One page: the month’s numbers, top categories and departments, staff workload.'],
];
const PERIOD_REPORTS = new Set(['tickets', 'performance', 'workload', 'invoices']);
const selectClass =
  'min-h-tap w-full rounded-btn border border-line bg-surface px-3 font-ui text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-primary-muted';

function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function PersonPick({ value, onChange }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const people = useQuery({ queryKey: ['onboarding', 'people', term], queryFn: () => searchInventoryPeople(term), enabled: term.length >= 2 });
  if (value) {
    return (
      <p className="flex flex-wrap items-center gap-2 font-ui text-sm">
        <span className="font-medium text-ink">{value.name}</span>
        <button type="button" className="min-h-tap text-brand hover:underline" onClick={() => onChange(null)}>
          Change
        </button>
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <label className="relative block">
        <span className="sr-only">Find a person</span>
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, ITS number or Employee ID" className={`${selectClass} pl-9`} />
      </label>
      {people.data?.length > 0 && (
        <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-btn border border-line bg-surface font-ui text-sm">
          {people.data.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onChange(p)} className="flex min-h-tap w-full items-center justify-between gap-2 px-3 text-left hover:bg-gold-muted">
                <span className="truncate">{p.name}</span>
                <span className="shrink-0 text-xs text-ink-3">{p.held} held</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ReportsPage() {
  const { user } = useAuth();
  const [type, setType] = useState('performance');
  const [period, setPeriod] = useState(() => initialPeriod('30d'));
  const [month, setMonth] = useState(() => todayLocal().slice(0, 7));
  const [f, setF] = useState({ status: '', categoryId: '', engineerId: '', assetStatus: '', assetCategoryId: '' });
  const [person, setPerson] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pdf, setPdf] = useState(null); // { url, filename, label }
  const previewRef = useRef(null);

  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories, staleTime: 10 * 60_000, enabled: type === 'tickets' });
  const staff = useQuery({ queryKey: ['requests', 'engineers'], queryFn: listEngineers, staleTime: 60_000, enabled: type === 'tickets' });
  const assetCats = useQuery({ queryKey: ['inventory', 'categories'], queryFn: listAssetCategories, staleTime: 5 * 60_000, enabled: type === 'assets' });

  // Free the old preview when a new one comes or the page closes.
  useEffect(() => () => pdf && URL.revokeObjectURL(pdf.url), [pdf]);

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const label = REPORTS.find(([k]) => k === type)[1];

  function params() {
    const p = {};
    if (PERIOD_REPORTS.has(type)) Object.assign(p, { from: period.from, to: period.to });
    if (type === 'monthly') p.month = month;
    if (type === 'tickets') {
      if (f.status) p.status = f.status;
      if (f.categoryId) p.categoryId = f.categoryId;
      if (f.engineerId) p.engineerId = f.engineerId;
    }
    if (type === 'assets') {
      if (f.assetStatus) p.assetStatus = f.assetStatus;
      if (f.assetCategoryId) p.assetCategoryId = f.assetCategoryId;
    }
    if (type === 'person') p.personId = person?.id;
    return p;
  }

  async function preview() {
    setBusy(true);
    setError('');
    try {
      const { blob, filename } = await fetchReport(type, params());
      setPdf({ url: URL.createObjectURL(blob), filename, label });
      setTimeout(() => previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    } catch (err) {
      setError(errorMessage(err, 'Could not make the report.'));
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const a = document.createElement('a');
    a.href = pdf.url;
    a.download = pdf.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <section className="space-y-5">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">{user.company?.name} · Admin</p>
        <h1 className="mt-1 flex items-center gap-2 text-3xl">
          <FileDown size={26} className="text-brand" aria-hidden="true" /> Reports (PDF)
        </h1>
        <p className="mt-1 font-ui text-sm text-ink-2">Choose a report, see it here first, then download it.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
        <ul className="space-y-2" role="radiogroup" aria-label="Report">
          {REPORTS.map(([k, name, text]) => (
            <li key={k}>
              <button
                type="button"
                role="radio"
                aria-checked={type === k}
                onClick={() => {
                  setType(k);
                  setError('');
                }}
                className={`w-full rounded-card border px-4 py-3 text-left font-ui transition-colors ${
                  type === k ? 'border-brand bg-primary-tint' : 'border-line bg-surface hover:border-gold'
                }`}
              >
                <span className={`block text-sm font-medium ${type === k ? 'text-brand' : 'text-ink'}`}>{name}</span>
                <span className="mt-0.5 block text-xs text-ink-2">{text}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="card h-fit space-y-4">
          <h2 className="text-xl">{label}</h2>
          {PERIOD_REPORTS.has(type) && (
            <div>
              <p className="mb-1 font-ui text-sm font-medium text-ink">Period</p>
              <PeriodPicker value={period} onChange={setPeriod} />
            </div>
          )}
          {type === 'monthly' && (
            <label className="block max-w-xs font-ui text-sm font-medium text-ink">
              Month
              <input type="month" className={`${selectClass} mt-1`} value={month} max={todayLocal().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} />
            </label>
          )}
          {type === 'tickets' && (
            <div className="grid gap-3 sm:grid-cols-3">
              <select aria-label="Status" className={selectClass} value={f.status} onChange={set('status')}>
                <option value="">All statuses</option>
                <option value="open">Still open</option>
                <option value="closed">Done or rejected</option>
              </select>
              <select aria-label="Category" className={selectClass} value={f.categoryId} onChange={set('categoryId')}>
                <option value="">All categories</option>
                {(categories.data || []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select aria-label="Staff member" className={selectClass} value={f.engineerId} onChange={set('engineerId')}>
                <option value="">All staff</option>
                <StaffOptions staff={staff.data || []} showOpen={false} />
              </select>
            </div>
          )}
          {type === 'assets' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <select aria-label="Asset status" className={selectClass} value={f.assetStatus} onChange={set('assetStatus')}>
                <option value="">Not retired</option>
                <option value="IN_USE">In use</option>
                <option value="IN_STORE">In store</option>
                <option value="IN_REPAIR">In repair</option>
                <option value="RETIRED">Retired</option>
                <option value="all">All</option>
              </select>
              <select aria-label="Asset category" className={selectClass} value={f.assetCategoryId} onChange={set('assetCategoryId')}>
                <option value="">All categories</option>
                {(assetCats.data || []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {type === 'person' && <PersonPick value={person} onChange={setPerson} />}

          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            <button type="button" className="btn-primary" onClick={preview} disabled={busy || (type === 'person' && !person)}>
              {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />} Preview
            </button>
            {pdf && (
              <button type="button" className="btn-secondary" onClick={download}>
                <Download size={18} aria-hidden="true" /> Download
              </button>
            )}
          </div>
        </div>
      </div>

      {pdf && (
        <div ref={previewRef} className="card space-y-3 p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <h2 className="text-xl">Preview · {pdf.label}</h2>
            <div className="flex flex-wrap gap-2">
              <a href={pdf.url} target="_blank" rel="noreferrer" className="btn-secondary">
                <ExternalLink size={16} aria-hidden="true" /> Open full screen
              </a>
              <button type="button" className="btn-primary" onClick={download}>
                <Download size={16} aria-hidden="true" /> Download
              </button>
            </div>
          </div>
          {/* Desktop browsers show the PDF here; most phones can't, so they get "Open full screen". */}
          <iframe title={`Preview of ${pdf.label}`} src={pdf.url} className="hidden h-[75vh] w-full rounded-b-card sm:block" />
          <p className="px-4 pb-4 font-ui text-sm text-ink-2 sm:hidden">
            On a phone, tap <strong>Open full screen</strong> to see the report, or Download it.
          </p>
        </div>
      )}
    </section>
  );
}
