import { useState } from 'react';
import { PRESETS, presetRange } from '../utils/period';

const inputClass =
  'min-h-tap rounded-btn border border-line bg-surface px-3 font-ui text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-primary-muted';

// Period for analytics and reports: presets, or two dates. value = { preset, from, to } (initialPeriod).

export default function PeriodPicker({ value, onChange }) {
  const [draft, setDraft] = useState({ from: value.from, to: value.to });
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="sr-only">Period</span>
        <select
          className={inputClass}
          value={value.preset}
          onChange={(e) => {
            const preset = e.target.value;
            if (preset === 'custom') onChange({ ...value, preset });
            else onChange({ preset, ...presetRange(preset) });
          }}
        >
          {PRESETS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {value.preset === 'custom' && (
        <>
          <label className="block font-ui text-xs text-ink-2">
            From
            <input type="date" className={`${inputClass} block`} value={draft.from} max={draft.to} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
          </label>
          <label className="block font-ui text-xs text-ink-2">
            To
            <input type="date" className={`${inputClass} block`} value={draft.to} min={draft.from} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
          </label>
          <button
            type="button"
            className="btn-secondary"
            disabled={!draft.from || !draft.to || draft.from > draft.to}
            onClick={() => onChange({ preset: 'custom', from: draft.from, to: draft.to })}
          >
            Apply
          </button>
        </>
      )}
    </div>
  );
}
