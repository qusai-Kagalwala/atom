import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, LoaderCircle, Plus, Search } from 'lucide-react';
import { importFaqs, listFaqs, listLearned, setLearned } from '../api/assistant';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import useAuth from '../hooks/useAuth';
import { Tabs } from '../components/RequestList';
import { formatDateTime } from '../utils/format';

const selectClass =
  'min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';

// ---------- FAQs ----------
function FaqList() {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [showOff, setShowOff] = useState(false);
  const faqs = useQuery({ queryKey: ['assistant', 'faqs', showOff], queryFn: () => listFaqs(showOff) });
  const categories = useMemo(() => [...new Set((faqs.data || []).map((f) => f.category))], [faqs.data]);
  const needle = q.trim().toLowerCase();
  const items = (faqs.data || []).filter(
    (f) =>
      (!category || f.category === category) &&
      (!needle || `${f.item} ${f.subItem} ${f.question} ${f.itemId}`.toLowerCase().includes(needle))
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-[1fr_14rem_auto]">
        <label className="relative">
          <span className="sr-only">Search FAQs</span>
          <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Item, problem, question or ID"
            className="block min-h-tap w-full rounded-btn border border-line bg-white pl-10 pr-3 font-ui text-sm text-ink placeholder:text-ink-3 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
          />
        </label>
        <select aria-label="Category" className={selectClass} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <Link to="/faqs/new" className="btn-secondary">
          <Plus size={16} aria-hidden="true" /> Add FAQ
        </Link>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 font-ui text-sm text-ink-2">
        <span>{faqs.isSuccess && `${items.length} FAQ${items.length === 1 ? '' : 's'}`}</span>
        <label className="flex min-h-tap items-center gap-2">
          <input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} className="h-5 w-5 rounded border-line text-primary" />
          Show switched-off FAQs
        </label>
      </div>
      {faqs.isPending && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
      {faqs.isError && <Alert tone="error">Could not load the FAQs.</Alert>}
      {faqs.isSuccess && !faqs.data.length && (
        <div className="card text-center font-ui text-sm text-ink-2">No FAQs yet. Import the FAQ JSON file from the Import tab.</div>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-white">
          {items.map((f) => (
            <li key={f.id}>
              <Link to={`/faqs/${f.id}`} className="flex items-start gap-3 px-4 py-3 font-ui hover:bg-gold-muted focus-visible:bg-gold-muted">
                <span className="w-12 shrink-0 text-xs tabular-nums text-ink-3">#{f.itemId}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">
                    {f.item} · {f.subItem}
                  </span>
                  <span className="block truncate text-xs text-ink-2">{f.question}</span>
                  <span className="mt-0.5 block text-xs text-ink-3">
                    {f.category} → ticket: {f.ticketCategory?.name || '—'} · {f.languages.join(', ').toUpperCase()}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  {!f.isActive && <span className="badge bg-cream-dark text-ink-3">Off</span>}
                  {f.directTicket && <span className="badge bg-gold-muted text-gold-dark">Direct ticket</span>}
                  {f.editedInAtom && <span className="badge bg-primary-tint text-primary">Edited</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- Import ----------
function ImportTab() {
  const queryClient = useQueryClient();
  const [file, setFile] = useState(null);
  const [keep, setKeep] = useState(true);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function go(commit) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const r = await importFaqs(file, { commit, keepAtomEdits: keep });
      setReport(r);
      if (commit) queryClient.invalidateQueries({ queryKey: ['assistant'] });
    } catch (err) {
      setError(errorMessage(err, 'Could not read the file.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-4">
      <p className="font-ui text-sm text-ink-2">
        Upload the FAQ JSON (questions, steps and buttons in English, Arabic, Hindi and Gujarati). Re-upload whenever the file changes — FAQs are matched on
        their <code>item_id</code>.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      <input
        type="file"
        accept=".json,application/json"
        onChange={(e) => {
          setFile(e.target.files?.[0] || null);
          setReport(null);
        }}
        className="block w-full font-ui text-sm"
      />
      <label className="flex min-h-tap items-center gap-2 font-ui text-sm">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} className="h-5 w-5 rounded border-line text-primary" />
        Keep changes made in ATOM (FAQs edited or switched off here are not overwritten)
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" onClick={() => go(false)} disabled={!file || busy}>
          {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Preview
        </button>
        {report && !report.committed && (
          <button type="button" className="btn-primary" onClick={() => go(true)} disabled={busy}>
            <FileUp size={18} aria-hidden="true" /> Import
          </button>
        )}
      </div>
      {report && (
        <div className="space-y-2 font-ui text-sm">
          <Alert tone={report.committed ? 'success' : 'info'}>
            {report.committed ? 'Imported. ' : 'Preview only — nothing saved yet. '}
            {report.inFile} in file · new {report.created} · updated {report.updated} · unchanged {report.unchanged}
            {report.keptAtomEdits.length > 0 && ` · kept ATOM changes ${report.keptAtomEdits.length}`}
            {report.errors.length > 0 && ` · errors ${report.errors.length}`} · languages {report.languages.join(', ').toUpperCase()}
          </Alert>
          {report.errors.length > 0 && (
            <ul className="list-disc ps-5 text-error">
              {report.errors.slice(0, 20).map((e) => (
                <li key={e.index}>
                  Entry {e.index + 1} (item_id {String(e.itemId ?? '—')}): {e.message}
                </li>
              ))}
            </ul>
          )}
          {report.notInFile.length > 0 && (
            <p className="text-ink-2">
              In ATOM but not in this file (left as they are): {report.notInFile.map((f) => `#${f.itemId} ${f.item} · ${f.subItem}`).join('; ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// GPT answers saved for reuse. Switch one off when it is wrong: GPT is asked again next time.
function SavedAnswers() {
  const queryClient = useQueryClient();
  const [showOff, setShowOff] = useState(false);
  const [error, setError] = useState('');
  const learned = useQuery({ queryKey: ['assistant', 'learned', showOff], queryFn: () => listLearned(showOff) });

  async function toggle(l) {
    setError('');
    try {
      await setLearned(l.id, !l.isActive);
      await queryClient.invalidateQueries({ queryKey: ['assistant', 'learned'] });
    } catch (err) {
      setError(errorMessage(err, 'Could not change it.'));
    }
  }

  return (
    <div className="space-y-4">
      <p className="font-ui text-sm text-ink-2">
        Questions GPT has already sorted. The same question (same words, any order, small typos allowed) is answered from here — no GPT call, no
        tokens. Switch one off if it points to the wrong FAQ; GPT is asked again the next time.
      </p>
      <label className="flex min-h-tap items-center gap-2 font-ui text-sm text-ink-2">
        <input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} className="h-5 w-5 rounded border-line text-primary" />
        Show switched-off answers
      </label>
      {error && <Alert tone="error">{error}</Alert>}
      {learned.isPending && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
      {learned.isError && <Alert tone="error">Could not load saved answers.</Alert>}
      {learned.isSuccess && !learned.data.length && <div className="card text-center font-ui text-sm text-ink-2">No saved answers yet. They appear after GPT is used.</div>}
      {learned.data?.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-white font-ui text-sm">
          {learned.data.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span dir="auto" className={`block font-medium text-ink ${l.language === 'ar' ? 'arabic text-base' : ''}`}>
                  {l.text}
                </span>
                <span className="block text-xs text-ink-2">
                  →{' '}
                  {l.faqs.length
                    ? l.faqs.map((f) => `${f.item} · ${f.subItem}${f.isActive ? '' : ' (FAQ off)'}`).join(' / ')
                    : `No FAQ — ticket${l.suggestion?.category ? ` (${l.suggestion.category}${l.suggestion.priority === 'HIGH' ? ', high priority' : ''})` : ''}`}
                </span>
                <span className="block text-xs text-ink-3">
                  Reused {l.hits} {l.hits === 1 ? 'time' : 'times'}
                  {l.lastUsedAt && ` · last ${formatDateTime(l.lastUsedAt)}`} · saved {formatDateTime(l.createdAt)}
                </span>
              </span>
              <button type="button" className="btn-secondary shrink-0" onClick={() => toggle(l)}>
                {l.isActive ? 'Switch off' : 'Switch on'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const TABS = [
  ['faqs', 'FAQs'],
  ['import', 'Import'],
  ['saved', 'Saved answers'],
];

// Company Admin: the company's FAQ bank its assistant answers from, and its saved GPT answers (step C).
// GPT switch / limits / spend and unanswered questions are on the Super Admin's "AI & usage" page.
export default function FaqsPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'faqs';
  return (
    <section className="space-y-4">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Admin</p>
        <h1 className="mt-1 text-3xl">FAQs</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">
          What {user.company?.name || 'this company'}’s AI assistant answers from, and the GPT answers it saved for reuse.
          {user.company?.assistantEnabled === false && ' The assistant is switched off for this company (Super Admin).'}
        </p>
      </div>
      <Tabs tabs={TABS} value={tab} onChange={(v) => setParams(v === 'faqs' ? {} : { tab: v })} />
      {tab === 'faqs' && <FaqList />}
      {tab === 'import' && <ImportTab />}
      {tab === 'saved' && <SavedAnswers />}
    </section>
  );
}
