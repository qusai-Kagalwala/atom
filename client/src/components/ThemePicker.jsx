import { Check } from 'lucide-react';
import useTheme from '../hooks/useTheme';
import { MODES } from '../theme/modes';
import { MOTION_CHOICES } from '../theme/motionChoices';
import { THEMES } from '../theme/themes';

// A tiny picture of the app in a theme: sidebar bar, page, one card with a gold accent.
function Swatch({ preview }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-16 w-full overflow-hidden rounded-btn border border-line"
      style={{ background: preview.page }}
    >
      <span className="w-1/4" style={{ background: preview.bar }} />
      <span className="flex flex-1 items-center p-2">
        <span className="flex h-full w-full flex-col justify-center gap-1.5 rounded-sm px-2" style={{ background: preview.card }}>
          <span className="h-1.5 w-2/3 rounded-full" style={{ background: preview.bar }} />
          <span className="h-1.5 w-1/3 rounded-full bg-gold" />
        </span>
      </span>
    </span>
  );
}

// Colour theme + light/dark/auto. Saved on this device straight away.
export default function ThemePicker() {
  const { theme, mode, resolvedMode, sync, motion, setTheme, setMode, setMotion } = useTheme();

  return (
    <div className="space-y-5">
      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-ink-3">Colour</p>
        <div role="radiogroup" aria-label="Colour theme" className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {THEMES.map((t) => {
            const selected = theme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTheme(t.id)}
                className={`flex flex-col gap-2 rounded-btn border p-3 text-left transition-colors ${
                  selected ? 'border-brand bg-primary-tint' : 'border-line bg-surface hover:border-gold'
                }`}
              >
                <Swatch preview={t.preview[resolvedMode]} />
                <span className="flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block font-ui text-sm font-medium text-ink">{t.label}</span>
                    <span className="block truncate font-ui text-xs text-ink-2">{t.blurb}</span>
                  </span>
                  {selected && <Check size={18} className="shrink-0 text-brand" aria-hidden="true" />}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-ink-3">Brightness</p>
        <div role="radiogroup" aria-label="Light or dark" className="mt-2 inline-flex rounded-btn border border-line bg-surface p-1">
          {MODES.map(({ id, label, Icon }) => {
            const selected = mode === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setMode(id)}
                className={`flex min-h-tap items-center gap-2 rounded-btn px-4 font-ui text-sm transition-colors ${
                  selected ? 'bg-primary text-white' : 'text-ink hover:bg-cream-dark'
                }`}
              >
                <Icon size={18} aria-hidden="true" /> {label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 font-ui text-xs text-ink-3">Auto follows your device&apos;s light or dark setting.</p>
      </div>

      <div>
        <p className="font-ui text-xs uppercase tracking-wider text-ink-3">Animations</p>
        <div role="radiogroup" aria-label="Animations" className="mt-2 inline-flex rounded-btn border border-line bg-surface p-1">
          {MOTION_CHOICES.map(({ id, label }) => {
            const selected = motion === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setMotion(id)}
                className={`flex min-h-tap items-center rounded-btn px-4 font-ui text-sm transition-colors ${
                  selected ? 'bg-primary text-white' : 'text-ink hover:bg-cream-dark'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 font-ui text-xs text-ink-3">
          {MOTION_CHOICES.find((c) => c.id === motion)?.hint}. Saved on this device.
        </p>
      </div>

      {sync === 'device-only' && (
        <p role="status" className="font-ui text-xs text-warning">
          Saved on this device only. We couldn&apos;t save it to your account just now, so other devices won&apos;t pick it up yet.
        </p>
      )}
    </div>
  );
}
