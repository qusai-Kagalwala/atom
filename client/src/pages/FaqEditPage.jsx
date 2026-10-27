import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, LoaderCircle, Save } from 'lucide-react';
import { createFaq, getFaq, updateFaq } from '../api/assistant';
import { listCategories } from '../api/requests';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';

const LANGS = [
  ['en', 'English'],
  ['ar', 'العربية'],
  ['hi', 'हिन्दी'],
  ['gu', 'ગુજરાતી'],
];
const areaClass =
  'block w-full rounded-btn border border-line bg-white px-3 py-2 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';
const selectClass =
  'min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';
const lines = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);

// from: a "Question with no FAQ" (Add as FAQ) — its text becomes the question (in the language it
// was asked) and a keyword, so the same question matches this FAQ from now on.
function toForm(faq, from) {
  const answers = {};
  for (const [code] of LANGS) {
    const a = faq?.answers?.[code] || {};
    answers[code] = { question: a.question || '', steps: (a.steps || []).join('\n'), raise_ticket: a.raise_ticket || '' };
  }
  if (!faq && from?.text) {
    const lang = answers[from.language] ? from.language : 'en';
    answers[lang].question = from.text;
    return {
      category: '', item: '', subItem: '',
      ticketCategoryId: from.suggestion?.categoryId || '',
      directTicket: false, isActive: true,
      keywords: from.text.toLowerCase().replace(/,/g, ' '),
      detailsEn: '', ticketInfo: '', answers,
    };
  }
  return {
    category: faq?.category || '',
    item: faq?.item || '',
    subItem: faq?.subItem || '',
    ticketCategoryId: faq?.ticketCategory?.id || '',
    directTicket: faq?.directTicket || false,
    isActive: faq?.isActive ?? true,
    keywords: (faq?.keywords || []).join(', '),
    detailsEn: (faq?.detailsEn || []).join('\n'),
    ticketInfo: (faq?.ticketInfo || []).join('\n'),
    answers,
  };
}

