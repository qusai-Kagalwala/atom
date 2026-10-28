import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EyeOff, FileUp, LoaderCircle, Plus, Search, TriangleAlert } from 'lucide-react';
import { dismissQuestion, getAiSettings, getAiUsage, importFaqs, listFaqs, listLearned, setLearned, updateAiSettings } from '../api/assistant';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import { Tabs } from '../components/RequestList';
import { formatDateTime } from '../utils/format';

const selectClass =
  'min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';
const num = (n) => Number(n || 0).toLocaleString('en-IN');
const usd = (n) => `$${Number(n || 0).toFixed(Number(n) < 1 ? 4 : 2)}`;
const MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano'];

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

// ---------- AI settings & usage ----------
function Meter({ label, used, limit }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  const tone = pct >= 100 ? 'bg-error' : pct >= 80 ? 'bg-warning' : 'bg-primary';
  return (
    <div className="card p-4">
      <p className="font-ui text-xs uppercase tracking-wider text-ink-3">{label}</p>
      <p className="mt-1 font-ui text-sm text-ink">
        <span className="font-display text-2xl text-brown">{num(used)}</span> / {num(limit)} tokens
      </p>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-cream-dark" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SettingsForm({ settings }) {
  const queryClient = useQueryClient();
  const [f, setF] = useState(() => ({ ...settings }));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save(patch) {
    setBusy(true);
    setMsg(null);
    try {
      const s = await updateAiSettings(patch);
      setF({ ...s });
      queryClient.invalidateQueries({ queryKey: ['assistant', 'usage'] });
      setMsg({ tone: 'success', text: 'Saved.' });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not save.') });
    } finally {
      setBusy(false);
    }
  }

  const fields = () => ({
    model: f.model,
    temperature: Number(f.temperature),
    dailyTokenLimit: Number(f.dailyTokenLimit),
    monthlyTokenLimit: Number(f.monthlyTokenLimit),
    userDailyCalls: Number(f.userDailyCalls),
    priceInPerM: Number(f.priceInPerM),
    priceOutPerM: Number(f.priceOutPerM),
  });

  return (
    <div className="card space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl">GPT fallback</h2>
          <p className="font-ui text-sm text-ink-2">
            Used only when the buttons and the FAQ search find nothing. When off (or over a limit), the chat still works and offers a ticket.
          </p>
        </div>
        <label className="flex min-h-tap items-center gap-2 font-ui text-sm font-medium">
          <input
            type="checkbox"
            role="switch"
            checked={f.gptEnabled}
            disabled={busy}
            onChange={(e) => save({ gptEnabled: e.target.checked })}
            className="h-6 w-6 rounded border-line text-primary"
          />
          {f.gptEnabled ? 'GPT is on' : 'GPT is off'}
        </label>
      </div>
      {!settings.keyConfigured && (
        <Alert tone="info">OPENAI_API_KEY is not set in the server .env — GPT is skipped until it is.</Alert>
      )}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="ai-model" label="Model">
          <TextInput id="ai-model" value={f.model} onChange={set('model')} list="ai-models" maxLength={60} />
          <datalist id="ai-models">
            {MODELS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field id="ai-temp" label="Temperature" hint="0 = always the same answer, 1 = more varied. 0.4 recommended.">
          <TextInput id="ai-temp" type="number" min="0" max="1" step="0.05" value={f.temperature} onChange={set('temperature')} />
        </Field>
        <Field id="ai-day" label="Daily token limit (everyone)">
          <TextInput id="ai-day" type="number" min="0" step="1000" value={f.dailyTokenLimit} onChange={set('dailyTokenLimit')} />
        </Field>
        <Field id="ai-month" label="Monthly token limit (everyone)">
          <TextInput id="ai-month" type="number" min="0" step="10000" value={f.monthlyTokenLimit} onChange={set('monthlyTokenLimit')} />
        </Field>
        <Field id="ai-user" label="GPT questions per person per day">
          <TextInput id="ai-user" type="number" min="0" step="1" value={f.userDailyCalls} onChange={set('userDailyCalls')} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field id="ai-pin" label="USD / 1M input">
            <TextInput id="ai-pin" type="number" min="0" step="0.01" value={f.priceInPerM} onChange={set('priceInPerM')} />
          </Field>
          <Field id="ai-pout" label="USD / 1M output">
            <TextInput id="ai-pout" type="number" min="0" step="0.01" value={f.priceOutPerM} onChange={set('priceOutPerM')} />
          </Field>
        </div>
      </div>
      <div className="flex justify-end">
        <button type="button" className="btn-primary" onClick={() => save(fields())} disabled={busy}>
          {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Save settings
        </button>
      </div>
    </div>
  );
}

// Typed questions that found no FAQ (last 90 days), same words grouped, most asked first.
function Unmatched({ list }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function dismiss(key) {
    setBusy(key);
    setError('');
    try {
      await dismissQuestion(key);
      await queryClient.invalidateQueries({ queryKey: ['assistant', 'usage'] });
    } catch (err) {
      setError(errorMessage(err, 'Could not dismiss it.'));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="card space-y-2">
      <h2 className="text-xl">Questions with no FAQ</h2>
      <p className="font-ui text-sm text-ink-2">
        Last 90 days, most asked first. Add an FAQ for the ones that keep coming up; dismiss junk. Once an FAQ answers a question, it leaves this list.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      {list.length === 0 ? (
        <p className="font-ui text-sm text-ink-3">None right now.</p>
      ) : (
        <ul className="divide-y divide-line font-ui text-sm">
          {list.map((x) => (
            <li key={x.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span dir="auto" className={`block ${x.language === 'ar' ? 'arabic text-base' : ''}`}>
                  {x.text}
                </span>
                <span className="block text-xs text-ink-3">
                  Asked {x.count} {x.count === 1 ? 'time' : 'times'} · last {formatDateTime(x.lastAt)}
                  {x.suggestion?.category && ` · GPT suggests ${x.suggestion.category}`}
                </span>
              </span>
              <span className="flex shrink-0 gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => navigate('/faqs/new', { state: { fromQuestion: x } })}
                >
                  <Plus size={16} aria-hidden="true" /> Add as FAQ
                </button>
                <button type="button" className="btn-secondary" onClick={() => dismiss(x.key)} disabled={busy === x.key}>
                  <EyeOff size={16} aria-hidden="true" /> Dismiss
                </button>
              </span>
            </li>
          ))}
        </ul>
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

function AiTab() {
  const usage = useQuery({ queryKey: ['assistant', 'usage'], queryFn: () => getAiUsage(30) });
  const settings = useQuery({ queryKey: ['assistant', 'settings'], queryFn: getAiSettings });
  if (usage.isPending || settings.isPending) return <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />;
  if (usage.isError || settings.isError) return <Alert tone="error">Could not load AI settings.</Alert>;
  const u = usage.data;
  const s = u.sessions;
  const solvedPct = s.total ? Math.round(((s.total - s.ticket - s.leftOpen) / s.total) * 100) : 0;
  const withoutGpt = s.total ? Math.round(((s.total - s.usedGpt) / s.total) * 100) : 0;
  return (
    <div className="space-y-5">
      <SettingsForm key={settings.data.updatedAt} settings={settings.data} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Meter label={`Today · ${usd(u.today.costUsd)} · ${u.today.calls} calls`} used={u.today.tokens} limit={u.settings.dailyTokenLimit} />
        <Meter label={`This month · ${usd(u.month.costUsd)} · ${u.month.calls} calls`} used={u.month.tokens} limit={u.settings.monthlyTokenLimit} />
      </div>

      <div className="card space-y-2">
        <h2 className="text-xl">Chats — last {s.days} days</h2>
        <div className="grid gap-3 font-ui text-sm sm:grid-cols-4">
          <p>
            <span className="block font-display text-2xl text-brown">{s.total}</span> chats
          </p>
          <p>
            <span className="block font-display text-2xl text-brown">{s.solved}</span> solved ({solvedPct}%)
          </p>
          <p>
            <span className="block font-display text-2xl text-brown">{s.ticket}</span> became tickets
          </p>
          <p>
            <span className="block font-display text-2xl text-brown">{withoutGpt}%</span> without GPT
          </p>
        </div>
        <p className="font-ui text-xs text-ink-3">
          Answer found by: buttons {s.via.browse} · “did you mean” {s.via.choice} · search {s.via.search} · saved answers {s.via.learned} · GPT{' '}
          {s.via.gpt} · no FAQ {s.via.none}
        </p>
        <p className="font-ui text-xs text-ink-3">GPT calls saved by reusing earlier answers: {s.savedAnswersUsed}</p>
      </div>

      <Unmatched list={u.unmatched} />

      <div className="card overflow-x-auto p-0">
        <h2 className="border-b border-line px-4 py-3 text-xl">Daily GPT use</h2>
        <table className="w-full font-ui text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-ink-3">
            <tr>
              <th className="px-4 py-2 font-medium">Day</th>
              <th className="px-4 py-2 text-right font-medium">Calls</th>
              <th className="px-4 py-2 text-right font-medium">Tokens</th>
              <th className="px-4 py-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {[...u.daily]
              .reverse()
              .filter((d, i) => i < 7 || d.calls > 0)
              .map((d) => (
                <tr key={d.day}>
                  <td className="px-4 py-2 tabular-nums">{d.day}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{d.calls}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{num(d.tokens)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{usd(d.costUsd)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {u.recentCalls.length > 0 && (
        <div className="card p-0">
          <h2 className="border-b border-line px-4 py-3 text-xl">Latest GPT calls</h2>
          <ul className="divide-y divide-line font-ui text-sm">
            {u.recentCalls.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2">
                <span>
                  {formatDateTime(c.at)} · {c.user} · {c.model}
                </span>
                {c.status === 'ok' ? (
                  <span className="tabular-nums text-ink-2">
                    {num(c.tokens)} tokens · {usd(c.costUsd)}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-error">
                    <TriangleAlert size={14} aria-hidden="true" /> {c.error || 'Failed'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const TABS = [
  ['faqs', 'FAQs'],
  ['import', 'Import'],
  ['saved', 'Saved answers'],
  ['ai', 'AI & usage'],
];

// Super Admin: the FAQ bank the assistant answers from, and the GPT switch / limits / spend.
export default function FaqsPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'faqs';
  return (
    <section className="space-y-4">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Super Admin</p>
        <h1 className="mt-1 text-3xl">FAQs &amp; AI</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">What the AI assistant answers from, and how much GPT it may use.</p>
      </div>
      <Tabs tabs={TABS} value={tab} onChange={(v) => setParams(v === 'faqs' ? {} : { tab: v })} />
      {tab === 'faqs' && <FaqList />}
      {tab === 'import' && <ImportTab />}
      {tab === 'saved' && <SavedAnswers />}
      {tab === 'ai' && <AiTab />}
    </section>
  );
}
