import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, LoaderCircle, RefreshCw, TriangleAlert, UserX } from 'lucide-react';
import { listOldAccounts, listSyncRuns, runItemsSync, runSync } from '../api/users';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import Modal from '../components/Modal';
import { Tabs } from '../components/RequestList';
import { formatDateTime, formatDuration } from '../utils/format';

const STATUS = {
  success: { label: 'Success', cls: 'status-resolved' },
  blocked: { label: 'Blocked', cls: 'status-waiting' },
  failed: { label: 'Failed', cls: 'status-rejected' },
  running: { label: 'Running', cls: 'status-in-progress' },
};

const SKIP_LABELS = {
  no_idarah_id: 'no Idarah',
  invalid_ejamaat_no: 'invalid ITS number',
  no_person_id: 'no ITS / employee ID',
  employee_id_not_in_atom: 'employee ID not in ATOM',
  no_department: 'no department',
  invalid_user_id: 'invalid user ID',
  no_room: 'no room number',
};

// Two syncs (Phase 3.1): the Idarah view (ITS people, posts) and the HR employee list
// (employee-ID staff, department locations). Both run in the same scheduled job.
const JOBS = {
  idarah: {
    tab: 'Idarah view',
    text: 'ITS people, their posts and departments, from the Idarah view.',
    peopleLabel: 'People in view',
    people: (s) => s?.users?.inView,
  },
  hr: {
    tab: 'HR employee list',
    text: 'Employee-ID staff and department locations, from the HR employee list. New staff get their Employee ID as a temporary password.',
    peopleLabel: 'Staff in list',
    people: (s) => s?.staff?.inView,
  },
  occupancy: {
    tab: 'Room occupancy',
    text: 'Who sits in which room / cubicle, from the occupancy Google Sheet. Equipment at a seat shows on that person’s My assets.',
    peopleLabel: 'People with a seat',
    people: (s) => s?.seats?.people,
    schedule: 'Runs automatically once a day once ATOM is on the server.',
    forceText: 'returned far fewer seats than last time. Running anyway will end the seats of everyone missing from it.',
  },
  items: {
    tab: 'Support Log items',
    text: 'Problem lists and the request catalogue from the Support Log (Item_Master): AVIT and Siyanaat get Category › Item › Problem, Tanzeem gets its catalogue with price, pack size and stock.',
    peopleLabel: 'Rows used',
    people: (s) => (s?.companies ? Object.values(s.companies).reduce((n, c) => n + (c.valid || 0), 0) : undefined),
    schedule: 'Runs automatically once a night once ATOM is on the server. Preview first to see what would change.',
    custom: true,
  },
};

const COMPANIES = [
  ['AVIT', 'AVIT', 'problem list'],
  ['SIYANAAT', 'Siyanaat', 'problem list'],
  ['TANZEEM', 'Tanzeem', 'catalogue, prices, stock'],
];

// One company's line in an items run (or preview).
function ItemsCompany({ code, c }) {
  const n = c.problems || c.catalogue;
  const what = c.problems ? 'problems' : 'catalogue items';
  return (
    <div>
      <p>
        <span className="font-medium">{c.name || code}</span> · {c.valid} of {c.rows} rows used
        {c.inactive > 0 && ` (${c.inactive} switched off in the Support Log)`}
      </p>
      {n && (
        <p className="text-ink-2">
          {what}: new {n.created} · changed {n.updated} · same {n.unchanged} · switched off {n.switchedOff + (n.missing || 0)}
          {n.kept > 0 && ` · ATOM edits kept ${n.kept}`}
          {c.categoriesCreated > 0 && ` · new categories ${c.categoriesCreated}`}
          {c.itemsCreated > 0 && ` · new items ${c.itemsCreated}`}
          {n.stockSet > 0 && ` · stock set ${n.stockSet}`}
          {n.stockKept > 0 && ` · stock kept ${n.stockKept}`}
        </p>
      )}
      {c.duplicates > 0 && (
        <p className="text-xs text-ink-3">
          Duplicates skipped {c.duplicates}
          {c.duplicateSample?.length > 0 && `: ${c.duplicateSample.map((d) => d.name).join('; ')}${c.duplicates > c.duplicateSample.length ? '; …' : ''}`}
        </p>
      )}
      {c.errors?.length > 0 && <p className="text-xs text-error">Rows with problems: {c.errors.map((e) => `#${e.legacyId ?? '?'} ${e.message}`).join('; ')}</p>}
    </div>
  );
}

