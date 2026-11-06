import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, LoaderCircle } from 'lucide-react';
import { devicePushState, getPushInfo, isIos, isStandalone, pushSupported, turnPushOn } from '../pwa';
import { clearPushPrompt, pushPromptPending } from '../utils/pushPrompt';
import { Alert } from './FormControls';
import Modal from './Modal';
import useAuth from '../hooks/useAuth';

// First thing after signing in (6 Nov 2026): if this device can show notifications and they are off,
// offer to turn them on. "Not now" hides it until the next sign-in. Nothing shows when the device can't
// (iPhone outside the Home Screen app, blocked, unsupported) or the person chose "In app" off.
export default function PushPrompt() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [pending] = useState(pushPromptPending);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const wanted = pending && user?.notify?.inApp !== false && pushSupported() && !(isIos() && !isStandalone());
  const info = useQuery({ queryKey: ['push', 'info'], queryFn: getPushInfo, staleTime: 60_000, enabled: wanted });

  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    devicePushState()
      .then((s) => live && setState(s))
      .catch(() => live && setState('unsupported'));
    return () => {
      live = false;
    };
  }, [wanted]);

  if (!wanted || state !== 'off' || !info.data?.enabled || !info.data?.publicKey) return null;

  const close = () => {
    clearPushPrompt();
    setState('dismissed');
  };

  async function turnOn() {
    setBusy(true);
    setError('');
    try {
      await turnPushOn(info.data.publicKey);
      queryClient.invalidateQueries({ queryKey: ['push', 'info'] });
      close();
    } catch (err) {
      setError(err?.message || 'This browser could not turn notifications on.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Turn on notifications?"
      onClose={close}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={close} disabled={busy}>
            Not now
          </button>
          <button type="button" className="btn-primary" onClick={turnOn} disabled={busy}>
            {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <BellRing size={18} aria-hidden="true" />} Turn on
          </button>
        </>
      }
    >
      <p className="font-ui text-sm text-ink-2">
        Get told on this device when something needs you — a ticket assigned to you, one waiting in a pool, an approval — even when ATOM is closed. You can turn it
        off any time in your Profile.
      </p>
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
    </Modal>
  );
}
