import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { markNotificationRead } from '../api/notifications';
import useAuth from './useAuth';

// Mark as read (if needed), then go to the ticket. A failed "mark read" never blocks navigation.
// A notification about another company's ticket (your own tickets show from every company) first
// switches to that company — the ticket only opens inside its own company.
export default function useOpenNotification() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, switchCompany } = useAuth();
  return useCallback(
    (n, state) => {
      if (!n.read && n.id) {
        markNotificationRead(n.id)
          .catch(() => {})
          .finally(() => queryClient.invalidateQueries({ queryKey: ['notifications'] }));
      }
      if (!n.link) return;
      if (n.company && n.company.id !== user.companyId) {
        switchCompany({ id: n.company.id }, `${import.meta.env.BASE_URL}${n.link.replace(/^\//, '')}`).catch(() => navigate('/choose-company'));
        return;
      }
      navigate(n.link, state ? { state } : undefined);
    },
    [navigate, queryClient, user.companyId, switchCompany]
  );
}
