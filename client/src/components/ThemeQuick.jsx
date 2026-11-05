import { Palette } from 'lucide-react';
import useTheme from '../hooks/useTheme';
import { MODES } from '../theme/modes';
import { THEMES } from '../theme/themes';

// Compact version for the user menu: three colour dots and light / dark / auto.
export default function ThemeQuick() {
  const { theme, mode, resolvedMode, setTheme, setMode } = useTheme();

  return (
    <div className="border-b border-line px-4 py-3">
      <p className="flex items-center gap-1.5 pb-2 text-xs uppercase tracking-wider text-ink-3">
        <Palette size={14} aria-hidden="true" /> Appearance
      </p>
      <div className="flex items-center justify-between gap-2">
        <div role="radiogroup" aria-label="Colour theme" className="flex gap-2">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={theme === t.id}
              aria-label={t.label}
              title={t.label}
              onClick={() => setTheme(t.id)}
              className={`h-9 w-9 rounded-full border border-line transition-shadow ${
                theme === t.id ? 'ring-2 ring-brand ring-offset-2 ring-offset-surface' : 'hover:ring-2 hover:ring-gold hover:ring-offset-2 hover:ring-offset-surface'
              }`}
              style={{ background: t.preview[resolvedMode].bar }}
            />
          ))}
        </div>
        <div role="radiogroup" aria-label="Light or dark" className="flex rounded-btn border border-line p-0.5">
          {MODES.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              aria-label={label}
              title={label}
              onClick={() => setMode(id)}
              className={`flex h-9 w-9 items-center justify-center rounded-btn transition-colors ${
                mode === id ? 'bg-primary text-white' : 'text-ink-2 hover:bg-cream-dark'
              }`}
            >
              <Icon size={18} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
