import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bot, LoaderCircle, Send, UserRound, X } from 'lucide-react';
import { getDefaultLocation, raiseTicket } from '../api/requests';
import { getProblemTree } from '../api/problems';
import { listUsers } from '../api/users';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import PhotoPicker from '../components/PhotoPicker';
import PriorityPicker from '../components/PriorityPicker';
import useAuth from '../hooks/useAuth';
import { isAdminRole } from '../utils/roles';
import { loginIdLabel } from '../utils/format';

const MAX_PHOTOS = 5;
const selectClass =
  'block min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';

// Super Admin only: pick the person the ticket is for.
function PersonPicker({ value, onChange }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const results = useQuery({
    queryKey: ['users', 'picker', debounced],
    queryFn: () => listUsers({ q: debounced, status: 'active', pageSize: 8 }),
    enabled: debounced.length >= 2,
  });

  if (value) {
    return (
      <div className="flex min-h-tap items-center justify-between gap-2 rounded-btn border border-primary bg-primary-tint px-3">
        <span className="min-w-0 font-ui text-sm">
          <span className="font-medium text-ink">{value.name}</span>{' '}
          <span className="tabular-nums text-ink-2">· {loginIdLabel(value)}</span>
        </span>
        <button type="button" onClick={() => onChange(null)} className="flex min-h-tap min-w-tap items-center justify-center text-ink-2 hover:text-ink" aria-label="Clear">
          <X size={18} />
        </button>
      </div>
    );
  }

  return (
    <div>
      <TextInput id="for-person" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ITS number or employee ID" autoComplete="off" />
      {debounced.length >= 2 && (
        <ul className="mt-1 max-h-60 overflow-y-auto rounded-btn border border-line bg-white font-ui text-sm" role="listbox">
          {results.isFetching && <li className="px-3 py-2 text-ink-3">Searching…</li>}
          {results.data?.users.length === 0 && <li className="px-3 py-2 text-ink-3">No active user found.</li>}
          {results.data?.users.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => onChange(u)}
                className="flex min-h-tap w-full items-center gap-2 px-3 text-left hover:bg-gold-muted"
              >
                <UserRound size={16} className="shrink-0 text-ink-3" aria-hidden="true" />
                <span className="truncate">
                  {u.name} <span className="tabular-nums text-ink-3">· {loginIdLabel(u)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function RaiseTicketPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  // Pre-filled from the AI assistant (Phase 12): category, title, what was said and tried.
  const draft = useLocation().state?.draft || null;
  const isAdmin = isAdminRole(user.activeRole);
  // Category > Item > Problem from the company's list (step B). Categories without items: title + description.
  const tree = useQuery({ queryKey: ['problems', 'tree'], queryFn: () => getProblemTree(false), staleTime: 5 * 60_000 });
  const categories = tree.data?.categories || [];

  const [form, setForm] = useState({
    categoryId: draft?.categoryId || '',
    itemId: '',
    problemId: '', // '' · an id · 'other'
    problemText: '',
    title: draft?.title || '',
    description: draft?.description || '',
    location: '',
    priority: draft?.priority || 'NORMAL',
  });
  const [titleEdited, setTitleEdited] = useState(Boolean(draft?.title));
  const category = categories.find((c) => c.id === form.categoryId) || null;
  const item = category?.items.find((i) => i.id === form.itemId) || null;
  const problem = item?.problems.find((p) => p.id === form.problemId) || null;
  const otherText = form.problemId === 'other' ? form.problemText.trim() : '';
  const autoTitle = item ? `${item.name}${problem ? ` – ${problem.name}` : otherText ? ` – ${otherText}` : ''}`.slice(0, 120) : '';
  const title = titleEdited || !item ? form.title : autoTitle;
  const goesTo = tree.data?.autoAssign && category?.occupation ? category.occupation.name : null;
  const [forSomeoneElse, setForSomeoneElse] = useState(false);
  const [person, setPerson] = useState(null);
  const [locationEdited, setLocationEdited] = useState(false);

  // "Where?" starts as the requester's department location, until the person types their own.
  const target = forSomeoneElse ? person?.id : 'me';
  const defaultLocation = useQuery({
    queryKey: ['requests', 'default-location', target],
    queryFn: () => getDefaultLocation(forSomeoneElse ? person.id : undefined),
    enabled: Boolean(target),
    staleTime: 5 * 60_000,
  });
  const suggested = target ? defaultLocation.data ?? null : null;
  const location = locationEdited ? form.location : suggested || '';
  const [photos, setPhotos] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [photoError, setPhotoError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // From the list: an item and a problem (or "Other" in their own words); the details are optional.
  const missing =
    !form.categoryId ||
    (forSomeoneElse && !person) ||
    (item
      ? !(problem || otherText.length >= 3) || title.trim().length < 3
      : title.trim().length < 3 || !form.description.trim());

  async function submit(e) {
    e.preventDefault();
    if (missing || busy) return;
    setBusy(true);
    setError('');
    try {
      const t = await raiseTicket(
        {
          categoryId: form.categoryId,
          itemId: item ? item.id : undefined,
          problemId: problem ? problem.id : undefined,
          problemText: item && !problem ? otherText : undefined,
          title,
          description: form.description,
          priority: form.priority,
          location,
          requesterId: forSomeoneElse ? person.id : undefined,
          assistantSessionId: !forSomeoneElse ? draft?.assistantSessionId : undefined,
        },
        photos
      );
      navigate(`/tickets/${t.number}`, { replace: true, state: { notice: `Ticket ${t.number} raised.` } });
    } catch (err) {
      setError(errorMessage(err, 'Could not raise the ticket.'));
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-2xl">
      <Link to="/track" className="inline-flex items-center gap-1 font-ui text-sm text-primary hover:underline">
        <ArrowLeft size={16} aria-hidden="true" /> My tickets &amp; requests
      </Link>
      <h1 className="mt-3 text-3xl">Raise a ticket</h1>
      <p className="mt-1 font-ui text-sm text-ink-2">Something not working? Tell {user.company?.name || 'us'} what's wrong and where.</p>
      {draft ? (
        <div className="mt-4">
          <Alert tone="info">
            Filled in from the AI assistant — check it and add anything missing.
            {draft.info?.length > 0 && ` Please include: ${draft.info.join(', ')}.`}
          </Alert>
        </div>
      ) : (
        user.company?.code === 'AVIT' && <Link to="/assistant" className="mt-2 inline-flex items-center gap-1 font-ui text-sm text-primary hover:underline">
          <Bot size={16} aria-hidden="true" /> Try the AI assistant first — many problems are fixed in a minute
        </Link>
      )}

      {error && (
        <div className="mt-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      <form onSubmit={submit} className="card mt-5 space-y-5" noValidate>
        {isAdmin && (
          <div className="space-y-2">
            <label className="flex min-h-tap items-center gap-3 font-ui text-sm text-ink">
              <input
                type="checkbox"
                checked={forSomeoneElse}
                onChange={(e) => {
                  setForSomeoneElse(e.target.checked);
                  if (!e.target.checked) setPerson(null);
                }}
                className="h-5 w-5 rounded border-line text-primary focus:ring-primary"
              />
              Raise this for someone else
            </label>
            {forSomeoneElse && (
              <Field id="for-person" label="Who is it for?" hint="They and you both get updates.">
                <PersonPicker value={person} onChange={setPerson} />
              </Field>
            )}
          </div>
        )}

        {tree.isError && <Alert tone="error">Could not load the list of problems.</Alert>}
        <Field id="category" label="What kind of problem?" hint={goesTo ? `Goes straight to ${/^[aeiou]/i.test(goesTo) ? 'an' : 'a'} ${goesTo.replace(/\b(?![A-Z]{2,}\b)\w+/g, (w) => w.toLowerCase())}.` : undefined}>
          <select
            id="category"
            className={selectClass}
            value={form.categoryId}
            onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value, itemId: '', problemId: '', problemText: '' }))}
            disabled={tree.isPending}
          >
            <option value="">{tree.isPending ? 'Loading…' : 'Choose a category'}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        {category?.items.length > 0 && (
          <Field id="item" label="What is it?" hint="Not in the list? Choose “Not listed” and describe it below.">
            <select
              id="item"
              className={selectClass}
              value={form.itemId}
              onChange={(e) => setForm((f) => ({ ...f, itemId: e.target.value, problemId: '', problemText: '' }))}
            >
              <option value="">Not listed / not sure</option>
              {category.items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {item && (
          <Field id="problem" label="What's wrong with it?">
            <select id="problem" className={selectClass} value={form.problemId} onChange={set('problemId')}>
              <option value="">Choose the problem</option>
              {item.problems
                .filter((p) => p.name.toLowerCase() !== 'other')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              <option value="other">Other — I’ll type it</option>
            </select>
            {form.problemId === 'other' && (
              <TextInput
                id="problem-text"
                className="mt-2"
                value={form.problemText}
                onChange={set('problemText')}
                maxLength={200}
                placeholder="Say what's wrong in a few words"
              />
            )}
          </Field>
        )}

        <Field id="title" label="Short title" hint={item ? 'Filled in from your choice — change it if you like.' : 'e.g. “Projector in Hall B shows no picture”'}>
          <TextInput
            id="title"
            value={title}
            onChange={(e) => {
              setTitleEdited(true);
              set('title')(e);
            }}
            maxLength={120}
          />
        </Field>

        <Field id="description" label={item ? "Anything else? (optional)" : "What's happening?"} hint="What you tried, error messages, since when.">
          <textarea
            id="description"
            value={form.description}
            onChange={set('description')}
            maxLength={5000}
            rows={5}
            className="block w-full rounded-btn border border-line bg-white px-3 py-2 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
          />
        </Field>

        <Field
          id="location"
          label="Where?"
          hint={
            suggested && location === suggested
              ? 'Filled in from the department. Change it if the problem is somewhere else.'
              : 'Building, floor, room — e.g. “Library, 2nd floor”'
          }
        >
          <TextInput
            id="location"
            value={location}
            onChange={(e) => {
              setLocationEdited(true);
              set('location')(e);
            }}
            maxLength={200}
          />
        </Field>

        <PriorityPicker value={form.priority} onChange={(p) => setForm((f) => ({ ...f, priority: p }))} />

        <Field id="photos" label="Photos (optional)">
          <PhotoPicker
            files={photos}
            onChange={(f) => {
              setPhotos(f);
              setPhotoError('');
            }}
            max={MAX_PHOTOS}
            onError={setPhotoError}
            disabled={busy}
          />
          {photoError && <p className="mt-1 font-ui text-xs text-error">{photoError}</p>}
        </Field>

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Link to="/track" className="btn-secondary">
            Cancel
          </Link>
          <button type="submit" className="btn-primary" disabled={missing || busy}>
            {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}
            {busy ? 'Sending…' : 'Raise ticket'}
          </button>
        </div>
      </form>
    </section>
  );
}