function Editor({ faq, from }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories, staleTime: 10 * 60_000 });
  const [f, setF] = useState(() => toForm(faq, from));
  const [lang, setLang] = useState(from?.language && from.language !== 'en' ? from.language : 'en');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const setA = (k) => (e) => setF((x) => ({ ...x, answers: { ...x.answers, [lang]: { ...x.answers[lang], [k]: e.target.value } } }));
  const a = f.answers[lang];
  const rtl = lang === 'ar';

  async function save() {
    setBusy(true);
    setError('');
    setSaved(false);
    const answers = {};
    for (const [code] of LANGS) {
      const x = f.answers[code];
      if (x.question.trim()) answers[code] = { question: x.question, steps: lines(x.steps), raise_ticket: x.raise_ticket };
    }
    const body = {
      category: f.category,
      item: f.item,
      subItem: f.subItem,
      ticketCategoryId: f.ticketCategoryId || null,
      directTicket: f.directTicket,
      keywords: f.keywords.split(',').map((k) => k.trim()).filter(Boolean),
      detailsEn: lines(f.detailsEn),
      ticketInfo: lines(f.ticketInfo),
      answers,
      ...(faq ? { isActive: f.isActive } : {}),
    };
    try {
      const out = faq ? await updateFaq(faq.id, body) : await createFaq(body);
      queryClient.invalidateQueries({ queryKey: ['assistant'] });
      if (faq) {
        setSaved(true);
        setBusy(false);
      } else {
        navigate(`/faqs/${out.id}`, { replace: true });
      }
    } catch (err) {
      setError(errorMessage(err, 'Could not save the FAQ.'));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}
      {saved && <Alert tone="success">Saved. The assistant uses it within a minute.</Alert>}
      {faq?.source === 'json' && (
        <p className="font-ui text-xs text-ink-3">
          From the FAQ file (item_id {faq.itemId}). Once edited here, re-imports keep your version unless “Keep changes made in ATOM” is unticked.
        </p>
      )}

      <div className="card grid gap-4 sm:grid-cols-3">
        <Field id="faq-cat" label="Category">
          <TextInput id="faq-cat" value={f.category} onChange={set('category')} maxLength={60} placeholder="Hardware" />
        </Field>
        <Field id="faq-item" label="Item">
          <TextInput id="faq-item" value={f.item} onChange={set('item')} maxLength={80} placeholder="Printer" />
        </Field>
        <Field id="faq-sub" label="Problem (sub-item)">
          <TextInput id="faq-sub" value={f.subItem} onChange={set('subItem')} maxLength={120} placeholder="Paper Jam" />
        </Field>
        <Field id="faq-tcat" label="Ticket category">
          <select id="faq-tcat" className={selectClass} value={f.ticketCategoryId} onChange={set('ticketCategoryId')}>
            <option value="">—</option>
            {(categories.data || []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field id="faq-kw" label="Keywords" hint="Comma separated — words people type, e.g. paper jam, paper stuck">
            <TextInput id="faq-kw" value={f.keywords} onChange={set('keywords')} />
          </Field>
        </div>
        <label className="flex min-h-tap items-center gap-2 font-ui text-sm">
          <input type="checkbox" checked={f.directTicket} onChange={set('directTicket')} className="h-5 w-5 rounded border-line text-primary" />
          Straight to a ticket (no self-help steps)
        </label>
        {faq && (
          <label className="flex min-h-tap items-center gap-2 font-ui text-sm">
            <input type="checkbox" checked={f.isActive} onChange={set('isActive')} className="h-5 w-5 rounded border-line text-primary" />
            Switched on (shown in the assistant)
          </label>
        )}
      </div>

      <div className="card space-y-4">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Language">
          {LANGS.map(([code, label]) => (
            <button
              key={code}
              type="button"
              role="tab"
              aria-selected={lang === code}
              onClick={() => setLang(code)}
              className={`min-h-tap rounded-btn px-3 font-ui text-sm ${lang === code ? 'bg-primary text-white' : 'border border-line bg-white text-ink'}`}
            >
              {label}
              {f.answers[code].question.trim() ? '' : ' (empty)'}
            </button>
          ))}
        </div>
        <div dir={rtl ? 'rtl' : 'ltr'} lang={lang} className="space-y-4">
          <Field id="faq-q" label={lang === 'en' ? 'Question (required)' : 'Question (leave empty to fall back to English)'}>
            <TextInput id="faq-q" value={a.question} onChange={setA('question')} maxLength={600} />
          </Field>
          <Field id="faq-steps" label="Steps" hint="One step per line">
            <textarea id="faq-steps" rows={5} value={a.steps} onChange={setA('steps')} className={areaClass} />
          </Field>
          <Field id="faq-rt" label="When not solved" hint="e.g. It needs repair. Please raise a ticket.">
            <TextInput id="faq-rt" value={a.raise_ticket} onChange={setA('raise_ticket')} maxLength={600} />
          </Field>
        </div>
      </div>

      <div className="card grid gap-4 sm:grid-cols-2">
        <Field id="faq-details" label="More detailed steps (English)" hint="One per line — shown behind “More detailed steps”">
          <textarea id="faq-details" rows={5} value={f.detailsEn} onChange={set('detailsEn')} className={areaClass} />
        </Field>
        <Field id="faq-info" label="Ask for in the ticket" hint="One per line, e.g. Asset tag / serial number">
          <textarea id="faq-info" rows={5} value={f.ticketInfo} onChange={set('ticketInfo')} className={areaClass} />
        </Field>
      </div>

      <div className="flex justify-end gap-2">
        <Link to="/faqs" className="btn-secondary">
          Cancel
        </Link>
        <button type="button" className="btn-primary" onClick={save} disabled={busy}>
          {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Save size={18} aria-hidden="true" />} Save FAQ
        </button>
      </div>
    </div>
  );
}

// Super Admin: add or edit one FAQ (4 languages).
export default function FaqEditPage() {
  const { id } = useParams();
  const isNew = !id;
  const from = useLocation().state?.fromQuestion || null;
  const faq = useQuery({ queryKey: ['assistant', 'faq', id], queryFn: () => getFaq(id), enabled: !isNew });
  return (
    <section className="mx-auto max-w-3xl space-y-4">
      <Link to="/faqs" className="inline-flex items-center gap-1 font-ui text-sm text-primary hover:underline">
        <ArrowLeft size={16} aria-hidden="true" /> FAQs
      </Link>
      <h1 className="text-3xl">{isNew ? 'Add an FAQ' : faq.data ? `${faq.data.item} · ${faq.data.subItem}` : 'FAQ'}</h1>
      {!isNew && faq.isPending && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
      {!isNew && faq.isError && <Alert tone="error">{errorMessage(faq.error, 'Could not load the FAQ.')}</Alert>}
      {isNew && from && (
        <Alert tone="info">
          From a question asked {from.count} {from.count === 1 ? 'time' : 'times'}. Fill in the category, item, problem and the steps
          {from.language !== 'en' ? ', and the English question (required)' : ''}.
        </Alert>
      )}
      {(isNew || faq.data) && <Editor key={faq.data?.id || 'new'} faq={isNew ? null : faq.data} from={isNew ? from : null} />}
    </section>
  );
}
