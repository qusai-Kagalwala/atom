import { useQuery } from '@tanstack/react-query';
import { Database, Radio, Server } from 'lucide-react';
import http from '../api/http';
import StatusRow from '../components/StatusRow';
import useSocketStatus from '../hooks/useSocketStatus';

// Phase 1 page: proves the /Atom sub-path, the API, PostgreSQL and Socket.IO all work behind IIS.
// Replaced by the three-card home in Phase 2.
function stateOf(query) {
  if (query.isPending) return 'loading';
  return query.isSuccess ? 'ok' : 'fail';
}

export default function SystemCheckPage() {
  const api = useQuery({
    queryKey: ['health'],
    queryFn: () => http.get('/health').then((r) => r.data),
  });
  const db = useQuery({
    queryKey: ['health', 'db'],
    queryFn: () => http.get('/health/db').then((r) => r.data),
  });
  const socket = useSocketStatus();

  return (
    <section className="mx-auto max-w-xl">
      <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Aljamea-tus-Saifiyah</p>
      <h1 className="mt-1 text-3xl">System check</h1>
      <p className="mt-2 font-ui text-sm text-ink-2">
        Confirms the app, API, database and real-time connection are reachable at this address.
      </p>

      <ul className="card mt-6 py-2">
        <StatusRow
          icon={Server}
          label="API"
          state={stateOf(api)}
          detail={api.data ? `Version ${api.data.version} · ${api.data.env}` : undefined}
        />
        <StatusRow
          icon={Database}
          label="Database"
          state={stateOf(db)}
          detail={db.isError ? 'PostgreSQL is not reachable.' : undefined}
        />
        <StatusRow
          icon={Radio}
          label="Real-time"
          state={socket.state}
          detail={socket.transport ? `Transport: ${socket.transport}` : undefined}
        />
      </ul>
    </section>
  );
}
