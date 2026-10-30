import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bot, ChevronLeft, CircleCheck, Languages, LoaderCircle, RotateCcw, Send, ShieldAlert, ShoppingCart, Ticket } from 'lucide-react';
import { askChat, chatDraft, chatFeedback, chatToRequest, getAssistantConfig, showFaq, showProblem, startChat } from '../api/assistant';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import { makeT } from '../utils/assistantText';

const LANG_KEY = 'atom.assistant.lang';
const readLang = () => {
  try {
    return localStorage.getItem(LANG_KEY) || '';
  } catch {
    return '';
  }
};
const saveLang = (v) => {
  try {
    localStorage.setItem(LANG_KEY, v);
  } catch {
    /* private mode */
  }
};
const DIRS = { ar: 'rtl' };
const textClass = (lang) => (lang === 'ar' ? 'arabic text-lg leading-relaxed' : 'font-ui text-sm');

let nextId = 1;
const msg = (m) => ({ id: nextId++, ...m });
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function Bubble({ from, children, lang }) {
  const mine = from === 'user';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      {!mine && (
        <span className="mr-2 mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-white" aria-hidden="true">
          <Bot size={16} />
        </span>
      )}
      <div
        dir={DIRS[lang] || 'ltr'}
        lang={lang}
        className={`max-w-[85%] rounded-card px-4 py-3 ${textClass(lang)} ${mine ? 'bg-primary text-white' : 'border border-line bg-white text-ink'}`}
      >
        {children}
      </div>
    </div>
  );
}

