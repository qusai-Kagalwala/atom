import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { listSyncRuns, runIdarahSync } from '../api/users';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import Modal from '../components/Modal';
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
};

function RunSummary({ run }) {
  const s = run.summary;
  if (!s?.users) return <span className="text-ink-2">{run.message || '—'}</span>;
  const skipped = Object.entries(s.skipped || {}).filter(([, n]) => n > 0);
  return (
    <div className="space-y-0.5">
      <p>
        People {s.users.inView} · new {s.users.created} · updated {s.users.updated} · back {s.users.reactivated} · left{' '}
        {s.users.deactivated}
      </p>
      <p className="text-ink-2">
        Departments {s.departments.total} · posts {s.posts.upserted}
        {s.columnsAdded?.length > 0 && ` · new columns: ${s.columnsAdded.join(', ')}`}
      </p>
      {skipped.length > 0 && (
        <p className="text-xs text-ink-3">Skipped: {skipped.map(([k, n]) => `${n} ${SKIP_LABELS[k] || k}`).join(', ')}</p>
      )}
      {run.message && <p className="text-xs text-ink-3">{run.message}</p>}
    </div>
  );
}

export default function SyncStatusPage() {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null); // { tone, message }
  const [confirmForce, setConfirmForce] = useState(false);

  const runs = useQuery({ queryKey: ['sync', 'runs'], queryFn: () => listSyncRuns(20), refetchInterval: running ? 2000 : false });
  const last = runs.data?.[0];
  const lastGood = runs.data?.find((r) => r.status === 'success');

  async function syncNow(force = false) {
    setConfirmForce(false);
    setRunning(true);
    setResult(null);
    try {
      const r = await runIdarahSync(force);
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
      queryClient.invalidateQueries({ queryKey: ['sync', 'runs'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
    }
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Super Admin</p>
          <h1 className="mt-1 text-3xl">Sync status</h1>
          <p className="mt-1 font-ui text-sm text-ink-2">
            People and departments from the Idarah view. Runs automatically about every 10 minutes once ATOM is on the server.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => syncNow(false)} disabled={running}>
          <RefreshCw size={18} className={running ? 'animate-spin' : ''} aria-hidden="true" />
          {running ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

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
          <p className="font-ui text-xs uppercase tracking-wider text-ink-3">People in view</p>
          <p className="mt-1 font-display text-2xl text-brown">{lastGood?.summary?.users?.inView ?? '—'}</p>
        </div>
      </div>

      {runs.isError && <Alert tone="error">{errorMessage(runs.error, 'Could not load sync runs.')}</Alert>}
      {runs.isPending && (
        <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
          <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading…
        </p>
      )}

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
            The view returned far fewer people than last time. Running anyway will <strong>deactivate everyone missing</strong> from
            it. Only do this if you know the change is real (for example, after the Hijri year postings were updated).
          </p>
        </Modal>
      )}
    </section>
  );
}
