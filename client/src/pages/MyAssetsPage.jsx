import { useQuery } from '@tanstack/react-query';
import { Armchair, LoaderCircle, MapPin, Package, Phone } from 'lucide-react';
import { myAssets } from '../api/inventory';
import { Alert } from '../components/FormControls';
import { assetTitle, statusClass, statusLabel } from '../utils/assets';

function AssetCard({ a, note }) {
  return (
    <li className="card p-4 font-ui">
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
          {note && <span className="text-ink-3">· {note}</span>}
        </p>
      )}
    </li>
  );
}

const seatLabel = (s) => [`Room ${s.roomNo}`, s.cubicle && `Cubicle ${s.cubicle}`].filter(Boolean).join(' · ');

// Everyone: equipment assigned to me, and (Phase 8.2) equipment at my seat from the occupancy sheet.
export default function MyAssetsPage() {
  const query = useQuery({ queryKey: ['inventory', 'mine'], queryFn: myAssets });
  const d = query.data;
  const nothing = d && !d.assets.length && !d.roomAssets.length;
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-3xl">My assets</h1>
        <p className="mt-1 font-ui text-sm text-ink-2">Equipment assigned to you and at your seat. Something wrong or missing? Raise a ticket.</p>
      </div>
      {query.isPending && (
        <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
          <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading…
        </p>
      )}
      {query.isError && <Alert tone="error">Could not load your assets.</Alert>}

      {d?.seats.length > 0 && (
        <div className="card flex flex-wrap gap-x-6 gap-y-2 p-4 font-ui text-sm">
          {d.seats.map((s) => (
            <div key={`${s.roomNo}-${s.cubicle}`} className="space-y-0.5">
              <p className="flex items-center gap-1 font-medium text-ink">
                <Armchair size={16} aria-hidden="true" /> Your seat: {seatLabel(s)}
              </p>
              <p className="text-xs text-ink-2">{[s.building, s.floor && (/floor/i.test(s.floor) ? s.floor : `${s.floor} floor`), s.department].filter(Boolean).join(' · ')}</p>
              {(s.intercom || s.didNo) && (
                <p className="flex items-center gap-1 text-xs text-ink-2">
                  <Phone size={12} aria-hidden="true" /> {[s.intercom && `Intercom ${s.intercom}`, s.didNo && `DID ${s.didNo}`].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {nothing && (
        <div className="card text-center">
          <Package size={24} className="mx-auto text-ink-3" aria-hidden="true" />
          <p className="mt-2 font-ui font-medium">Nothing is assigned to you</p>
          <p className="mt-1 font-ui text-sm text-ink-2">When AVIT gives you equipment, it shows here.</p>
        </div>
      )}
      {d?.assets.length > 0 && (
        <div className="space-y-2">
          {d.roomAssets.length > 0 && <h2 className="text-xl">Assigned to you</h2>}
          <ul className="grid gap-3 sm:grid-cols-2">
            {d.assets.map((a) => (
              <AssetCard key={a.id} a={a} />
            ))}
          </ul>
        </div>
      )}
      {d?.roomAssets.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xl">At your seat</h2>
          <p className="font-ui text-sm text-ink-2">In your room or cubicle. Shared items are used by everyone in the room.</p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {d.roomAssets.map((a) => (
              <AssetCard key={a.id} a={a} note={a.shared ? 'shared in the room' : 'your cubicle'} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
