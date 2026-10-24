import { useQuery } from '@tanstack/react-query';
import { unreadNotifications } from '../api/notifications';

// Unread notifications for the active role. Live pushes refresh it; the interval is only a fallback.
export default function useUnreadCount() {
  const { data } = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: unreadNotifications,
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
  return data ?? 0;
}
