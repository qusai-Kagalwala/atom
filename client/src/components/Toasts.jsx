import { useSyncExternalStore } from 'react';
import { Bell, X } from 'lucide-react';
import useOpenNotification from '../hooks/useOpenNotification';
import { dismissToast, getToasts, subscribeToasts } from '../utils/toasts';

// Pop-ups for new notifications. Bottom on phones, bottom-right on desktop. Announced politely.
export default function Toasts() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const openNotification = useOpenNotification();

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-3 bottom-3 z-[60] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-4 sm:w-96"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto flex items-start gap-3 rounded-card border border-line bg-white p-3 font-ui shadow-lg"
        >
          <Bell size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">{t.title}</p>
            {t.body && <p className="mt-0.5 truncate text-xs text-ink-2">{t.body}</p>}
            {t.link && (
              <button
                type="button"
                onClick={() => {
                  dismissToast(t.id);
                  openNotification({ id: t.notificationId, link: t.link, read: false });
                }}
                className="mt-1 text-xs font-medium text-primary hover:underline"
              >
                Open
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
            className="-m-1 flex min-h-tap min-w-tap shrink-0 items-center justify-center rounded-btn text-ink-3 hover:text-ink"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
