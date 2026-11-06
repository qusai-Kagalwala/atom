import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FileUp, LoaderCircle, RotateCcw, Upload, Wifi, X } from 'lucide-react';
import {
  decideWifiRequest, getWifiMe, getWifiSettings, listBatches, listWifiRequests, resetBatch, saveWifiSettings, uploadBatch,
} from '../api/wifi';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import Modal from '../components/Modal';
import { Tabs } from '../components/RequestList';
import Countdown from '../components/wifi/Countdown';
import HodView from '../components/wifi/HodView';
import useAuth from '../hooks/useAuth';
import { formatDateTime } from '../utils/format';
import { expiryText } from '../utils/wifi';

const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

// AVIT Admin: upload a batch (Cisco ISE CSV) with SSID + expiry; preview first.
function UploadBatch({ onDone }) {
  const input = useRef(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(() => ({ name: '', ssid: '', expiresAt: localInput(new Date(Date.now() + 2 * 86400000)) }));
  const [file, setFile] = useState(null);
  const [skipErrors, setSkipErrors] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const set = (k) => (e) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setPreview(null);
  };

  async function run(commit) {
    setBusy(commit ? 'save' : 'preview');
    setError('');
    try {
      const r = await uploadBatch(file, { ...f, expiresAt: new Date(f.expiresAt).toISOString(), commit, skipErrors });
      if (commit) {
        onDone(r);
        setOpen(false);
        setPreview(null);
        setFile(null);
        setF((x) => ({ ...x, name: '' }));
      } else setPreview(r);
    } catch (err) {
      setError(errorMessage(err, 'Could not read the file.'));
    } finally {
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        <Upload size={18} aria-hidden="true" /> Upload a batch
      </button>
    );
  }
  const ready = file && f.name.trim() && f.ssid.trim() && f.expiresAt;
  return (
    <section className="card space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl">Upload a batch</h2>
          <p className="font-ui text-sm text-ink-2">
            The CSV from Cisco ISE with the header <code>Username,Password</code>, one account per row. On expiry the passes are deleted from ATOM.
          </p>
        </div>
        <button type="button" className="min-h-tap min-w-tap text-ink-3 hover:text-ink" aria-label="Close" onClick={() => setOpen(false)}>
          <X size={18} />
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field id="b-name" label="Batch name">
          <TextInput id="b-name" value={f.name} onChange={set('name')} maxLength={80} placeholder="e.g. Urs programme" />
        </Field>
        <Field id="b-ssid" label="Wi-Fi network (SSID)">
          <TextInput id="b-ssid" value={f.ssid} onChange={set('ssid')} maxLength={64} />
        </Field>
        <Field id="b-exp" label="Expires on" hint="All passes are deleted at this time.">
          <TextInput id="b-exp" type="datetime-local" value={f.expiresAt} onChange={set('expiresAt')} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={input}
          id="b-file"
          type="file"
          accept=".csv"
          className="sr-only"
          onChange={(e) => {
            setFile(e.target.files?.[0] || null);
            setPreview(null);
          }}
        />
        <label htmlFor="b-file" className="btn-secondary cursor-pointer">
          <FileUp size={18} aria-hidden="true" /> {file ? file.name : 'Choose .csv'}
        </label>
        <label className="flex min-h-tap items-center gap-2 font-ui text-sm">
          <input type="checkbox" checked={skipErrors} onChange={(e) => setSkipErrors(e.target.checked)} className="h-5 w-5 rounded border-line text-primary" />
          Skip rows with errors
        </label>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {preview && (
        <Alert tone={preview.errors.length && !skipErrors ? 'error' : 'info'}>
          Preview — nothing saved yet. {preview.rows} passes ready (first: {preview.sample.join(', ')})
          {preview.errors.length > 0 && ` · ${preview.errors.length} rows with errors: ${preview.errors.slice(0, 5).map((e) => `row ${e.row} ${e.message}`).join('; ')}`}.
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" disabled={!ready || Boolean(busy)} onClick={() => run(false)}>
          {busy === 'preview' && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Preview
        </button>
        {preview && (
          <button type="button" className="btn-primary" disabled={Boolean(busy) || (preview.errors.length > 0 && !skipErrors)} onClick={() => run(true)}>
            {busy === 'save' ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Check size={18} aria-hidden="true" />} Save {preview.rows} passes
          </button>
        )}
      </div>
    </section>
  );
}

function Bar({ c, total }) {
  const pct = (n) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-cream-dark" aria-hidden="true">
      <span className="bg-primary" style={{ width: pct(c.given) }} />
      <span className="bg-gold" style={{ width: pct(c.allocated - (c.deptGiven || 0)) }} />
    </div>
  );
}

function Batches() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['wifi', 'batches'], queryFn: listBatches, refetchInterval: 60_000 });
  const [resetting, setResetting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['wifi'] });

  async function doReset() {
    setBusy(true);
    try {
      await resetBatch(resetting.id);
      setMsg({ tone: 'success', text: `“${resetting.name}” ended — its passes were deleted.` });
      setResetting(null);
      refresh();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not reset.') });
    } finally {
      setBusy(false);
    }
  }

  const live = (q.data || []).filter((b) => !b.ended);
  const ended = (q.data || []).filter((b) => b.ended);
  return (
    <div className="space-y-4">
      <UploadBatch
        onDone={(r) => {
          setMsg({ tone: 'success', text: `${r.rows} passes saved.` });
          refresh();
        }}
      />
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {q.isPending && <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />}
      {q.isSuccess && !live.length && <p className="font-ui text-sm text-ink-2">No live batches. Upload one to start.</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        {live.map((b) => (
          <div key={b.id} className="card space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-ui text-xs uppercase tracking-wider text-ink-3">{b.ssid}</p>
                <h3 className="text-2xl">{b.name}</h3>
              </div>
              <Countdown to={b.expiresAt} />
            </div>
            <Bar c={b.counts} total={b.total} />
            <dl className="grid grid-cols-2 gap-2 font-ui text-sm sm:grid-cols-4">
              {[
                ['Total', b.total],
                ['Not allocated', b.counts.free],
                ['To departments', b.counts.allocated],
                ['Given out', b.counts.given],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-ink-3">{k}</dt>
                  <dd className="text-xl tabular-nums text-ink">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="font-ui text-xs text-ink-3">
              Expires {expiryText(b.expiresAt)} · uploaded by {b.createdBy}
            </p>
            <div className="flex flex-wrap gap-2">
              <Link to={`/wifi/batches/${b.id}`} className="btn-primary">
                <Wifi size={18} aria-hidden="true" /> Allocate & give
              </Link>
              <button type="button" className="btn-secondary text-error" onClick={() => setResetting(b)}>
                <RotateCcw size={18} aria-hidden="true" /> Reset
              </button>
            </div>
          </div>
        ))}
      </div>
      {ended.length > 0 && (
        <details className="card p-0 font-ui text-sm">
          <summary className="cursor-pointer px-4 py-3 font-medium">Ended batches ({ended.length})</summary>
          <ul className="divide-y divide-line border-t border-line">
            {ended.map((b) => (
              <li key={b.id} className="flex flex-wrap justify-between gap-2 px-4 py-2">
                <span>
                  {b.name} · {b.ssid}
                </span>
                <span className="text-ink-2">
                  {b.endedReason === 'reset' ? 'Reset' : 'Expired'} {formatDateTime(b.endedAt)} · {b.counts.given ?? 0} of {b.total} given
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {resetting && (
        <Modal
          title={`Reset “${resetting.name}”?`}
          onClose={() => setResetting(null)}
          busy={busy}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setResetting(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn-danger" onClick={doReset} disabled={busy}>
                {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />} Delete all {resetting.total} passes
              </button>
            </>
          }
        >
          <p className="font-ui text-sm text-ink-2">
            All usernames, passwords and who they were given to are deleted from ATOM now, even before the expiry. This can’t be undone. Remove the accounts in Cisco
            ISE too.
          </p>
        </Modal>
      )}
    </div>
  );
}

function Requests() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['wifi', 'requests'], queryFn: listWifiRequests });
  const [note, setNote] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  async function decide(r, status) {
    setBusy(r.id);
    setError('');
    try {
      queryClient.setQueryData(['wifi', 'requests'], await decideWifiRequest(r.id, { status, note: note[r.id] || '' }));
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'));
    } finally {
      setBusy(null);
    }
  }
  if (q.isPending) return <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />;
  if (!q.data?.length) return <p className="font-ui text-sm text-ink-2">No requests from departments.</p>;
  return (
    <div className="space-y-3">
      {error && <Alert tone="error">{error}</Alert>}
      <p className="font-ui text-sm text-ink-2">Allocate the passes from a batch (Allocate & give), then mark the request done.</p>
      <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface font-ui text-sm">
        {q.data.map((r) => (
          <li key={r.id} className="space-y-2 px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                <strong>{r.department.name}</strong> asks for <strong>{r.count}</strong> · {r.reason}
                <span className="block text-xs text-ink-3">
                  {r.by} · {formatDateTime(r.at)}
                </span>
              </span>
              {r.status !== 'open' && <span className={r.status === 'done' ? 'status-resolved' : 'status-rejected'}>{r.status === 'done' ? 'Done' : 'Declined'}</span>}
            </div>
            {r.status === 'open' && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  aria-label="Note"
                  className="min-h-tap flex-1 rounded-btn border border-line px-3"
                  placeholder="Note (needed to decline)"
                  value={note[r.id] || ''}
                  onChange={(e) => setNote((n) => ({ ...n, [r.id]: e.target.value }))}
                />
                <button type="button" className="btn-primary" disabled={busy === r.id} onClick={() => decide(r, 'done')}>
                  Done
                </button>
                <button type="button" className="btn-secondary" disabled={busy === r.id || !(note[r.id] || '').trim()} onClick={() => decide(r, 'declined')}>
                  Decline
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Settings() {
  const q = useQuery({ queryKey: ['wifi', 'settings'], queryFn: getWifiSettings });
  const [text, setText] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const queryClient = useQueryClient();
  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      queryClient.setQueryData(['wifi', 'settings'], await saveWifiSettings(text.split(',').map((s) => s.trim()).filter(Boolean)));
      setText(null);
      setMsg({ tone: 'success', text: 'Saved.' });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not save.') });
    } finally {
      setBusy(false);
    }
  }
  if (q.isPending) return <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />;
  const value = text ?? q.data.hodPosts.join(', ');
  const withHod = q.data.departments.filter((d) => d.hods);
  return (
    <div className="space-y-4">
      <section className="card space-y-3">
        <h2 className="text-xl">Who is a department’s HOD</h2>
        <p className="font-ui text-sm text-ink-2">Idarah posts (or post categories) that make someone the HOD, comma separated. Only HODs get the Jamea Internet Access page.</p>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <div className="flex flex-wrap gap-2">
          <TextInput id="hod-posts" value={value} onChange={(e) => setText(e.target.value)} className="max-w-md" aria-label="HOD posts" />
          <button type="button" className="btn-primary" disabled={busy || text == null} onClick={save}>
            Save
          </button>
        </div>
      </section>
      <section className="card space-y-2">
        <h2 className="text-xl">
          HODs found ({withHod.length} of {q.data.departments.length} departments)
        </h2>
        <ul className="max-h-96 divide-y divide-line overflow-y-auto font-ui text-sm">
          {q.data.departments.map((d) => (
            <li key={d.id} className="flex flex-wrap justify-between gap-2 py-1.5">
              <span>{d.name}</span>
              <span className={d.hods ? 'text-ink' : 'text-ink-3'}>{d.hods || 'No HOD found'}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// /wifi — AVIT Admin (batches, requests, settings) and/or department HOD (their passes).
export default function WifiPage() {
  const { user } = useAuth();
  const me = useQuery({ queryKey: ['wifi', 'me'], queryFn: getWifiMe });
  const [params, setParams] = useSearchParams();
  const [dep, setDep] = useState(null);
  const requests = useQuery({ queryKey: ['wifi', 'requests'], queryFn: listWifiRequests, enabled: Boolean(me.data?.isAdmin) });

  const isAdmin = Boolean(me.data?.isAdmin);
  const hods = me.data?.hodDepartments || [];
  const tabs = [
    ...(isAdmin ? [['batches', 'Batches'], ['requests', 'Requests']] : []),
    ...(hods.length ? [['department', hods.length > 1 ? 'My departments' : 'My department']] : []),
    ...(user.activeRole === 'SUPER_ADMIN' ? [['settings', 'HOD settings']] : []),
  ];
  const tab = tabs.some(([k]) => k === params.get('tab')) ? params.get('tab') : tabs[0]?.[0];
  const department = hods.find((d) => d.id === dep) || hods[0];

  if (me.isPending) return <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />;
  if (me.isError || !tabs.length) return <Alert tone="info">Jamea Internet Access is for AVIT Admins and department HODs.</Alert>;
  return (
    <section className="space-y-5">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">{isAdmin ? 'AVIT · Admin' : department?.name}</p>
        <h1 className="mt-1 flex items-center gap-2 text-3xl">
          <Wifi size={26} className="text-primary" aria-hidden="true" /> Jamea Internet Access
        </h1>
        <p className="mt-1 font-ui text-sm text-ink-2">
          {isAdmin ? 'Upload passes from Cisco ISE, share them out to departments, or give them to people directly.' : 'Give Jamea Internet Access to people and share it by WhatsApp or email. They are told it is valid for 10 days.'}
        </p>
      </div>
      {tabs.length > 1 && (
        <Tabs
          tabs={tabs}
          value={tab}
          onChange={(v) => setParams(v === tabs[0][0] ? {} : { tab: v })}
          counts={{ requests: (requests.data || []).filter((r) => r.status === 'open').length }}
        />
      )}
      {tab === 'batches' && <Batches />}
      {tab === 'requests' && <Requests />}
      {tab === 'settings' && <Settings />}
      {tab === 'department' && department && (
        <>
          {hods.length > 1 && (
            <select aria-label="Department" className="min-h-tap rounded-btn border border-line bg-surface px-3 font-ui text-sm" value={department.id} onChange={(e) => setDep(e.target.value)}>
              {hods.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
          <HodView key={department.id} department={department} />
        </>
      )}
    </section>
  );
}
