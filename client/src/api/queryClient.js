import { QueryClient } from '@tanstack/react-query';

// Shared instance so logout can call queryClient.clear().
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

export default queryClient;
