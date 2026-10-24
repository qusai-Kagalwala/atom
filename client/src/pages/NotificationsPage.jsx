import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { listNotifications, markAllNotificationsRead } from '../api/notifications';
import { Alert } from '../components/FormControls';
import NotificationItem from '../components/NotificationItem';
import { Pager, Tabs } from '../components/RequestList';
import useOpenNotification from '../hooks/useOpenNotification';
import { roleLabel } from '../utils/roles';
import useAuth from '../hooks/useAuth';

const TABS = [
  ['all', 'All'],
  ['unread', 'Unread'],
];
const PAGE_SIZE = 20;

// Everything for the active role (plus updates on your own tickets, which show in every role).
export default function NotificationsPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'unread' ? 'unread' : 'all';
  const page = Number(params.get('page')) || 1;
  const queryClient = useQueryClient();
  const openNotification = useOpenNotification();
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState('');

  const query = useQuery({
    queryKey: ['notifications', 'page', view, page],
    queryFn: () => listNotifications({ unread: view === 'unread' ? 1 : undefined, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  async function markAll() {
    setMarking(true);
    setError('');
    try {
      await markAllNotificationsRead();
    } catch {
      setError('Could not mark them as read. Please try again.');
    } finally {
      setMarking(false);
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    }
  }

  const items = query.data?.notifications || [];
  const unread = query.data?.unread ?? 0;
  const from = `/notifications${params.toString() ? `?${params}` : ''}`;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">{roleLabel(user.activeRole)}</p>
          <h1 className="mt-1 text-3xl">Notifications</h1>
          <p className="mt-1 font-ui text-sm text-ink-2">Updates on your tickets and on work for your current role.</p>
        </div>
        {unread > 0 && (
          <button type="button" className="btn-secondary" onClick={markAll} disabled={marking}>
            {marking ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <CheckCheck size={18} aria-hidden="true" />}
            Mark all read
          </button>
        )}
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      <Tabs tabs={TABS} value={view} onChange={(v) => setParams(v === 'all' ? {} : { view: v })} counts={{ unread }} />

      {query.isPending && (
        <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
          <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading…
        </p>
      )}
      {query.isError && <Alert tone="error">Could not load notifications.</Alert>}
      {query.isSuccess && !items.length && (
        <div className="card text-center">
          <Bell size={24} className="mx-auto text-ink-3" aria-hidden="true" />
          <p className="mt-2 font-ui font-medium">{view === 'unread' ? 'No unread notifications' : 'No notifications yet'}</p>
          <p className="mt-1 font-ui text-sm text-ink-2">Updates on your tickets will show here.</p>
        </div>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-white">
          {items.map((n) => (
            <li key={n.id}>
              <NotificationItem n={n} onOpen={(x) => openNotification(x, { from })} />
            </li>
          ))}
        </ul>
      )}
      {query.data && (
        <Pager
          page={page}
          total={query.data.total}
          pageSize={PAGE_SIZE}
          onPage={(p) => setParams(view === 'all' ? { page: String(p) } : { view, page: String(p) })}
        />
      )}
    </section>
  );
}