// Category → item → problem buttons (the company's problem list, step C). No AI involved.
// An entry has an FAQ (id) or only a problem (problemId → ticket).
function Browse({ tree, lang, t, onPick }) {
  const [cat, setCat] = useState(null);
  const [item, setItem] = useState(null);
  const btn = 'min-h-tap rounded-btn border border-line bg-white px-3 py-2 text-start font-ui text-sm text-ink hover:border-gold hover:bg-gold-muted';
  const back = (fn) => (
    <button type="button" onClick={fn} className="inline-flex min-h-tap items-center gap-1 font-ui text-sm text-primary hover:underline">
      <ChevronLeft size={16} aria-hidden="true" className="rtl:rotate-180" /> {t('back')}
    </button>
  );
  if (!cat) {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        {tree.map((c) => (
          <button key={c.category} type="button" className={btn} onClick={() => setCat(c)}>
            {c.category}
          </button>
        ))}
      </div>
    );
  }
  if (!item) {
    return (
      <div className="space-y-2">
        {back(() => setCat(null))}
        <div className="grid gap-2 sm:grid-cols-2">
          {cat.items.map((i) => (
            <button key={i.item} type="button" className={btn} onClick={() => setItem(i)}>
              {i.item}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {back(() => setItem(null))}
      <div className="grid gap-2">
        {item.faqs.map((f) => (
          <button key={f.id || `p${f.problemId}`} type="button" className={btn} onClick={() => onPick(f)} dir={DIRS[lang] || 'ltr'}>
            <span className="block font-medium">{f.subItem}</span>
            {f.questions?.[lang] && <span className={`block text-ink-2 ${lang === 'ar' ? 'arabic' : ''}`}>{f.questions[lang]}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function FaqAnswer({ faq, t }) {
  const [more, setMore] = useState(false);
  return (
    <div className="space-y-2">
      <p className="font-medium">{faq.question}</p>
      {faq.steps.length > 0 && (
        <>
          <p className="text-ink-2">{t('try_steps_heading')}</p>
          <ol className="list-decimal space-y-1 ps-5">
            {faq.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </>
      )}
      {faq.details.length > 0 && (
        <div>
          <button type="button" onClick={() => setMore((v) => !v)} className="font-ui text-sm text-primary hover:underline" aria-expanded={more}>
            {t('more_steps')}
          </button>
          {more && (
            <ol dir="ltr" lang="en" className="mt-1 list-decimal space-y-1 ps-5 text-start font-ui text-sm text-ink-2">
              {faq.details.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          )}
        </div>
      )}
      {faq.directTicket && faq.raiseTicket && <p className="text-ink-2">{faq.raiseTicket}</p>}
    </div>
  );
}

// Everyone: the AI assistant. Buttons and local search first; GPT only as the last resort (server decides).
export default function AssistantPage() {
  const navigate = useNavigate();
  const config = useQuery({ queryKey: ['assistant', 'config'], queryFn: getAssistantConfig, staleTime: 5 * 60_000 });
  const [lang, setLang] = useState(readLang);
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const endRef = useRef(null);

  const languages = config.data?.languages || [];
  const known = languages.some((l) => l.code === lang);
  const companyName = config.data?.company?.name || null;
  const requestMode = config.data?.mode === 'request'; // Tanzeem: request first, ticket for replacements
  const t = makeT(config.data?.uiText, known ? lang : 'en', companyName);
  const guidelines = config.data?.guidelines?.[lang] || config.data?.guidelines?.en || [];

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  const push = (...m) => setMessages((list) => [...list, ...m.map(msg)]);
  // Last message's buttons are the only live ones.
  const resolveLast = () => setMessages((list) => list.map((m, i) => (i === list.length - 1 ? { ...m, done: true } : m)));

  async function ensureSession() {
    if (session) return session;
    const s = await startChat(lang);
    setSession(s);
    return s;
  }

  async function run(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      if (err?.response?.data?.code === 'session_ended') setEnded(true);
      setError(errorMessage(err, 'Something went wrong. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  function pickLanguage(code) {
    saveLang(code);
    setLang(code);
    setSession(null);
    setMessages([]);
    setEnded(false);
    setBrowsing(false);
    setError('');
  }

  function startOver() {
    setSession(null);
    setMessages([]);
    setEnded(false);
    setBrowsing(false);
    setError('');
  }

  const showAnswer = (faq) => push({ from: 'bot', kind: 'answer', faq, lang: faq.language });

  async function send(e) {
    e.preventDefault();
    const q = text.trim();
    if (!q || busy || ended) return;
    setText('');
    setBrowsing(false);
    resolveLast();
    push({ from: 'user', text: q, lang });
    await run(async () => {
      const s = await ensureSession();
      const r = await askChat(s.id, q);
      if (r.type === 'answer') showAnswer(r.faq);
      else if (r.type === 'problem') push({ from: 'bot', kind: 'problem', problem: r.problem, lang });
      else if (r.type === 'catalogue') push({ from: 'bot', kind: 'catalogue', items: r.items, lang });
      else if (r.type === 'choices') push({ from: 'bot', kind: 'choices', faqs: r.faqs, lang });
      else push({ from: 'bot', kind: 'none', lang });
    });
  }

  // An FAQ, a problem of the list (→ its FAQ, or a ticket) or a catalogue item (→ Request page).
  async function pick(entry, via) {
    if (entry.kind === 'catalogue') {
      await requestItems([entry.catalogueItemId]);
      return;
    }
    resolveLast();
    setBrowsing(false);
    await run(async () => {
      const s = await ensureSession();
      if (entry.id) {
        showAnswer(await showFaq(s.id, entry.id, via));
        return;
      }
      const r = await showProblem(s.id, entry.problemId, via);
      if (r.faq) showAnswer(r.faq);
      else push({ from: 'bot', kind: 'problem', problem: r.problem, lang });
    });
  }

  // Tanzeem: to the Request page, with the chosen catalogue items already added.
  async function requestItems(ids = []) {
    resolveLast();
    await run(async () => {
      if (session && !ended) await chatToRequest(session.id, ids);
      navigate('/request', { state: { add: ids } });
    });
  }

  async function answer(solved) {
    const lastFaq = [...messages].reverse().find((m) => m.kind === 'answer')?.faq;
    resolveLast();
    push({ from: 'user', text: solved ? t('yes') : t('no'), lang });
    await run(async () => {
      const r = await chatFeedback(session.id, solved);
      if (solved) {
        setEnded(true);
        push({ from: 'bot', kind: 'solved', lang });
      } else {
        push({ from: 'bot', kind: 'ticket', draft: r.draft, note: lastFaq?.raiseTicket, lang: lastFaq?.language || lang });
      }
    });
  }

  async function raiseTicket(draft) {
    if (!draft && !session) {
      navigate('/tickets/new');
      return;
    }
    await run(async () => {
      const s = await ensureSession();
      const d = draft || (await chatDraft(s.id));
      navigate('/tickets/new', { state: { draft: d } });
    });
  }

  function renderBot(m) {
    const live = !m.done && !ended && !busy;
    switch (m.kind) {
      case 'answer':
        return (
          <>
            <FaqAnswer faq={m.faq} t={t} />
            {!m.done && !ended && (
              <div className="mt-3 flex flex-wrap gap-2">
                {m.faq.directTicket ? (
                  <button type="button" className="btn-primary" onClick={() => raiseTicket()} disabled={busy}>
                    <Ticket size={18} aria-hidden="true" /> {t('raise_ticket_button')}
                  </button>
                ) : (
                  <>
                    <p className="w-full font-medium">{t('solved_prompt')}</p>
                    <button type="button" className="btn-primary" onClick={() => answer(true)} disabled={!live}>
                      {t('yes')}
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => answer(false)} disabled={!live}>
                      {t('no')}
                    </button>
                  </>
                )}
              </div>
            )}
          </>
        );
      case 'problem':
        return (
          <div className="space-y-3">
            <p className="font-medium" dir="ltr">
              {m.problem.category} › {m.problem.item} › {m.problem.problem}
            </p>
            <p>{t('no_guide')}</p>
            <button type="button" className="btn-primary" onClick={() => raiseTicket()} disabled={busy || m.done || ended}>
              <Ticket size={18} aria-hidden="true" /> {t('raise_ticket_button')}
            </button>
          </div>
        );
      case 'catalogue':
        return (
          <div className="space-y-2">
            <p>{t('catalogue_found')}</p>
            <ul className="grid gap-2">
              {m.items.map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-2 rounded-btn border border-line bg-white px-3 py-2">
                  <span className="min-w-0 font-ui text-sm" dir="ltr">
                    <span className="block text-ink">{x.name}</span>
                    <span className="block text-xs text-ink-3">
                      {x.group}
                      {x.price != null && ` · approx. ${rupees(x.price)} each`}
                    </span>
                  </span>
                  <button type="button" className="btn-secondary shrink-0" disabled={!live} onClick={() => requestItems([x.id])}>
                    <ShoppingCart size={16} aria-hidden="true" /> {t('request_button')}
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              disabled={!live}
              onClick={() => {
                resolveLast();
                push({ from: 'bot', kind: 'none', lang });
              }}
              className="min-h-tap rounded-btn px-3 text-start font-ui text-sm text-primary hover:underline disabled:opacity-60"
            >
              {t('none_of_these')}
            </button>
          </div>
        );
      case 'choices':
        return (
          <div className="space-y-2">
            <p>{t('did_you_mean')}</p>
            <div className="grid gap-2">
              {m.faqs.map((f) => (
                <button
                  key={f.id || `${f.kind}${f.problemId || f.catalogueItemId}`}
                  type="button"
                  disabled={!live}
                  onClick={() => pick(f, 'choice')}
                  className="min-h-tap rounded-btn border border-line bg-white px-3 py-2 text-start hover:border-gold hover:bg-gold-muted disabled:opacity-60"
                >
                  <span className="block">{f.question}</span>
                  <span className="block font-ui text-xs text-ink-3" dir="ltr">
                    {f.item} · {f.subItem}
                  </span>
                </button>
              ))}
              <button
                type="button"
                disabled={!live}
                onClick={() => {
                  resolveLast();
                  push({ from: 'bot', kind: 'none', lang });
                }}
                className="min-h-tap rounded-btn px-3 text-start font-ui text-sm text-primary hover:underline disabled:opacity-60"
              >
                {t('none_of_these')}
              </button>
            </div>
          </div>
        );
      case 'none':
      case 'ticket':
        // Tanzeem: most things are requested; a ticket only when something is broken / needs replacing.
        if (requestMode) {
          return (
            <div className="space-y-3">
              <p>{t('request_hint')}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-primary" onClick={() => requestItems([])} disabled={busy || m.done || ended}>
                  <ShoppingCart size={18} aria-hidden="true" /> {t('request_something')}
                </button>
                <button type="button" className="btn-secondary" onClick={() => raiseTicket(m.draft)} disabled={busy || m.done}>
                  <Ticket size={18} aria-hidden="true" /> {t('replace_button')}
                </button>
              </div>
            </div>
          );
        }
        return (
          <div className="space-y-3">
            {(m.kind === 'none' || m.note) && <p>{m.kind === 'none' ? t('no_match') : m.note}</p>}
            <button type="button" className="btn-primary" onClick={() => raiseTicket(m.draft)} disabled={busy || m.done}>
              <Ticket size={18} aria-hidden="true" /> {t('raise_ticket_button')}
            </button>
          </div>
        );
      case 'solved':
        return (
          <p className="flex items-center gap-2">
            <CircleCheck size={18} className="shrink-0 text-success" aria-hidden="true" /> {t('glad_solved')}
          </p>
        );
      default:
        return null;
    }
  }

  if (config.isPending) {
    return (
      <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
        <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading…
      </p>
    );
  }
  if (config.isError) return <Alert tone="error">Could not load the assistant.</Alert>;

  // Step 1: language
  if (!known) {
    return (
      <section className="mx-auto max-w-xl space-y-4">
        <h1 className="text-3xl">AI assistant{companyName ? ` · ${companyName}` : ''}</h1>
        <div className="card space-y-3">
          <p className="flex items-center gap-2 font-ui font-medium">
            <Languages size={18} aria-hidden="true" /> {languages.map((l) => makeT(config.data.uiText, l.code)('choose_language')).filter((v, i, a) => a.indexOf(v) === i).join(' · ')}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {languages.map((l) => (
              <button key={l.code} type="button" onClick={() => pickLanguage(l.code)} className="btn-secondary" lang={l.code}>
                <span className={l.code === 'ar' ? 'arabic text-lg' : ''}>{l.nativeName}</span>
              </button>
            ))}
          </div>
        </div>
        <Link to="/tickets/new" className="inline-block font-ui text-sm text-primary hover:underline">
          Skip — raise a ticket directly
        </Link>
      </section>
    );
  }

  const last = messages[messages.length - 1];
  const rtl = DIRS[lang] === 'rtl';
  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl">AI assistant</h1>
          <p className="mt-1 font-ui text-sm text-ink-2">
            {requestMode
              ? `Find what you need from ${companyName}. Something broken? Raise a ticket from here.`
              : `Answers from the ${companyName || 'AVIT'} help guide. Not solved? Raise a ticket from here.`}
          </p>
        </div>
        <label className="flex items-center gap-2 font-ui text-sm text-ink-2">
          <Languages size={16} aria-hidden="true" />
          <span className="sr-only">{t('language')}</span>
          <select
            value={lang}
            onChange={(e) => pickLanguage(e.target.value)}
            className="min-h-tap rounded-btn border border-line bg-white px-2 font-ui text-sm text-ink"
          >
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.nativeName}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-3" aria-live="polite">
        <Bubble from="bot" lang={lang}>
          <p>{t('greeting')}</p>
          {guidelines.length > 0 && (
            <details className="mt-2">
              <summary className="flex cursor-pointer items-center gap-1 font-ui text-sm text-gold-dark">
                <ShieldAlert size={14} aria-hidden="true" /> {t('safety')}
              </summary>
              <ul className="mt-1 list-disc space-y-1 ps-5 text-ink-2">
                {guidelines.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </details>
          )}
        </Bubble>

        {messages.map((m) => (
          <Bubble key={m.id} from={m.from} lang={m.lang}>
            {m.from === 'user' ? m.text : renderBot(m)}
          </Bubble>
        ))}

        {browsing && !ended && (
          <Bubble from="bot" lang={lang}>
            <Browse tree={config.data.tree} lang={lang} t={t} onPick={(entry) => pick(entry, 'browse')} />
          </Bubble>
        )}

        {busy && (
          <p className="flex items-center gap-2 ps-10 font-ui text-sm text-ink-3">
            <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> {t('thinking')}
          </p>
        )}
        <div ref={endRef} />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {ended ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={startOver}>
            <RotateCcw size={18} aria-hidden="true" /> {t('start_over')}
          </button>
          <Link to="/track" className="btn-secondary">
            My tickets &amp; requests
          </Link>
        </div>
      ) : (
        <div className="sticky bottom-0 space-y-2 border-t border-line bg-cream pb-2 pt-3">
          <form onSubmit={send} className="flex gap-2" dir={rtl ? 'rtl' : 'ltr'}>
            <label htmlFor="chat-text" className="sr-only">
              {t('placeholder')}
            </label>
            <input
              id="chat-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={500}
              autoComplete="off"
              placeholder={t('placeholder')}
              lang={lang}
              className={`block min-h-tap w-full rounded-btn border border-line bg-white px-3 text-ink placeholder:text-ink-3 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted ${textClass(lang)}`}
            />
            <button type="submit" className="btn-primary shrink-0" disabled={busy || !text.trim()} aria-label={t('send')}>
              <Send size={18} aria-hidden="true" className="rtl:-scale-x-100" />
            </button>
          </form>
          <div className="flex flex-wrap items-center justify-between gap-2 font-ui text-sm">
            {config.data.tree.length > 0 ? (
              <button type="button" className="min-h-tap text-primary hover:underline" onClick={() => setBrowsing((v) => !v)} disabled={busy} aria-expanded={browsing}>
                {t('browse')}
              </button>
            ) : requestMode ? (
              <button type="button" className="min-h-tap text-primary hover:underline" onClick={() => requestItems([])} disabled={busy}>
                {t('request_something')}
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-3">
              {messages.length > 0 && (
                <button type="button" className="min-h-tap text-ink-2 hover:underline" onClick={startOver} disabled={busy}>
                  {t('start_over')}
                </button>
              )}
              <button type="button" className="min-h-tap text-ink-2 hover:underline" onClick={() => raiseTicket()} disabled={busy || last?.kind === 'solved'}>
                {t('skip')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
