import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, LoaderCircle, Monitor, Palette, RotateCcw, Save, Send, Smartphone } from 'lucide-react';
import { getEmailDesign, listCompanySettings, previewEmailDesign, resetEmailDesign, saveEmailDesign, testEmailDesign } from '../api/settings';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import Modal from '../components/Modal';
import { formatDateTime } from '../utils/format';

const HEX = /^#[0-9a-f]{6}$/i;
const COLOR_FIELDS = [
  ['primary', 'Main colour', 'Header and button'],
  ['accent', 'Accent colour', 'Line under the header, highlights'],
  ['background', 'Background', 'Behind the email card'],
  ['text', 'Text colour', 'Headings and body text'],
];
const STYLE_INFO = {
  classic: ['Classic', 'Coloured header, gold line'],
  minimal: ['Minimal', 'White header, coloured edge'],
  banner: ['Banner', 'Large title inside the header'],
};
const SAMPLES = [
  ['ticket', 'Ticket update'],
  ['request', 'Service request'],
  ['wifi', 'Jamea Internet Access'],
  ['reset', 'Password reset'],
];

function Section({ title, hint, children }) {
  return (
    <section className="card space-y-4">
      <div>
        <h2 className="text-lg">{title}</h2>
        {hint && <p className="mt-0.5 font-ui text-sm text-ink-3">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex min-h-tap items-center gap-3 font-ui text-sm text-ink">
      <input type="checkbox" role="switch" className="h-5 w-5 accent-brand" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Swatches({ colors }) {
  return (
    <span className="flex overflow-hidden rounded-md border border-line" aria-hidden="true">
      {['primary', 'accent', 'background', 'text'].map((k) => (
        <span key={k} className="h-6 w-6" style={{ background: colors[k] }} />
      ))}
    </span>
  );
}

function Editor({ data, companies }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(data.design);
  const [saved, setSaved] = useState(data.design);
  const [sample, setSample] = useState('ticket');
  const [company, setCompany] = useState(companies[0] || '');
  const [width, setWidth] = useState('desktop');
  const [html, setHtml] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const badColors = useMemo(() => COLOR_FIELDS.filter(([k]) => !HEX.test(draft.colors[k] || '')).map(([k]) => k), [draft.colors]);

  const set = (patch) => {
    setMsg(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const setColor = (k, v) => {
    setMsg(null);
    setDraft((d) => ({ ...d, palette: 'custom', colors: { ...d.colors, [k]: v } }));
  };
  const pickPalette = (id) => {
    setMsg(null);
    if (id === 'custom') return setDraft((d) => ({ ...d, palette: 'custom' }));
    const { primary, accent, background, text: ink } = data.palettes[id];
    return setDraft((d) => ({ ...d, palette: id, colors: { primary, accent, background, text: ink } }));
  };

  // Live preview: the server renders the draft exactly as it would be sent. Nothing is saved.
  useEffect(() => {
    if (badColors.length) return undefined;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        setHtml(await previewEmailDesign({ design: draft, sample, company }, { signal: ctrl.signal }));
        setPreviewError('');
      } catch (err) {
        if (!ctrl.signal.aborted) setPreviewError(errorMessage(err, 'Could not draw the preview.'));
      }
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [draft, sample, company, badColors.length]);

  async function run(kind, fn) {
    setBusy(kind);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Something went wrong.') });
    } finally {
      setBusy('');
    }
  }

  const save = () => run('save', async () => {
    const d = await saveEmailDesign(draft);
    setDraft(d);
    setSaved(d);
    setMsg({ tone: 'success', text: 'Saved. Emails sent from now on use this design.' });
    queryClient.invalidateQueries({ queryKey: ['settings', 'email-design'] });
  });
  const reset = () => run('reset', async () => {
    const d = await resetEmailDesign();
    setDraft(d);
    setSaved(d);
    setConfirmReset(false);
    setMsg({ tone: 'success', text: 'Back to the default design.' });
    queryClient.invalidateQueries({ queryKey: ['settings', 'email-design'] });
  });
  const test = () => run('test', async () => {
    const r = await testEmailDesign({ design: draft, sample, company });
    setMsg({ tone: 'success', text: `Test email sent to ${r.to}.` });
  });

  const text = (k, label, { hint, max, placeholder } = {}) => (
    <Field id={`ed-${k}`} label={label} hint={hint}>
      <TextInput id={`ed-${k}`} value={draft[k]} maxLength={max} placeholder={placeholder} onChange={(e) => set({ [k]: e.target.value })} />
    </Field>
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start">
      <div className="space-y-5">
        <Section title="Style" hint="The overall shape of the email.">
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            {data.styles.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={draft.style === s}
                onClick={() => set({ style: s })}
                className={`min-h-tap rounded-btn border px-3 py-2.5 text-left font-ui text-sm ${draft.style === s ? 'border-brand bg-primary-muted ring-1 ring-brand' : 'border-line bg-surface hover:border-brand'}`}
              >
                <span className="flex items-center justify-between font-medium text-ink">
                  {STYLE_INFO[s]?.[0] || s}
                  {draft.style === s && <Check size={16} className="text-brand" aria-hidden="true" />}
                </span>
                <span className="block text-xs text-ink-3">{STYLE_INFO[s]?.[1]}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Colours" hint="Use one of the app's themes, or set your own four colours.">
          <div className="grid grid-cols-2 gap-2">
            {[...Object.entries(data.palettes), ['custom', { label: 'Custom', ...draft.colors }]].map(([id, p]) => (
              <button
                key={id}
                type="button"
                aria-pressed={draft.palette === id}
                onClick={() => pickPalette(id)}
                className={`flex min-h-tap items-center justify-between gap-2 rounded-btn border px-3 py-2 font-ui text-sm ${draft.palette === id ? 'border-brand bg-primary-muted ring-1 ring-brand' : 'border-line bg-surface hover:border-brand'}`}
              >
                <span className="font-medium text-ink">{p.label}</span>
                <Swatches colors={id === 'custom' ? draft.colors : p} />
              </button>
            ))}
          </div>
          <div className="space-y-3">
            {COLOR_FIELDS.map(([k, label, hint]) => {
              const bad = badColors.includes(k);
              return (
                <Field key={k} id={`ed-c-${k}`} label={label} hint={hint} error={bad ? 'Use a colour like #0F5B5A.' : ''}>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label={`${label} picker`}
                      value={HEX.test(draft.colors[k]) ? draft.colors[k] : '#000000'}
                      onChange={(e) => setColor(k, e.target.value.toUpperCase())}
                      className="h-11 w-14 shrink-0 cursor-pointer rounded-btn border border-line bg-surface p-1"
                    />
                    <TextInput id={`ed-c-${k}`} value={draft.colors[k]} maxLength={7} error={bad ? 'bad' : ''} className="font-mono uppercase" onChange={(e) => setColor(k, e.target.value.trim())} />
                  </div>
                </Field>
              );
            })}
          </div>
          {draft.palette === 'custom' && (
            <p className="font-ui text-xs text-ink-3">Custom colours are checked when saving: the main colour must be dark enough for white button text, and the text must stand out from the background.</p>
          )}
        </Section>

        <Section title="Header">
          {text('title', 'Title', { max: 20 })}
          {text('subtitle', 'Subtitle', { max: 60, hint: 'Leave empty to hide it.' })}
          <Toggle label="Show the ATOM logo" checked={draft.showLogo} onChange={(v) => set({ showLogo: v })} />
          <Toggle label="Show the company name (AVIT, Siyanaat, Tanzeem)" checked={draft.showCompany} onChange={(v) => set({ showCompany: v })} />
        </Section>

        <Section title="Message">
          {text('buttonLabel', 'Button text', { max: 30 })}
          {text('signOff', 'Sign-off', { max: 80, placeholder: 'e.g. Regards, {company} Team', hint: 'Optional. {company} becomes the sending company.' })}
        </Section>

        <Section title="Footer" hint="{company} becomes the company the email is sent from; with no company it becomes the header title.">
          {text('footerText', 'Footer line', { max: 120 })}
          {text('noReply', 'Do-not-reply line', { max: 160, hint: 'Leave empty to hide it.' })}
          <Toggle label="Show the watermark under the email" checked={draft.showWatermark} onChange={(v) => set({ showWatermark: v })} />
          {draft.showWatermark && text('watermark', 'Watermark text', { max: 80 })}
        </Section>
      </div>

      <div className="space-y-4 lg:sticky lg:top-20">
        <section className="card space-y-3">
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          {dirty && !msg && <Alert tone="info">You have changes that are not saved yet.</Alert>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={!dirty || badColors.length > 0 || Boolean(busy)} onClick={save}>
              {busy === 'save' ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Save size={18} aria-hidden="true" />} Save design
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!data.smtpConfigured || badColors.length > 0 || Boolean(busy)}
              onClick={test}
              title={data.smtpConfigured ? 'Sends this sample to your own email address' : 'SMTP is not set on the server'}
            >
              {busy === 'test' ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />} Send test to me
            </button>
            <button type="button" className="btn-secondary" disabled={Boolean(busy)} onClick={() => setConfirmReset(true)}>
              <RotateCcw size={18} aria-hidden="true" /> Reset to default
            </button>
          </div>
          {!data.smtpConfigured && <p className="font-ui text-xs text-ink-3">Test emails need SMTP set in the server .env.</p>}
          {data.history.length > 0 && (
            <div>
              <h3 className="font-ui text-sm font-medium text-ink">Recent changes</h3>
              <ul className="mt-1 space-y-0.5 font-ui text-xs text-ink-3">
                {data.history.map((h) => (
                  <li key={`${h.at}-${h.kind}`}>
                    {h.kind === 'reset' ? 'Reset to default' : 'Saved'} by {h.by || 'someone'} · {formatDateTime(h.at)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
        <section className="card space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field id="ed-sample" label="Sample email">
              <select id="ed-sample" className="block min-h-tap rounded-btn border border-line bg-surface px-3 font-ui text-sm" value={sample} onChange={(e) => setSample(e.target.value)}>
                {SAMPLES.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </Field>
            {sample !== 'reset' && (
              <Field id="ed-company" label="Sent from">
                <select id="ed-company" className="block min-h-tap rounded-btn border border-line bg-surface px-3 font-ui text-sm" value={company} onChange={(e) => setCompany(e.target.value)}>
                  {companies.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </Field>
            )}
            <div className="ml-auto flex rounded-btn border border-line" role="group" aria-label="Preview width">
              <button type="button" aria-pressed={width === 'desktop'} onClick={() => setWidth('desktop')} className={`flex min-h-tap min-w-tap items-center justify-center px-3 ${width === 'desktop' ? 'bg-primary-muted text-brand' : 'text-ink-3'}`} aria-label="Desktop">
                <Monitor size={18} aria-hidden="true" />
              </button>
              <button type="button" aria-pressed={width === 'phone'} onClick={() => setWidth('phone')} className={`flex min-h-tap min-w-tap items-center justify-center px-3 ${width === 'phone' ? 'bg-primary-muted text-brand' : 'text-ink-3'}`} aria-label="Phone">
                <Smartphone size={18} aria-hidden="true" />
              </button>
            </div>
          </div>
          {previewError && <Alert tone="error">{previewError}</Alert>}
          <div className="overflow-hidden rounded-btn border border-line bg-cream">
            {html ? (
              <iframe
                title="Email preview"
                sandbox=""
                srcDoc={html}
                className="mx-auto block h-[36rem] max-w-full border-0 bg-white"
                style={{ width: width === 'phone' ? 390 : '100%' }}
              />
            ) : (
              <div className="flex h-64 items-center justify-center">
                <LoaderCircle size={20} className="animate-spin text-ink-3" aria-label="Loading preview" />
              </div>
            )}
          </div>
        </section>

      </div>

      {confirmReset && (
        <Modal
          title="Reset to the default design?"
          onClose={() => setConfirmReset(false)}
          busy={busy === 'reset'}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setConfirmReset(false)} disabled={busy === 'reset'}>Cancel</button>
              <button type="button" className="btn-primary" onClick={reset} disabled={busy === 'reset'}>
                {busy === 'reset' && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Reset
              </button>
            </>
          }
        >
          <p className="font-ui text-sm text-ink-2">Teal colours, Classic style and the original header and footer wording. Saved for everyone straight away.</p>
        </Modal>
      )}
    </div>
  );
}

// Super Admin: the look of every email ATOM sends.
export default function EmailDesignPage() {
  const q = useQuery({ queryKey: ['settings', 'email-design'], queryFn: getEmailDesign, staleTime: Infinity, refetchOnWindowFocus: false });
  const companiesQ = useQuery({ queryKey: ['settings', 'companies'], queryFn: listCompanySettings });
  const companies = (companiesQ.data || []).map((c) => c.name);
  return (
    <section className="space-y-5">
      <div>
        <Link to="/settings" className="inline-flex min-h-tap items-center gap-1 font-ui text-sm text-brand hover:underline">
          <ArrowLeft size={16} aria-hidden="true" /> Settings
        </Link>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Super Admin</p>
        <h1 className="mt-1 flex items-center gap-2 text-3xl">
          <Palette size={26} className="text-brand" aria-hidden="true" /> Email design
        </h1>
        <p className="mt-1 font-ui text-sm text-ink-2">The look of every email ATOM sends — tickets, requests, Jamea Internet Access and password resets. The company name is filled in automatically.</p>
      </div>
      {(q.isPending || companiesQ.isPending) && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
      {q.isError && <Alert tone="error">Could not load the email design.</Alert>}
      {q.data && companiesQ.isSuccess && <Editor data={q.data} companies={companies.length ? companies : ['AVIT']} />}
    </section>
  );
}
