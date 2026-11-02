import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { listNotifications, markAllNotificationsRead, openNotificationById } from '../api/notifications';
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
const BASE = import.meta.env.BASE_URL;

// A push tapped on the phone opens /notifications?open=<id>. The notification may be for another
// company or role (e.g. the Admin queue while you are in Employee): switch there first, then open it.
function useOpenFromPush(id) {
  const { user, switchCompany } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const done = useRef(null);
  const [state, setState] = useState(id ? 'opening' : null);

  useEffect(() => {
    if (!id || done.current === id) return;
    done.current = id;
    (async () => {
      let n;
      try {
        n = await openNotificationById(id);
      } catch {
        setState('missing');
        navigate('/notifications', { replace: true });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      const link = n.link || '/notifications';
      const wrongCompany = n.company ? n.company.id !== user.companyId : n.role === 'SUPER_ADMIN' && Boolean(user.companyId);
      const wrongRole = Boolean(n.role) && n.role !== user.activeRole;
      if (wrongCompany || wrongRole) {
        try {
          await switchCompany(n.company ? { id: n.company.id } : null, `${BASE}${link.replace(/^\//, '')}`, n.role || null); // full reload
          return;
        } catch {
          setState('switch-failed');
          navigate('/notifications', { replace: true });
          return;
        }
      }
      setState(null);
      navigate(link, { replace: true });
    })();
  }, [id, navigate, queryClient, switchCompany, user.activeRole, user.companyId]);

  return state;
}

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
  const pushState = useOpenFromPush(params.get('open'));

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
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">{user.company ? `${user.company.name} · ` : ''}{roleLabel(user.activeRole, user)}</p>
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
      {pushState === 'opening' && (
        <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
          <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Opening…
        </p>
      )}
      {pushState === 'missing' && <Alert tone="info">That notification is no longer available.</Alert>}
      {pushState === 'switch-failed' && <Alert tone="error">You no longer have access to where that notification points.</Alert>}
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
