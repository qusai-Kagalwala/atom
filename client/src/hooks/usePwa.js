import { useSyncExternalStore } from 'react';
import { canInstall, subscribePwa, updateReady } from '../pwa';

// Install prompt available? New version waiting? Re-renders when either changes.
const snapshot = () => `${canInstall() ? 1 : 0}${updateReady() ? 1 : 0}`;

export default function usePwa() {
  const s = useSyncExternalStore(subscribePwa, snapshot, () => '00');
  return { canInstall: s[0] === '1', updateReady: s[1] === '1' };
}
