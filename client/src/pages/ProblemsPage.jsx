import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ListTree, LoaderCircle, Pencil, Plus, Power, PowerOff } from 'lucide-react';
import { createProblemRow, getProblemTree, setAutoAssign, updateProblemRow } from '../api/problems';
import { listOccupations } from '../api/staff';
import { errorMessage } from '../api/http';
import { Alert, Field, TextInput } from '../components/FormControls';
import Modal from '../components/Modal';
import useAuth from '../hooks/useAuth';

// Company Admin: the problem list people pick from when raising a ticket (Category > Item > Problem).
// Rows from the Support Log sync can be renamed or switched off here; ATOM edits are kept on re-sync
// unless the Super Admin syncs with "keep ATOM edits" unticked. Nothing is ever deleted.
const selectClass =
  'min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted disabled:opacity-60';

const ghost = 'inline-flex min-h-tap items-center gap-1 rounded-btn px-2 font-ui text-primary hover:bg-primary-tint disabled:opacity-60';

const LEVEL = {
  categories: { one: 'category', max: 60 },
  items: { one: 'item', max: 80 },
  problems: { one: 'problem', max: 80 },
};

// Add or rename one row.
function NameModal({ level, row, parent, onClose, onSaved }) {
  const [name, setName] = useState(row?.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { one, max } = LEVEL[level];

  async function save() {
    setBusy(true);
    setError('');
    try {
      if (row) await updateProblemRow(level, row.id, { name: name.trim() });
      else await createProblemRow(level, { name: name.trim(), ...parent });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, `Could not save this ${one}.`));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={row ? `Rename ${one}` : `Add ${one}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy || name.trim().length < 1}>
            {busy && <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />} Save
          </button>
        </>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      <Field id="row-name" label="Name">
        <TextInput id="row-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={max} />
      </Field>
      {row?.source === 'supportlog' && (
        <p className="font-ui text-xs text-ink-3">This came from the Support Log. Your change is kept when the list is synced again.</p>
      )}
    </Modal>
  );
}

function OffBadge() {
  return <span className="status-closed ml-2">Switched off</span>;
}

function RowActions({ row, onRename, onToggle, busy }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button type="button" className={ghost} onClick={onRename} disabled={busy} aria-label={`Rename ${row.name}`}>
        <Pencil size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={ghost}
        onClick={onToggle}
        disabled={busy}
        aria-label={row.isActive ? `Switch off ${row.name}` : `Switch on ${row.name}`}
        title={row.isActive ? 'Switch off' : 'Switch on'}
      >
        {row.isActive ? <PowerOff size={16} aria-hidden="true" /> : <Power size={16} aria-hidden="true" />}
      </button>
    </span>
  );
}

export default function ProblemsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const tree = useQuery({ queryKey: ['problems', 'admin'], queryFn: () => getProblemTree(true) });
  const occupations = useQuery({ queryKey: ['staff', 'occupations'], queryFn: () => listOccupations(false) });
  const [showOff, setShowOff] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [modal, setModal] = useState(null); // { level, row?, parent? }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: ['problems'] });
  const toggleOpen = (id) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function act(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errorMessage(err, 'Could not save the change.'));
    } finally {
      setBusy(false);
    }
  }

  const visible = (r) => showOff || r.isActive;
  const categories = (tree.data?.categories || []).filter(visible);
  const companyName = user?.company?.name || 'this company';

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl sm:text-3xl">
            <ListTree size={26} className="text-primary" aria-hidden="true" /> Problem list
          </h1>
          <p className="mt-1 font-ui text-sm text-ink-2">What people choose from when they raise a ticket in {companyName}: category, item, problem.</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setModal({ level: 'categories' })} disabled={busy}>
          <Plus size={16} aria-hidden="true" /> Add category
        </button>
      </header>

      {error && <Alert tone="error">{error}</Alert>}
      {tree.isError && <Alert tone="error">{errorMessage(tree.error, 'Could not load the problem list.')}</Alert>}

      {tree.data && (
        <section className="card space-y-3">
          <label className="flex items-start gap-3 font-ui text-sm text-ink">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-primary"
              checked={tree.data.autoAssign}
              disabled={busy}
              onChange={(e) => act(() => setAutoAssign(e.target.checked))}
            />
            <span>
              <span className="font-medium">Assign automatically</span>
              <span className="block text-ink-2">
                A new ticket in a category linked to an occupation goes straight to the staff member of that occupation with the fewest open jobs.
                If nobody is available it waits in the assign queue.
              </span>
            </span>
          </label>
          <label className="flex items-center gap-3 font-ui text-sm text-ink-2">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} />
            Show switched-off rows
          </label>
        </section>
      )}

      {tree.isPending && (
        <p className="flex items-center gap-2 font-ui text-sm text-ink-3">
          <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> Loading…
        </p>
      )}

      {tree.data && categories.length === 0 && <p className="card font-ui text-sm text-ink-3">No categories yet.</p>}

      <ul className="space-y-3">
        {categories.map((c) => {
          const items = c.items.filter(visible);
          const isOpen = open.has(c.id);
          return (
            <li key={c.id} className={`card ${c.isActive ? '' : 'opacity-70'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="flex min-h-tap min-w-0 flex-1 items-center gap-2 text-left" onClick={() => toggleOpen(c.id)} aria-expanded={isOpen}>
                  {isOpen ? <ChevronDown size={18} aria-hidden="true" /> : <ChevronRight size={18} aria-hidden="true" />}
                  <span className="truncate font-ui font-medium text-ink">{c.name}</span>
                  {!c.isActive && <OffBadge />}
                  <span className="shrink-0 font-ui text-xs text-ink-3">{items.length} items</span>
                </button>
                <RowActions
                  row={c}
                  busy={busy}
                  onRename={() => setModal({ level: 'categories', row: c })}
                  onToggle={() => act(() => updateProblemRow('categories', c.id, { isActive: !c.isActive }))}
                />
              </div>
              <div className="mt-2 sm:max-w-xs">
                <select
                  aria-label={`Occupation for ${c.name}`}
                  className={selectClass}
                  value={c.occupation?.id || ''}
                  disabled={busy || occupations.isPending}
                  onChange={(e) => act(() => updateProblemRow('categories', c.id, { occupationId: e.target.value || null }))}
                >
                  <option value="">No occupation (Admin assigns)</option>
                  {(occupations.data || []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>

              {isOpen && (
                <div className="mt-3 space-y-2 border-t border-line pt-3">
                  {items.map((i) => {
                    const probs = i.problems.filter(visible);
                    const iOpen = open.has(`i${i.id}`);
                    return (
                      <div key={i.id} className={`rounded-btn border border-line px-3 py-2 ${i.isActive ? '' : 'opacity-70'}`}>
                        <div className="flex items-center gap-2">
                          <button type="button" className="flex min-h-tap min-w-0 flex-1 items-center gap-2 text-left" onClick={() => toggleOpen(`i${i.id}`)} aria-expanded={iOpen}>
                            {iOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                            <span className="truncate font-ui text-sm text-ink">{i.name}</span>
                            {!i.isActive && <OffBadge />}
                            <span className="shrink-0 font-ui text-xs text-ink-3">{probs.length}</span>
                          </button>
                          <RowActions
                            row={i}
                            busy={busy}
                            onRename={() => setModal({ level: 'items', row: i })}
                            onToggle={() => act(() => updateProblemRow('items', i.id, { isActive: !i.isActive }))}
                          />
                        </div>
                        {iOpen && (
                          <ul className="mt-1 space-y-1 pl-6">
                            {probs.map((p) => (
                              <li key={p.id} className={`flex items-center gap-2 ${p.isActive ? '' : 'opacity-70'}`}>
                                <span className="min-w-0 flex-1 truncate font-ui text-sm text-ink-2">
                                  {p.name}
                                  {!p.isActive && <OffBadge />}
                                </span>
                                <RowActions
                                  row={p}
                                  busy={busy}
                                  onRename={() => setModal({ level: 'problems', row: p })}
                                  onToggle={() => act(() => updateProblemRow('problems', p.id, { isActive: !p.isActive }))}
                                />
                              </li>
                            ))}
                            <li>
                              <button type="button" className={`${ghost} text-sm`} onClick={() => setModal({ level: 'problems', parent: { itemId: i.id } })} disabled={busy}>
                                <Plus size={14} aria-hidden="true" /> Add problem
                              </button>
                            </li>
                          </ul>
                        )}
                      </div>
                    );
                  })}
                  <button type="button" className={`${ghost} text-sm`} onClick={() => setModal({ level: 'items', parent: { categoryId: c.id } })} disabled={busy}>
                    <Plus size={14} aria-hidden="true" /> Add item
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {modal && (
        <NameModal
          {...modal}
          onClose={() => setModal(null)}
          onSaved={async () => {
            setModal(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}
