import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, LoaderCircle, Send, UserRound, X } from 'lucide-react';
import { listCategories, raiseTicket } from '../api/requests';
import { listUsers } from '../api/users';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import PhotoPicker from '../components/PhotoPicker';
import useAuth from '../hooks/useAuth';
import { loginIdLabel } from '../utils/format';
import { PRIORITIES, REQUESTER_PRIORITIES } from '../utils/requests';

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
  const isAdmin = user.activeRole === 'SUPER_ADMIN';
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories, staleTime: 10 * 60_000 });

  const [form, setForm] = useState({ categoryId: '', title: '', description: '', location: '', priority: 'NORMAL' });
  const [forSomeoneElse, setForSomeoneElse] = useState(false);
  const [person, setPerson] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [photoError, setPhotoError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const priorities = isAdmin ? Object.keys(PRIORITIES) : REQUESTER_PRIORITIES;
  const missing = !form.categoryId || form.title.trim().length < 3 || !form.description.trim() || (forSomeoneElse && !person);

  async function submit(e) {
    e.preventDefault();
    if (missing || busy) return;
    setBusy(true);
    setError('');
    try {
      const t = await raiseTicket({ ...form, requesterId: forSomeoneElse ? person.id : undefined }, photos);
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
      <p className="mt-1 font-ui text-sm text-ink-2">Something not working? Tell AVIT what's wrong and where.</p>

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

        <Field id="category" label="What kind of problem?">
          <select id="category" className={selectClass} value={form.categoryId} onChange={set('categoryId')} disabled={categories.isPending}>
            <option value="">{categories.isPending ? 'Loading…' : 'Choose a category'}</option>
            {(categories.data || []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        <Field id="title" label="Short title" hint="e.g. “Projector in Hall B shows no picture”">
          <TextInput id="title" value={form.title} onChange={set('title')} maxLength={120} />
        </Field>

        <Field id="description" label="What's happening?" hint="What you tried, error messages, since when.">
          <textarea
            id="description"
            value={form.description}
            onChange={set('description')}
            maxLength={5000}
            rows={5}
            className="block w-full rounded-btn border border-line bg-white px-3 py-2 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
          />
        </Field>

        <Field id="location" label="Where?" hint="Building, floor, room — e.g. “Library, 2nd floor”">
          <TextInput id="location" value={form.location} onChange={set('location')} maxLength={200} />
        </Field>

        <fieldset>
          <legend className="mb-1.5 font-ui text-sm font-medium text-ink">How urgent?</legend>
          <div className={`grid gap-2 ${priorities.length === 4 ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
            {priorities.map((p) => (
              <label
                key={p}
                className={`flex min-h-tap cursor-pointer items-center justify-center rounded-btn border px-3 text-center font-ui text-sm ${
                  form.priority === p ? 'border-primary bg-primary-tint text-primary' : 'border-line text-ink hover:border-gold'
                }`}
              >
                <input type="radio" name="priority" value={p} checked={form.priority === p} onChange={set('priority')} className="sr-only" />
                {isAdmin ? PRIORITIES[p].label : PRIORITIES[p].requesterLabel}
              </label>
            ))}
          </div>
        </fieldset>

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
