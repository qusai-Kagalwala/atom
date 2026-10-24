import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Lock, LoaderCircle, MapPin, MessageSquare, Send } from 'lucide-react';
import { addComment, eligibleEngineers, getTicket, listCategories, ticketAction, triageTicket } from '../api/requests';
import { errorMessage } from '../api/http';
import AuthImage from '../components/AuthImage';
import { Alert, Field } from '../components/FormControls';
import Modal from '../components/Modal';
import PhotoPicker from '../components/PhotoPicker';
import useAuth from '../hooks/useAuth';
import { formatDateTime } from '../utils/format';
import {
  ACTION_BUTTONS,
  PRIORITIES,
  eventText,
  priorityBadge,
  priorityLabel,
  statusBadge,
  statusLabel,
} from '../utils/requests';

const selectClass =
  'block min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';
const textareaClass =
  'block w-full rounded-btn border border-line bg-white px-3 py-2 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';
const buttonClass = { primary: 'btn-primary', secondary: 'btn-secondary', danger: 'btn-danger' };

// One modal for every action that needs a note or an engineer.
function ActionModal({ ticket, action, onClose, onDone }) {
  const cfg = ACTION_BUTTONS[action];
  const [note, setNote] = useState('');
  const [engineerId, setEngineerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const engineers = useQuery({
    queryKey: ['requests', ticket.number, 'engineers'],
    queryFn: () => eligibleEngineers(ticket.number),
    enabled: action === 'assign',
  });

  const needsNote = cfg.note === 'required';
  const ready = (action !== 'assign' || engineerId) && (!needsNote || note.trim().length >= 3);

  async function submit(e) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      const fresh = await ticketAction(ticket.number, action, { note, engineerId: engineerId || undefined });
      onDone(fresh, `${ticket.number}: ${cfg.label.toLowerCase()} done.`);
      onClose();
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'));
      setBusy(false);
    }
  }

  const currentId = ticket.assignedEngineer?.id;

  return (
    <Modal
      title={action === 'assign' && currentId ? 'Reassign' : cfg.label}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="action-form" className={buttonClass[cfg.tone]} disabled={!ready || busy}>
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />}
            {action === 'assign' && currentId ? 'Reassign' : cfg.label}
          </button>
        </>
      }
    >
      {error && (
        <div className="mb-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      <form id="action-form" onSubmit={submit} className="space-y-4" noValidate>
        {action === 'assign' && (
          <Field id="engineer" label="Engineer" hint="Active engineers tagged to this service unit. Open work in brackets.">
            {engineers.isError ? (
              <Alert tone="error">Could not load engineers.</Alert>
            ) : (
              <select id="engineer" className={selectClass} value={engineerId} onChange={(e) => setEngineerId(e.target.value)}>
                <option value="">{engineers.isPending ? 'Loading…' : 'Choose an engineer'}</option>
                {(engineers.data || []).map((eng) => (
                  <option key={eng.id} value={eng.id} disabled={eng.id === currentId}>
                    {eng.name} ({eng.open_work}){eng.id === currentId ? ' — current' : ''}
                  </option>
                ))}
              </select>
            )}
            {engineers.isSuccess && engineers.data.length === 0 && (
              <p className="mt-1 font-ui text-xs text-error">No engineer is tagged to this service unit yet (Users &amp; roles).</p>
            )}
          </Field>
        )}
        {(cfg.note || action === 'assign') && (
          <Field
            id="action-note"
            label={cfg.noteLabel || 'Note (optional)'}
            hint={action === 'reject' || action === 'wait_user' ? 'The requester will see this.' : undefined}
          >
            <textarea id="action-note" rows={3} maxLength={5000} value={note} onChange={(e) => setNote(e.target.value)} className={textareaClass} />
          </Field>
        )}
        {!cfg.note && action !== 'assign' && (
          <p className="font-ui text-sm text-ink-2">
            {action === 'close' ? 'Closing is final — the ticket can’t be reopened.' : `Confirm: ${cfg.label.toLowerCase()} on ${ticket.number}.`}
          </p>
        )}
      </form>
    </Modal>
  );
}