// Super Admin: preview or sync the Support Log items for all companies or some of them.
function ItemsSyncPanel({ onDone }) {
  const [chosen, setChosen] = useState(() => new Set(COMPANIES.map(([c]) => c)));
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(null); // 'preview' | 'sync'
  const [result, setResult] = useState(null);
  const [confirmForce, setConfirmForce] = useState(false);

  async function go(preview, force = false) {
    setConfirmForce(false);
    setBusy(preview ? 'preview' : 'sync');
    setResult(null);
    try {
      const r = await runItemsSync({ companies: [...chosen], keepAtomEdits: keep, preview, force });
      setResult(r);
    } catch (err) {
      setResult({ status: 'failed', message: errorMessage(err, 'Could not start the sync.') });
    } finally {
      setBusy(null);
      if (!preview) onDone();
    }
  }

  const toggle = (code) =>
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });
  const tone = result?.status === 'success' ? 'success' : result?.status === 'busy' ? 'info' : 'error';

  return (
    <div className="card space-y-4">
      <fieldset>
        <legend className="font-ui text-sm font-medium text-ink">Companies</legend>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
          {COMPANIES.map(([code, name, what]) => (
            <label key={code} className="flex min-h-tap items-center gap-2 font-ui text-sm text-ink">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={chosen.has(code)} onChange={() => toggle(code)} disabled={Boolean(busy)} />
              {name} <span className="text-ink-3">({what})</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-start gap-2 font-ui text-sm text-ink">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={keep} onChange={(e) => setKeep(e.target.checked)} disabled={Boolean(busy)} />
        <span>
          Keep changes made in ATOM
          <span className="block text-ink-2">Names, switched-off rows, prices and stock that Admins changed in ATOM stay. Untick to overwrite them with the Support Log.</span>
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" onClick={() => go(true)} disabled={Boolean(busy) || chosen.size === 0}>
          {busy === 'preview' ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />} Preview
        </button>
        <button type="button" className="btn-primary" onClick={() => go(false)} disabled={Boolean(busy) || chosen.size === 0}>
          <RefreshCw size={18} className={busy === 'sync' ? 'animate-spin' : ''} aria-hidden="true" /> {busy === 'sync' ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {result && (
        <Alert tone={tone}>
          {result.status === 'success'
            ? result.preview
              ? 'Preview only — nothing was saved. This is what Sync now would do:'
              : `Sync finished: ${result.counts.validRows} of ${result.counts.sourceRows} rows used.`
            : result.message || 'Sync did not complete.'}
          {result.status === 'blocked' && (
            <button type="button" className="ml-2 font-medium underline" onClick={() => setConfirmForce(true)}>
              Run anyway…
            </button>
          )}
        </Alert>
      )}
      {result?.summary?.companies && (
        <div className="space-y-3 font-ui text-sm">
          {Object.entries(result.summary.companies).map(([code, c]) => (
            <ItemsCompany key={code} code={code} c={c} />
          ))}
        </div>
      )}

      {confirmForce && (
        <Modal
          title="Run the sync anyway?"
          onClose={() => setConfirmForce(false)}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setConfirmForce(false)}>
                Cancel
              </button>
              <button type="button" className="btn-danger" onClick={() => go(false, true)}>
                <TriangleAlert size={18} aria-hidden="true" /> Run anyway
              </button>
            </>
          }
        >
          <p className="font-ui text-sm text-ink-2">
            The Support Log returned far fewer rows than last time. Running anyway will <strong>switch off everything missing</strong> from it. Only do this
            if you know the change is real.
          </p>
        </Modal>
      )}
    </div>
  );
}

function RunSummary({ run }) {
  const s = run.summary;
  if (s?.companies) {
    return (
      <div className="space-y-2">
        {Object.entries(s.companies).map(([code, c]) => (
          <ItemsCompany key={code} code={code} c={c} />
        ))}
        {s.keepAtomEdits === false && <p className="text-xs text-ink-3">ATOM edits overwritten.</p>}
        {run.message && <p className="text-xs text-ink-3">{run.message}</p>}
      </div>
    );
  }
  if (!s?.users && !s?.staff && !s?.seats) return <span className="text-ink-2">{run.message || '—'}</span>;
  const skipped = Object.entries(s.skipped || {}).filter(([, n]) => n > 0);
  return (
    <div className="space-y-0.5">
      {s.users && (
        <>
          <p>
            People {s.users.inView} · new {s.users.created} · updated {s.users.updated} · back {s.users.reactivated} · left{' '}
            {s.users.deactivated}
          </p>
          <p className="text-ink-2">
            Departments {s.departments.total} · posts {s.posts.upserted}
            {s.columnsAdded?.length > 0 && ` · new columns: ${s.columnsAdded.join(', ')}`}
          </p>
        </>
      )}
      {s.staff && (
        <>
          <p>
            Staff {s.staff.inView} · new {s.staff.created} · renamed {s.staff.updated} · back {s.staff.reactivated} · left{' '}
            {s.staff.deactivated}
          </p>
          <p className="text-ink-2">
            Departments {s.departments.total} ({s.departments.withLocation} with location) · imported accounts matched{' '}
            {s.staff.legacyMatched}
            {s.columnsAdded?.length > 0 && ` · new columns: ${s.columnsAdded.join(', ')}`}
          </p>
        </>
      )}
      {s.seats && (
        <>
          <p>
            Seats {s.seats.seats} for {s.seats.people} people · new {s.seats.created} · ended {s.seats.ended}
            {s.source === 'file' && ' · from a CSV file'}
          </p>
          {(s.seats.unknownPeople > 0 || s.seats.inactivePeople > 0) && (
            <p className="text-ink-2">
              Not in ATOM: {s.seats.unknownPeople}
              {s.seats.unknownSample?.length > 0 && ` (${s.seats.unknownSample.join(', ')}${s.seats.unknownPeople > s.seats.unknownSample.length ? ', …' : ''})`}
              {s.seats.inactivePeople > 0 && ` · inactive users: ${s.seats.inactivePeople}`}
            </p>
          )}
          {s.seats.roomsWithoutPlace > 0 && (
            <p className="text-ink-2">
              Rooms with no place in Inventory: {s.seats.roomsWithoutPlace} ({s.seats.roomSample.join(', ')}
              {s.seats.roomsWithoutPlace > s.seats.roomSample.length ? ', …' : ''})
            </p>
          )}
        </>
      )}
      {skipped.length > 0 && (
        <p className="text-xs text-ink-3">Skipped: {skipped.map(([k, n]) => `${n} ${SKIP_LABELS[k] || k}`).join(', ')}</p>
      )}
      {run.message && <p className="text-xs text-ink-3">{run.message}</p>}
    </div>
  );
}

// Imported Login_Master accounts that are active in ATOM but not in the HR list (Super Admin decides).
function OldAccounts() {
  const query = useQuery({ queryKey: ['sync', 'old-accounts'], queryFn: listOldAccounts });
  if (query.isPending) return null;
  if (query.isError) return <Alert tone="error">Could not load the old accounts.</Alert>;
  const { checkedAt, accounts } = query.data;
  if (!checkedAt) return null;

  return (
    <div className="card p-0">
      <div className="border-b border-line px-4 py-3">
        <h2 className="flex items-center gap-2 text-xl">
          <UserX size={20} className="text-ink-3" aria-hidden="true" /> Old accounts not in the HR list ({accounts.length})
        </h2>
        <p className="mt-1 font-ui text-sm text-ink-2">
          Imported from the old login table but not active employees. They can still sign in. Open each one and deactivate it, or
          keep it.
        </p>
      </div>
      {accounts.length === 0 ? (
        <p className="px-4 py-3 font-ui text-sm text-ink-3">None. Every imported account is in the HR list.</p>
      ) : (
        <ul className="divide-y divide-line">
          {accounts.map((a) => (
            <li key={a.id}>
              <Link to={`/users/${a.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 font-ui text-sm hover:bg-gold-muted">
                <span className="font-medium tabular-nums text-ink">Employee ID {a.employee_id}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{a.name || 'No name on file'}</span>
                <span className="text-xs text-ink-3">{a.last_ticket_at ? `Last ticket ${formatDateTime(a.last_ticket_at)}` : 'No tickets'}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function SyncStatusPage() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const job = JOBS[params.get('job')] ? params.get('job') : 'idarah';
  const meta = JOBS[job];
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null); // { tone, message, blocked }
  const [confirmForce, setConfirmForce] = useState(false);

  const runs = useQuery({
    queryKey: ['sync', 'runs', job],
    queryFn: () => listSyncRuns(job, 20),
    refetchInterval: running ? 2000 : false,
  });
  const last = runs.data?.[0];
  const lastGood = runs.data?.find((r) => r.status === 'success');

  async function syncNow(force = false) {
    setConfirmForce(false);
    setRunning(true);
    setResult(null);
    try {
      const r = await runSync(job, force);
      const tone = r.status === 'success' ? 'success' : r.status === 'busy' ? 'info' : 'error';
      const message =
        r.status === 'success'
          ? `Sync finished: ${r.counts.validRows} of ${r.counts.sourceRows} rows used.`
          : r.message || 'Sync did not complete.';
      setResult({ tone, message, blocked: r.status === 'blocked' });
    } catch (err) {
      setResult({ tone: 'error', message: errorMessage(err, 'Could not start the sync.') });
    } finally {
      setRunning(false);
      queryClient.invalidateQueries({ queryKey: ['sync'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
    }
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Super Admin</p>
          <h1 className="mt-1 text-3xl">Sync status</h1>
          <p className="mt-1 font-ui text-sm text-ink-2">{meta.schedule || 'The people syncs run automatically about every 10 minutes once ATOM is on the server.'}</p>
        </div>
        {!meta.custom && (
          <button type="button" className="btn-primary" onClick={() => syncNow(false)} disabled={running}>
            <RefreshCw size={18} className={running ? 'animate-spin' : ''} aria-hidden="true" />
            {running ? 'Syncing…' : `Sync ${meta.tab} now`}
          </button>
        )}
      </div>

      <Tabs
        tabs={Object.entries(JOBS).map(([k, j]) => [k, j.tab])}
        value={job}
        onChange={(v) => {
          setResult(null);
          setParams(v === 'idarah' ? {} : { job: v });
        }}
      />
      <p className="font-ui text-sm text-ink-2">{meta.text}</p>

      {result && (
        <Alert tone={result.tone}>
          {result.message}
          {result.blocked && (
            <button type="button" className="ml-2 font-medium underline" onClick={() => setConfirmForce(true)}>
              Run anyway…
            </button>
          )}
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <p className="font-ui text-xs uppercase tracking-wider text-ink-3">Last run</p>
          <p className="mt-1 font-ui text-sm text-ink">{last ? formatDateTime(last.started_at) : 'Never'}</p>
          {last && <span className={`mt-1 ${STATUS[last.status]?.cls || 'badge'}`}>{STATUS[last.status]?.label || last.status}</span>}
        </div>
        <div className="card p-4">
          <p className="font-ui text-xs uppercase tracking-wider text-ink-3">Last successful run</p>
          <p className="mt-1 font-ui text-sm text-ink">{lastGood ? formatDateTime(lastGood.started_at) : 'None yet'}</p>
        </div>
        <div className="card p-4">
          <p className="font-ui text-xs uppercase tracking-wider text-ink-3">{meta.peopleLabel}</p>
          <p className="mt-1 font-display text-2xl text-brown">{meta.people(lastGood?.summary) ?? '—'}</p>
        </div>
      </div>

      {job === 'items' && <ItemsSyncPanel onDone={() => queryClient.invalidateQueries({ queryKey: ['sync'] })} />}

      {job === 'hr' && <OldAccounts />}

      {runs.isError && <Alert tone="error">{errorMessage(runs.error, 'Could not load sync runs.')}</Alert>}
      {runs.isPending && (
        <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
          <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading…
        </p>
      )}
      {runs.isSuccess && runs.data.length === 0 && <p className="font-ui text-sm text-ink-3">No runs yet.</p>}

      {runs.data?.length > 0 && (
        <div className="card p-0">
          <h2 className="border-b border-line px-4 py-3 text-xl">Recent runs</h2>
          <ul className="divide-y divide-line">
            {runs.data.map((run) => (
              <li key={run.id} className="grid gap-2 px-4 py-3 font-ui text-sm sm:grid-cols-[11rem_1fr]">
                <div>
                  <span className={STATUS[run.status]?.cls || 'badge'}>{STATUS[run.status]?.label || run.status}</span>
                  {run.forced && <span className="badge ml-1 bg-warning-bg text-warning">Forced</span>}
                  <p className="mt-1 text-xs text-ink-3">
                    {formatDateTime(run.started_at)} · {formatDuration(run.started_at, run.finished_at)}
                  </p>
                  <p className="text-xs text-ink-3">{run.triggered_by_name ? `By ${run.triggered_by_name}` : 'Scheduled / command line'}</p>
                </div>
                <RunSummary run={run} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirmForce && (
        <Modal
          title="Run the sync anyway?"
          onClose={() => setConfirmForce(false)}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setConfirmForce(false)}>
                Cancel
              </button>
              <button type="button" className="btn-danger" onClick={() => syncNow(true)}>
                <TriangleAlert size={18} aria-hidden="true" /> Run anyway
              </button>
            </>
          }
        >
          <p className="font-ui text-sm text-ink-2">
            {meta.forceText ? (
              <>The {meta.tab.toLowerCase()} sheet {meta.forceText} </>
            ) : (
              <>
                The {meta.tab.toLowerCase()} returned far fewer people than last time. Running anyway will{' '}
                <strong>deactivate everyone missing</strong> from it.{' '}
              </>
            )}
            Only do this if you know the change is real.
          </p>
        </Modal>
      )}
    </section>
  );
}
