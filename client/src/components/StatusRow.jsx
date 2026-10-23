import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';

const STATE_STYLES = {
  loading: { Icon: LoaderCircle, className: 'text-ink-3 animate-spin', label: 'Checking…' },
  ok: { Icon: CircleCheck, className: 'text-success', label: 'OK' },
  fail: { Icon: CircleX, className: 'text-error', label: 'Failed' },
};

export default function StatusRow({ icon: RowIcon, label, state, detail }) {
  const { Icon, className, label: stateLabel } = STATE_STYLES[state] ?? STATE_STYLES.loading;

  return (
    <li className="flex min-h-tap items-center gap-3 border-b border-line py-3 last:border-b-0">
      <RowIcon size={20} className="shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-ui text-sm font-medium text-ink">{label}</p>
        {detail && <p className="truncate font-ui text-xs text-ink-2">{detail}</p>}
      </div>
      <span className="flex items-center gap-1.5 font-ui text-xs text-ink-2">
        <Icon size={18} className={className} aria-hidden="true" />
        {stateLabel}
      </span>
    </li>
  );
}
