import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

// Centred dialog on desktop, bottom sheet on phones. Escape or the backdrop closes it
// (unless `busy`). Focus moves into the dialog once on open, and back to the opener on close.
export default function Modal({ title, onClose, busy = false, children, footer }) {
  const panel = useRef(null);
  const latest = useRef({ onClose, busy });

  useEffect(() => {
    latest.current = { onClose, busy };
  }, [onClose, busy]);

  useEffect(() => {
    const opener = document.activeElement;
    const first = panel.current?.querySelector('input, select, textarea, button:not([data-close])');
    (first || panel.current)?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && !latest.current.busy) latest.current.onClose();
    };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className="absolute inset-0 bg-charcoal/40"
        onClick={() => !busy && onClose()}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-card bg-white shadow-xl sm:max-w-md sm:rounded-card"
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-xl">{title}</h2>
          <button
            type="button"
            data-close
            onClick={onClose}
            disabled={busy}
            className="flex min-h-tap min-w-tap items-center justify-center rounded-btn text-ink-3 hover:bg-cream-dark hover:text-ink disabled:opacity-50"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
