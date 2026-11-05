import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, LoaderCircle, Save, Search } from 'lucide-react';
import { allocate, getBatch, listPasses } from '../api/wifi';
import { errorMessage } from '../api/http';
import { Alert } from '../components/FormControls';
import { Pager, Tabs } from '../components/RequestList';
import Countdown from '../components/wifi/Countdown';
import GivePasses from '../components/wifi/GivePasses';
import PassList from '../components/wifi/PassList';

const PAGE = 50;

// AVIT Admin: one batch — allocate to departments in buckets, give passes directly, see who got them.
export default function WifiBatchPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['wifi', 'batch', id], queryFn: () => getBatch(id) });
  const [targets, setTargets] = useState({});
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [fresh, setFresh] = useState(null);
  const [view, setView] = useState('given');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const passes = useQuery({
    queryKey: ['wifi', 'passes', id, view, search, page],
    queryFn: () => listPasses(id, { view, q: search || undefined, page, pageSize: PAGE }),
    placeholderData: keepPreviousData,
    enabled: q.isSuccess,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['wifi'] });

  const departments = useMemo(() => {
    const term = find.trim().toLowerCase();
    return (q.data?.departments || []).filter((d) => !term || `${d.name} ${d.hods || ''}`.toLowerCase().includes(term));
  }, [q.data, find]);

  if (q.isPending) return <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />;
  if (q.isError) {
    return (
      <section className="space-y-3">
        <Link to="/wifi" className="inline-flex min-h-tap items-center gap-1 font-ui text-sm text-primary hover:underline">
          <ArrowLeft size={16} aria-hidden="true" /> Jamea Internet Access
        </Link>
        <Alert tone="error">{errorMessage(q.error, 'This batch is not available.')}</Alert>
      </section>
    );
  }
  const { batch } = q.data;
  const c = batch.counts;
  const changed = Object.entries(targets).filter(([dep, v]) => v !== '' && Number(v) !== q.data.departments.find((d) => d.id === dep)?.allocated);
  const plannedFree = c.free - changed.reduce((n, [dep, v]) => n + (Number(v) - (q.data.departments.find((d) => d.id === dep)?.allocated || 0)), 0);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      queryClient.setQueryData(['wifi', 'batch', id], await allocate(id, changed.map(([departmentId, v]) => ({ departmentId, count: Number(v) }))));
      setTargets({});
      setMsg({ tone: 'success', text: 'Allocation saved. The HODs were notified.' });
      refresh();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err, 'Could not save the allocation.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-5">
      <Link to="/wifi" className="inline-flex min-h-tap items-center gap-1 font-ui text-sm text-primary hover:underline">
        <ArrowLeft size={16} aria-hidden="true" /> Jamea Internet Access
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">{batch.ssid}</p>
          <h1 className="mt-1 text-3xl">{batch.name}</h1>
        </div>
        <Countdown to={batch.expiresAt} />
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          ['Total', batch.total],
          ['Left (not allocated)', c.free],
          ['To departments', c.allocated],
          ['Given by departments', c.deptGiven],
          ['Given by AVIT', c.adminGiven],
        ].map(([k, v]) => (
          <div key={k} className="card p-4">
            <dt className="font-ui text-xs text-ink-3">{k}</dt>
            <dd className="font-display text-2xl tabular-nums text-ink">{v}</dd>
          </div>
        ))}
      </dl>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-xl">Allocate to departments</h2>
            <p className="font-ui text-sm text-ink-2">Type how many passes each department should have from this batch. Lower it to take unused passes back.</p>
          </div>
          <label className="relative">
            <span className="sr-only">Find a department</span>
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
            <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Department or HOD" className="min-h-tap rounded-btn border border-line bg-white pl-9 pr-3 font-ui text-sm" />
          </label>
        </div>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <div className="max-h-[28rem] overflow-y-auto rounded-card border border-line">
          <table className="w-full font-ui text-sm">
            <thead className="sticky top-0 bg-cream-dark text-left text-xs uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-2">Department</th>
                <th className="hidden px-3 py-2 sm:table-cell">HOD</th>
                <th className="px-3 py-2 text-right">Given</th>
                <th className="px-3 py-2 text-right">Allocated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line bg-white">
              {departments.map((d) => (
                <tr key={d.id}>
                  <td className="px-3 py-1.5">
                    {d.name}
                    <span className="block text-xs text-ink-3 sm:hidden">{d.hods || 'No HOD'}</span>
                  </td>
                  <td className={`hidden px-3 py-1.5 sm:table-cell ${d.hods ? '' : 'text-ink-3'}`}>{d.hods || 'No HOD'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-ink-2">{d.given}</td>
                  <td className="px-3 py-1.5 text-right">
                    <input
                      type="number"
                      min={d.given}
                      aria-label={`Passes for ${d.name}`}
                      className="min-h-tap w-24 rounded-btn border border-line px-2 text-right tabular-nums"
                      value={targets[d.id] ?? d.allocated}
                      onChange={(e) => setTargets((t) => ({ ...t, [d.id]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={`font-ui text-sm ${plannedFree < 0 ? 'text-error' : 'text-ink-2'}`}>
            {plannedFree < 0 ? `${-plannedFree} more than are left` : `${plannedFree} will be left unallocated`}
          </p>
          <button type="button" className="btn-primary" disabled={busy || !changed.length || plannedFree < 0} onClick={save}>
            {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Save size={18} aria-hidden="true" />} Save allocation
          </button>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="text-xl">Give passes directly</h2>
        <p className="font-ui text-sm text-ink-2">From the passes not allocated to a department.</p>
        <GivePasses
          batches={[{ id: batch.id, name: batch.name, ssid: batch.ssid, left: c.free }]}
          onDone={(p) => {
            setFresh(p);
            refresh();
          }}
        />
      </section>

      {fresh && (
        <section className="card space-y-3 border-primary">
          <h2 className="text-xl">Just given — share them now</h2>
          <PassList passes={fresh} onChanged={refresh} />
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="text-xl">Passes given</h2>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            tabs={[
              ['given', 'All given'],
              ['admin', 'Given by AVIT'],
            ]}
            value={view}
            onChange={(v) => {
              setView(v);
              setPage(1);
            }}
          />
          <input
            type="search"
            aria-label="Search passes"
            placeholder="Name, ITS, mobile or username"
            className="min-h-tap rounded-btn border border-line bg-white px-3 font-ui text-sm"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {passes.data && (
          <>
            <PassList passes={passes.data.passes} onChanged={refresh} showDepartment />
            <Pager page={page} total={passes.data.total} pageSize={PAGE} onPage={setPage} />
          </>
        )}
      </section>
    </section>
  );
}
