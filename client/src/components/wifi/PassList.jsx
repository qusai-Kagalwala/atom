import { useState } from 'react';
import { Check, Copy, Eye, EyeOff, LoaderCircle, Mail, MessageCircle, Undo2 } from 'lucide-react';
import { emailPasses, markWhatsapp, unassignGroup, unassignPass } from '../../api/wifi';
import { errorMessage } from '../../api/http';
import { Alert } from '../FormControls';
import { passMessage, whatsappLink } from '../../utils/wifi';
import { formatDateTime } from '../../utils/format';

const CHUNK = 400; // passes per call; a person's passes are never split across calls

// Passes for the same email address go in one email (an Excel file when 2+), so a person's passes stay together.
function chunksByEmail(list) {
  const byEmail = new Map();
  for (const p of list) {
    const k = p.recipient.email.trim().toLowerCase();
    if (!byEmail.has(k)) byEmail.set(k, []);
    byEmail.get(k).push(p.id);
  }
  const chunks = [];
  let cur = [];
  for (const ids of byEmail.values()) {
    if (cur.length && cur.length + ids.length > CHUNK) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(...ids);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// Passes given to people: credentials, share by WhatsApp / email, take back.
// Email: one email per person; a person with 2+ passes gets them in an Excel file.
// Passes given together (2+ in one Give) are taken back together only — "Take back all".
export default function PassList({ passes, onChanged, showDepartment = false, emptyText = 'No passes given yet.' }) {
  const [shown, setShown] = useState({});
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [progress, setProgress] = useState(null);

  async function whatsapp(p) {
    window.open(whatsappLink(p), '_blank', 'noopener');
    try {
      await markWhatsapp(p.id);
      onChanged?.();
    } catch {
      /* the chat opened; marking is best-effort */
    }
  }

  async function email(list) {
    const withEmail = list.filter((p) => p.recipient?.email);
    if (!withEmail.length) return setMsg({ tone: 'error', text: 'None of these have an email address.' });
    setBusy('email');
    setMsg(null);
    let sent = 0;
    let emails = 0;
    let failed = 0;
    let done = 0;
    try {
      for (const ids of chunksByEmail(withEmail)) {
        done += ids.length;
        setProgress(`${done} / ${withEmail.length}`);
        const r = await emailPasses(ids);
        sent += r.sent;
        emails += r.emails ?? r.sent;
        failed += r.results.length - r.sent;
      }
      setMsg({
        tone: failed ? 'error' : 'success',
        text: `${sent} pass${sent === 1 ? '' : 'es'} sent in ${emails} email${emails === 1 ? '' : 's'}${failed ? `, ${failed} not sent` : ''}.`,
      });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not send the emails.') });
    } finally {
      setBusy(null);
      setProgress(null);
      onChanged?.();
    }
    return undefined;
  }

  async function takeBack(p) {
    if (!window.confirm(`Take back ${p.username} from ${p.recipient?.name}? It can then be given to someone else.`)) return;
    setBusy(p.id);
    try {
      await unassignPass(p.id);
      onChanged?.();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not take it back.') });
    } finally {
      setBusy(null);
    }
  }

  async function takeBackGroup(p, n) {
    if (!window.confirm(`Take back all ${n} passes given together to ${p.recipient?.name}${n > 1 ? ' and others' : ''}? They can then be given again.`)) return;
    setBusy(p.group);
    try {
      const r = await unassignGroup(p.group);
      setMsg({ tone: 'success', text: `${r.count} passes taken back.` });
      onChanged?.();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not take them back.') });
    } finally {
      setBusy(null);
    }
  }

  async function copy(p) {
    try {
      await navigator.clipboard.writeText(passMessage(p));
      setMsg({ tone: 'success', text: `Copied the message for ${p.recipient?.name}.` });
    } catch {
      setMsg({ tone: 'error', text: 'Could not copy.' });
    }
  }

  if (!passes.length) {
    return (
      <div className="space-y-3">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <p className="font-ui text-sm text-ink-3">{emptyText}</p>
      </div>
    );
  }
  const withEmail = passes.filter((p) => p.recipient?.email).length;
  // Groups in this list: size, and which pass shows the "Take back all" button (the first one).
  const groupSize = new Map();
  for (const p of passes) if (p.group) groupSize.set(p.group, (groupSize.get(p.group) || 0) + 1);
  const firstOfGroup = new Set();
  const seen = new Set();
  for (const p of passes) {
    if (p.group && !seen.has(p.group)) {
      seen.add(p.group);
      firstOfGroup.add(p.id);
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-ui text-sm text-ink-2">
          {passes.length} pass{passes.length === 1 ? '' : 'es'} · {withEmail} with email
        </p>
        <button type="button" className="btn-secondary" disabled={Boolean(busy) || !withEmail} onClick={() => email(passes)}>
          {busy === 'email' ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Mail size={16} aria-hidden="true" />}
          {busy === 'email' ? `Sending ${progress || ''}` : 'Email all'}
        </button>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
        {passes.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 font-ui text-sm">
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-ink">{p.recipient?.name}</span>
              <span className="block text-xs text-ink-3">
                {[p.recipient?.its && `ITS ${p.recipient.its}`, p.recipient?.mobile, p.recipient?.email].filter(Boolean).join(' · ') || 'No contact details'}
                {showDepartment && p.department && ` · ${p.department}`}
                {p.assignedVia === 'admin' && ' · given by AVIT'}
                {p.group && ` · given together (${groupSize.get(p.group)})`}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-x-3 tabular-nums text-ink">
              <span className="whitespace-nowrap"><span className="text-ink-3">User </span>{p.username}</span>
              <span className="inline-flex items-center whitespace-nowrap">
              <span className="text-ink-3">Pass&nbsp;</span>
              {shown[p.id] ? p.password : '••••••'}
              <button
                type="button"
                className="inline-flex min-h-tap min-w-tap items-center justify-center text-ink-3 hover:text-ink"
                aria-label={shown[p.id] ? 'Hide password' : 'Show password'}
                onClick={() => setShown((s) => ({ ...s, [p.id]: !s[p.id] }))}
              >
                {shown[p.id] ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <button type="button" className="btn-secondary px-2.5" onClick={() => whatsapp(p)} title={p.sharedWhatsappAt ? `Sent ${formatDateTime(p.sharedWhatsappAt)}` : 'Open WhatsApp'}>
                {p.sharedWhatsappAt ? <Check size={16} className="text-success" aria-hidden="true" /> : <MessageCircle size={16} aria-hidden="true" />} WhatsApp
              </button>
              <button type="button" className="btn-secondary px-2.5" disabled={!p.recipient?.email || Boolean(busy)} onClick={() => email([p])} title={p.sharedEmailAt ? `Emailed ${formatDateTime(p.sharedEmailAt)}` : 'Send by email'}>
                {p.sharedEmailAt ? <Check size={16} className="text-success" aria-hidden="true" /> : <Mail size={16} aria-hidden="true" />} Email
              </button>
              <button type="button" className="btn-secondary px-2.5" onClick={() => copy(p)} aria-label="Copy message">
                <Copy size={16} aria-hidden="true" />
              </button>
              {!p.group && (
                <button type="button" className="btn-secondary px-2.5" disabled={busy === p.id} onClick={() => takeBack(p)} aria-label="Take back">
                  <Undo2 size={16} aria-hidden="true" />
                </button>
              )}
              {p.group && firstOfGroup.has(p.id) && (
                <button
                  type="button"
                  className="btn-secondary px-2.5"
                  disabled={busy === p.group}
                  onClick={() => takeBackGroup(p, groupSize.get(p.group))}
                  title="Passes given together are taken back together"
                >
                  {busy === p.group ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Undo2 size={16} aria-hidden="true" />} Take back all{' '}
                  {groupSize.get(p.group)}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
