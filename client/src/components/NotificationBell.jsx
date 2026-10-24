import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, LoaderCircle } from 'lucide-react';
import { listNotifications, markAllNotificationsRead } from '../api/notifications';
import useOpenNotification from '../hooks/useOpenNotification';
import useUnreadCount from '../hooks/useUnreadCount';
import NotificationItem from './NotificationItem';

// Header bell: unread badge + the 8 newest notifications.
export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const ref = useRef(null);
  const queryClient = useQueryClient();
  const openNotification = useOpenNotification();
  const unread = useUnreadCount();

  const recent = useQuery({
    queryKey: ['notifications', 'recent'],
    queryFn: () => listNotifications({ pageSize: 8 }),
    enabled: open,
    staleTime: 0,
  });

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function markAll() {
    setMarking(true);
    try {
      await markAllNotificationsRead();
    } catch {
      /* the list just stays as it is */
    } finally {
      setMarking(false);
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    }
  }

  const items = recent.data?.notifications || [];
  const label = unread ? `Notifications, ${unread} unread` : 'Notifications';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        className="relative flex min-h-tap min-w-tap items-center justify-center rounded-btn text-white hover:bg-primary-dark"
      >
        <Bell size={20} aria-hidden="true" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 min-w-[1.25rem] rounded-full bg-gold px-1 text-center font-ui text-[11px] font-bold leading-5 text-gold-on"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-card border border-line bg-white font-ui text-ink shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <p className="text-sm font-medium">Notifications</p>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAll}
                disabled={marking}
                className="flex min-h-tap items-center gap-1 text-xs text-primary hover:underline disabled:opacity-60"
              >
                {marking ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <CheckCheck size={14} aria-hidden="true" />}
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {recent.isPending && (
              <p className="flex items-center gap-2 px-4 py-6 text-sm text-ink-2">
                <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> Loading…
              </p>
            )}
            {recent.isError && <p className="px-4 py-6 text-sm text-error">Could not load notifications.</p>}
            {recent.isSuccess && !items.length && (
              <div className="px-4 py-8 text-center">
                <Bell size={22} className="mx-auto text-ink-3" aria-hidden="true" />
                <p className="mt-2 text-sm font-medium">You're all caught up</p>
                <p className="mt-0.5 text-xs text-ink-2">Updates on your tickets will show here.</p>
              </div>
            )}
            {items.length > 0 && (
              <ul className="divide-y divide-line">
                {items.map((n) => (
                  <li key={n.id}>
                    <NotificationItem
                      n={n}
                      compact
                      onOpen={(x) => {
                        setOpen(false);
                        openNotification(x);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className="flex min-h-tap items-center justify-center border-t border-line text-sm text-primary hover:bg-gold-muted"
          >
            See all notifications
          </Link>
        </div>
      )}
    </div>
  );
}
