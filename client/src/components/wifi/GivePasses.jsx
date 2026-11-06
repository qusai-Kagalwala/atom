import { useState } from 'react';
import { LoaderCircle, Search, Send, UserPlus, Users } from 'lucide-react';
import { assignPasses, lookupIts } from '../../api/wifi';
import { errorMessage } from '../../api/http';
import { Alert, Field, TextInput } from '../FormControls';
import { parsePeople } from '../../utils/wifi';

const selectClass =
  'min-h-tap w-full rounded-btn border border-line bg-surface px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted';
const blank = { its: '', name: '', mobile: '', email: '', count: 1 };

// Give passes to one person or to a list. batches: [{ id, name, ssid, left }]; departmentId: null = AVIT
// Admin giving from the unallocated pool. onDone(passes) shows the new passes to share.
export default function GivePasses({ batches, departmentId = null, onDone }) {
  const [batchId, setBatchId] = useState(batches[0]?.id || '');
  const [mode, setMode] = useState('one');
  const [p, setP] = useState(blank);
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState(null);
  const [text, setText] = useState('');
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const batch = batches.find((b) => b.id === batchId) || batches[0];
  const set = (k) => (e) => setP((x) => ({ ...x, [k]: e.target.value }));

  async function find() {
    setLooking(true);
    setError('');
    setFound(null);
    try {
      const r = await lookupIts(p.its.trim());
      setP((x) => ({ ...x, name: r.name || x.name, mobile: r.mobile || x.mobile, email: r.email || x.email }));
      setFound(r.source ? (r.source === 'atom' ? 'Filled in from ATOM.' : 'Filled in from ITS.') : 'Not found — type the details.');
    } catch (err) {
      setError(errorMessage(err, 'Could not look up this ITS number.'));
    } finally {
      setLooking(false);
    }
  }

  // Bulk: read the lines, look up ITS-only lines (4 at a time), show the table.
  async function check() {
    setError('');
    const people = parsePeople(text);
    if (!people.length) return setError('Add one person per line.');
    if (people.length > 2000) return setError('Up to 2000 people at a time.');
    setBusy(true);
    const out = [...people];
    let i = 0;
    const worker = async () => {
      while (i < out.length) {
        const k = i;
        i += 1;
        if (!out[k].lookup) continue;
        try {
          const r = await lookupIts(out[k].its);
          out[k] = { ...out[k], name: r.name || out[k].name, mobile: r.mobile || '', email: r.email || '', missing: !r.name };
        } catch {
          out[k] = { ...out[k], missing: true };
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    setList(out.map((x) => ({ ...x, missing: x.missing || !x.name })));
    setBusy(false);
    return undefined;
  }

  async function give(people) {
    setBusy(true);
    setError('');
    try {
      const passes = await assignPasses(batch.id, { departmentId, people });
      onDone(passes);
      setP(blank);
      setFound(null);
      setText('');
      setList(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not give the passes.'));
    } finally {
      setBusy(false);
    }
  }

  if (!batches.length) return <p className="font-ui text-sm text-ink-3">No passes available to give right now.</p>;
  const need = list ? list.reduce((n, x) => n + (x.count || 1), 0) : Number(p.count) || 1;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="give-batch" label="From batch">
          <select id="give-batch" className={selectClass} value={batch.id} onChange={(e) => setBatchId(e.target.value)}>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} · {b.ssid} · {b.left} left
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-end gap-2" role="radiogroup" aria-label="How many people">
          {[
            ['one', 'One person', UserPlus],
            ['bulk', 'A list of people', Users],
          ].map(([k, label, Icon]) => (
            <button key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => setMode(k)} className={mode === k ? 'btn-primary' : 'btn-secondary'}>
              <Icon size={16} aria-hidden="true" /> {label}
            </button>
          ))}
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {mode === 'one' ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            give([{ ...p, count: Number(p.count) || 1 }]);
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <Field id="give-its" label="ITS number (optional)" hint={found || 'Fills in the name, mobile and email.'}>
              <TextInput id="give-its" inputMode="numeric" maxLength={8} value={p.its} onChange={set('its')} placeholder="8 digits" />
            </Field>
            <button type="button" className="btn-secondary mb-6" disabled={!/^\d{8}$/.test(p.its.trim()) || looking} onClick={find}>
              {looking ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Search size={16} aria-hidden="true" />} Find
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id="give-name" label="Name">
              <TextInput id="give-name" value={p.name} onChange={set('name')} maxLength={120} />
            </Field>
            <Field id="give-mobile" label="Mobile (for WhatsApp)">
              <TextInput id="give-mobile" inputMode="tel" value={p.mobile} onChange={set('mobile')} maxLength={20} />
            </Field>
            <Field id="give-email" label="Email">
              <TextInput id="give-email" type="email" value={p.email} onChange={set('email')} maxLength={120} />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field id="give-count" label="How many passes" hint="More than one for a group (e.g. a family).">
              <TextInput id="give-count" type="number" min="1" max="500" className="w-28" value={p.count} onChange={set('count')} />
            </Field>
            <button type="submit" className="btn-primary mb-6" disabled={busy || p.name.trim().length < 2}>
              {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />} Give {need} pass{need === 1 ? '' : 'es'}
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <Field
            id="give-list"
            label="People, one per line"
            hint="An ITS number (details are looked up), or: Name, Mobile, Email, Passes. You can paste from Excel."
          >
            <textarea
              id="give-list"
              rows={6}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setList(null);
              }}
              className="w-full rounded-btn border border-line bg-surface px-3 py-2 font-ui text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted"
              placeholder={'30301234\nAli Asgar, 9820012345, ali@example.com\nFamily group, 9819012345, , 4'}
            />
          </Field>
          {!list ? (
            <button type="button" className="btn-secondary" disabled={busy || !text.trim()} onClick={check}>
              {busy ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Search size={16} aria-hidden="true" />} Check the list
            </button>
          ) : (
            <>
              <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-card border border-line bg-surface font-ui text-sm">
                {list.map((x) => (
                  <li key={x.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className={x.missing ? 'text-error' : 'text-ink'}>
                      {x.name || (x.its ? `ITS ${x.its} — not found, type: Name, Mobile, Email` : 'Name missing')}
                    </span>
                    <span className="text-xs text-ink-3">{[x.mobile, x.email, `${x.count || 1} pass${(x.count || 1) === 1 ? '' : 'es'}`].filter(Boolean).join(' · ')}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || list.some((x) => x.missing)}
                onClick={() => give(list.map(({ its, name, mobile, email, count }) => ({ its, name, mobile, email, count })))}
              >
                {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />} Give {need} pass{need === 1 ? '' : 'es'} to {list.length} people
              </button>
            </>
          )}
        </div>
      )}
      {need > (batch.left ?? 0) && <p className="font-ui text-xs text-error">Only {batch.left} left in this batch.</p>}
    </div>
  );
}
