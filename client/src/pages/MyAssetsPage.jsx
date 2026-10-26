import { useQuery } from '@tanstack/react-query';
import { LoaderCircle, MapPin, Package } from 'lucide-react';
import { myAssets } from '../api/inventory';
import { Alert } from '../components/FormControls';
import { assetTitle, statusClass, statusLabel } from '../utils/assets';

// Everyone: the equipment assigned to me (Phase 8).
export default function MyAssetsPage() {
  const query = useQuery({ queryKey: ['inventory', 'mine'], queryFn: myAssets });
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-3xl">My assets</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">Equipment assigned to you. Something wrong or missing? Raise a ticket.</p>
      </div>
      {query.isPending && (
        <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
          <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading…
        </p>
      )}
      {query.isError && <Alert tone="error">Could not load your assets.</Alert>}
      {query.isSuccess && !query.data.length && (
        <div className="card text-center">
          <Package size={24} className="mx-auto text-ink-3" aria-hidden="true" />
          <p className="mt-2 font-ui font-medium">Nothing is assigned to you</p>
          <p className="mt-1 font-ui text-sm text-ink-2">When AVIT gives you equipment, it shows here.</p>
        </div>
      )}
      {query.data?.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {query.data.map((a) => (
            <li key={a.id} className="card p-4 font-ui">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs tabular-nums text-ink-3">
                    {a.tag} · {a.category.name}
                  </p>
                  <p className="mt-0.5 font-medium text-ink">{assetTitle(a)}</p>
                </div>
                <span className={`${statusClass(a.status)} shrink-0 whitespace-nowrap`}>{statusLabel(a.status)}</span>
              </div>
              {a.serial && <p className="mt-2 text-xs tabular-nums text-ink-2">Serial {a.serial}</p>}
              {a.place && (
                <p className="mt-1 flex items-center gap-1 text-xs text-ink-2">
                  <MapPin size={12} aria-hidden="true" /> {a.place.name}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
