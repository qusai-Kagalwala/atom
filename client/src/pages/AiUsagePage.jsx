import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EyeOff, LoaderCircle, Plus, TriangleAlert } from 'lucide-react';
import { dismissQuestion, getAiSettings, getAiUsage, updateAiSettings } from '../api/assistant';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import useAuth from '../hooks/useAuth';
import { formatDateTime } from '../utils/format';

const num = (n) => Number(n || 0).toLocaleString('en-IN');
const usd = (n) => `$${Number(n || 0).toFixed(Number(n) < 1 ? 4 : 2)}`;
const MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano'];

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
  const { user } = useAuth();
  const canAddFaq = user.company?.code === 'AVIT'; // FAQs are AVIT's for now
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
        {!canAddFaq && ' Open AVIT (switch company) to add FAQs from here.'}
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
                {canAddFaq && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => navigate('/faqs/new', { state: { fromQuestion: x } })}
                  >
                    <Plus size={16} aria-hidden="true" /> Add as FAQ
                  </button>
                )}
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

function AiUsage() {
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


// Super Admin (global, all companies): the GPT switch, model, token limits and spend, chat results,
// and questions the FAQs couldn't answer. Moved out of "FAQs" on 28 Oct 2026.
export default function AiUsagePage() {
  return (
    <section className="space-y-4">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Super Admin</p>
        <h1 className="mt-1 text-3xl">AI &amp; usage</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">Whether the assistant may use GPT, how much, what it cost, and what people asked.</p>
      </div>
      <AiUsage />
    </section>
  );
}
