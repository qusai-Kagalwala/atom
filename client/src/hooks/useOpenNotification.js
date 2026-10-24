import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { markNotificationRead } from '../api/notifications';

// Mark as read (if needed), then go to the ticket. A failed "mark read" never blocks navigation.
export default function useOpenNotification() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useCallback(
    (n, state) => {
      if (!n.read && n.id) {
        markNotificationRead(n.id)
          .catch(() => {})
          .finally(() => queryClient.invalidateQueries({ queryKey: ['notifications'] }));
      }
      if (n.link) navigate(n.link, state ? { state } : undefined);
    },
    [navigate, queryClient]
  );
}