function CommentBox({ ticket, onDone }) {
  const [note, setNote] = useState('');
  const [internal, setInternal] = useState(false);
  const [photos, setPhotos] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const p = ticket.permissions;

  async function submit(e) {
    e.preventDefault();
    if ((!note.trim() && !photos.length) || busy) return;
    setBusy(true);
    setError('');
    try {
      const fresh = await addComment(ticket.number, { note, internal: internal ? 'true' : undefined }, photos);
      setNote('');
      setPhotos([]);
      setInternal(false);
      onDone(fresh, internal ? 'Internal note added.' : 'Comment added.');
    } catch (err) {
      setError(errorMessage(err, 'Could not add the comment.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={`card space-y-3 ${internal ? 'border-gold bg-gold-muted/40' : ''}`} noValidate>
      <label htmlFor="comment" className="font-ui text-sm font-medium text-ink">
        {internal ? 'Internal note (only engineers and Super Admins see this)' : 'Add a comment'}
      </label>
      {error && <Alert tone="error">{error}</Alert>}
      <textarea id="comment" rows={3} maxLength={5000} value={note} onChange={(e) => setNote(e.target.value)} className={textareaClass} />
      {p.canAddPhotos && <PhotoPicker files={photos} onChange={setPhotos} max={p.photosLeft} onError={setError} disabled={busy} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {p.canAddInternalNote ? (
          <label className="flex min-h-tap items-center gap-2 font-ui text-sm text-ink-2">
            <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} className="h-5 w-5 rounded border-line text-primary focus:ring-primary" />
            <Lock size={14} aria-hidden="true" /> Internal note
          </label>
        ) : (
          <span />
        )}
        <button type="submit" className="btn-primary" disabled={busy || (!note.trim() && !photos.length)}>
          {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}
          {internal ? 'Add note' : 'Send'}
        </button>
      </div>
    </form>
  );
}

function Triage({ ticket, onDone }) {
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories, staleTime: 10 * 60_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function change(body) {
    setBusy(true);
    setError('');
    try {
      onDone(await triageTicket(ticket.number, body), 'Saved.');
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field id="tri-priority" label="Priority">
        <select id="tri-priority" className={selectClass} value={ticket.priority} disabled={busy} onChange={(e) => change({ priority: e.target.value })}>
          {Object.values(PRIORITIES).map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <Field id="tri-category" label="Category">
        <select id="tri-category" className={selectClass} value={ticket.categoryId || ''} disabled={busy} onChange={(e) => change({ categoryId: e.target.value })}>
          {(categories.data || []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      {error && (
        <div className="sm:col-span-2">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
    </div>
  );
}

function Photo({ a, onOpen }) {
  return (
    <div className="relative">
      <AuthImage url={a.url} alt={a.originalName || 'Photo'} className="h-24 w-24 rounded-btn" onClick={onOpen} />
      {a.isInternal && (
        <span className="absolute left-1 top-1 rounded bg-gold px-1 font-ui text-[10px] font-medium text-gold-on" title="Internal">
          <Lock size={10} className="inline" aria-hidden="true" /> Internal
        </span>
      )}
    </div>
  );
}

// Where "Back" goes: the list that opened this ticket (only our own list pages are accepted).
const BACK_LABELS = [
  ['/work-queue', 'My work queue'],
  ['/assign', 'Assign queue'],
  ['/all', 'All tickets & requests'],
];
function backTarget(from) {
  const hit = typeof from === 'string' && BACK_LABELS.find(([p]) => from === p || from.startsWith(`${p}?`));
  return hit ? { to: from, label: hit[1] } : { to: '/track', label: 'My tickets & requests' };
}

export default function TicketPage() {
  const { number } = useParams();
  const location = useLocation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [action, setAction] = useState(null);
  const [notice, setNotice] = useState(location.state?.notice || '');
  const [viewer, setViewer] = useState(null); // blob URL of an opened photo

  const back = backTarget(location.state?.from);
  const key = ['requests', 'detail', number];
  const ticketQuery = useQuery({ queryKey: key, queryFn: () => getTicket(number), retry: false });

  const done = (fresh, message) => {
    queryClient.setQueryData(key, fresh);
    queryClient.invalidateQueries({ queryKey: ['requests', 'mine'] });
    setNotice(message);
  };

  if (ticketQuery.isPending) {
    return (
      <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
        <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading…
      </p>
    );
  }
  if (ticketQuery.isError) {
    return (
      <div className="space-y-4">
        <Link to={back.to} className="inline-flex items-center gap-1 font-ui text-sm text-primary hover:underline">
          <ArrowLeft size={16} aria-hidden="true" /> {back.label}
        </Link>
        <Alert tone="error">{errorMessage(ticketQuery.error, 'Could not load this ticket.')}</Alert>
      </div>
    );
  }

  const t = ticketQuery.data;
  const viewerIsRequester = t.requester.id === user.id || t.raisedBy.id === user.id;
  const withTicket = t.attachments.filter((a) => !a.eventId);
  const byEvent = t.attachments.reduce((m, a) => (a.eventId ? m.set(a.eventId, [...(m.get(a.eventId) || []), a]) : m), new Map());

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link to={back.to} className="inline-flex items-center gap-1 font-ui text-sm text-primary hover:underline">
        <ArrowLeft size={16} aria-hidden="true" /> {back.label}
      </Link>

      {notice && <Alert tone="success">{notice}</Alert>}

      <header className="card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-ui text-xs tabular-nums text-ink-3">
              {t.number} · {t.category || 'No category'}
            </p>
            <h1 className="mt-1 text-2xl sm:text-3xl">{t.title}</h1>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span className={statusBadge(t.status)}>{statusLabel(t.status, { viewerIsRequester })}</span>
            <span className={priorityBadge(t.priority)}>{priorityLabel(t.priority)}</span>
          </div>
        </div>

        <dl className="mt-4 grid gap-x-6 gap-y-2 font-ui text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink-3">For</dt>
            <dd className="text-ink">
              {t.requester.name}
              {t.raisedForSomeoneElse && <span className="text-ink-2"> · raised by {t.raisedBy.name}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink-3">Engineer</dt>
            <dd className="text-ink">{t.assignedEngineer?.name || <span className="text-ink-3">Not assigned yet</span>}</dd>
          </div>
          {t.location && (
            <div>
              <dt className="text-xs uppercase tracking-wider text-ink-3">Where</dt>
              <dd className="flex items-center gap-1 text-ink">
                <MapPin size={14} className="text-ink-3" aria-hidden="true" /> {t.location}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink-3">Raised</dt>
            <dd className="text-ink">{formatDateTime(t.createdAt)}</dd>
          </div>
        </dl>

        <p className="mt-4 whitespace-pre-wrap font-ui text-sm text-ink">{t.description}</p>

        {withTicket.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {withTicket.map((a) => (
              <Photo key={a.id} a={a} onOpen={setViewer} />
            ))}
          </div>
        )}

        {t.status === 'RESOLVED' && t.resolution && (
          <div className="mt-4">
            <Alert tone="success">
              <strong>Fix:</strong> {t.resolution}
            </Alert>
          </div>
        )}
        {t.status === 'REJECTED' && t.rejectionNote && (
          <div className="mt-4">
            <Alert tone="error">
              <strong>Rejected:</strong> {t.rejectionNote}
            </Alert>
          </div>
        )}

        {t.permissions.actions.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
            {t.permissions.actions.map((a) => (
              <button key={a} type="button" className={buttonClass[ACTION_BUTTONS[a].tone]} onClick={() => setAction(a)}>
                {a === 'assign' && t.assignedEngineer ? 'Reassign' : ACTION_BUTTONS[a].label}
              </button>
            ))}
          </div>
        )}
      </header>

      {t.permissions.canEditTriage && (
        <section className="card">
          <h2 className="text-xl">Triage</h2>
          <div className="mt-3">
            <Triage ticket={t} onDone={done} />
          </div>
        </section>
      )}

      <section>
        <h2 className="text-xl">Activity</h2>
        <ol className="mt-3 space-y-3">
          {t.events.map((e) =>
            e.type === 'comment' ? (
              <li key={e.id} className={`card p-4 ${e.isInternal ? 'border-gold bg-gold-muted/40' : ''}`}>
                <p className="flex flex-wrap items-center gap-2 font-ui text-xs text-ink-3">
                  <MessageSquare size={14} aria-hidden="true" />
                  <span className="font-medium text-ink">{e.actor?.name || 'Someone'}</span>
                  <span>{formatDateTime(e.at)}</span>
                  {e.isInternal && (
                    <span className="badge bg-gold text-gold-on">
                      <Lock size={10} className="mr-1" aria-hidden="true" /> Internal
                    </span>
                  )}
                </p>
                {e.note && <p className="mt-2 whitespace-pre-wrap font-ui text-sm text-ink">{e.note}</p>}
                {byEvent.get(e.id) && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {byEvent.get(e.id).map((a) => (
                      <Photo key={a.id} a={a} onOpen={setViewer} />
                    ))}
                  </div>
                )}
              </li>
            ) : (
              <li key={e.id} className="flex gap-3 px-1 font-ui text-sm">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gold" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-ink">
                    <span className="font-medium">{e.actor?.name || 'ATOM'}</span> · {eventText(e)}
                  </p>
                  {e.note && <p className="mt-0.5 whitespace-pre-wrap text-ink-2">“{e.note}”</p>}
                  <p className="text-xs text-ink-3">{formatDateTime(e.at)}</p>
                </div>
              </li>
            )
          )}
        </ol>
      </section>

      {t.permissions.canComment ? (
        <CommentBox ticket={t} onDone={done} />
      ) : (
        <p className="font-ui text-sm text-ink-3">This ticket is {statusLabel(t.status).toLowerCase()} — no more comments.</p>
      )}

      {action && <ActionModal ticket={t} action={action} onClose={() => setAction(null)} onDone={done} />}

      {viewer && (
        <Modal title="Photo" onClose={() => setViewer(null)}>
          <img src={viewer} alt="" className="mx-auto max-h-[70vh] w-auto rounded-btn" />
        </Modal>
      )}
    </div>
  );
}
