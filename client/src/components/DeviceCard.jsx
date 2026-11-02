import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, BellRing, Download, LoaderCircle, Share, Smartphone, SquarePlus } from 'lucide-react';
import { errorMessage } from '../api/http';
import { Alert } from './FormControls';
import usePwa from '../hooks/usePwa';
import { devicePushState, getPushInfo, isIos, isStandalone, promptInstall, pushSupported, turnPushOff, turnPushOn } from '../pwa';

// Profile → This device (Phase 14): install ATOM on the home screen, and switch pushes on / off for
// this phone or browser. Pushes go to every device the person switched on.
function IosSteps() {
  return (
    <ol className="list-decimal space-y-1 pl-5 font-ui text-sm text-ink-2">
      <li>
        Open ATOM in <strong>Safari</strong>.
      </li>
      <li>
        Tap <Share size={14} className="inline align-text-bottom" aria-label="Share" /> Share, then{' '}
        <SquarePlus size={14} className="inline align-text-bottom" aria-hidden="true" /> <strong>Add to Home Screen</strong>.
      </li>
      <li>Open ATOM from the Home Screen icon (needed for notifications, iOS 16.4 or later).</li>
    </ol>
  );
}

export default function DeviceCard() {
  const queryClient = useQueryClient();
  const { canInstall } = usePwa();
  const standalone = isStandalone();
  const ios = isIos();
  const [state, setState] = useState(null); // devicePushState()
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const info = useQuery({ queryKey: ['push', 'info'], queryFn: getPushInfo, staleTime: 60_000 });

  useEffect(() => {
    let live = true;
    devicePushState()
      .then((s) => live && setState(s))
      .catch(() => live && setState('unsupported'));
    return () => {
      live = false;
    };
  }, []);

  async function toggle(on) {
    setBusy(true);
    setError('');
    try {
      if (on) await turnPushOn(info.data.publicKey);
      else await turnPushOff();
      setState(await devicePushState());
      queryClient.invalidateQueries({ queryKey: ['push', 'info'] });
    } catch (err) {
      // Server errors come from axios; browser errors (permission, push service) are shown as they are.
      setError(err?.isAxiosError ? errorMessage(err, 'Could not save this device.') : `This browser could not change notifications. ${err?.message || ''}`.trim());
      setState(await devicePushState().catch(() => 'unsupported'));
    } finally {
      setBusy(false);
    }
  }

  const ready = info.data?.publicKey && info.data?.enabled;
  let push;
  if (info.isPending || state === null) push = <LoaderCircle size={18} className="animate-spin text-ink-3" aria-label="Loading" />;
  else if (!ready) push = <Alert tone="info">Phone notifications are switched off for now. You still get them inside ATOM and by email.</Alert>;
  else if (ios && !standalone) push = <Alert tone="info">On iPhone and iPad, add ATOM to your Home Screen first (steps above), then turn notifications on from there.</Alert>;
  else if (state === 'unsupported' || !pushSupported()) push = <Alert tone="info">This browser can’t receive notifications. Try Chrome, Edge or Firefox, or the Home Screen app.</Alert>;
  else if (state === 'not-ready') push = <Alert tone="info">Notifications work in the installed site, not in this preview.</Alert>;
  else if (state === 'blocked')
    push = <Alert tone="error">Notifications are blocked for ATOM. Allow them in this browser’s site settings, then reload.</Alert>;
  else
    push = (
      <label className="flex min-h-tap items-center gap-3 font-ui text-sm font-medium">
        <input type="checkbox" role="switch" checked={state === 'on'} disabled={busy} onChange={(e) => toggle(e.target.checked)} className="h-6 w-6 rounded border-line text-primary" />
        {state === 'on' ? (
          <>
            <BellRing size={18} className="text-primary" aria-hidden="true" /> Notifications on for this device
          </>
        ) : (
          <>
            <BellOff size={18} className="text-ink-3" aria-hidden="true" /> Notifications off for this device
          </>
        )}
        {busy && <LoaderCircle size={16} className="animate-spin text-ink-3" aria-hidden="true" />}
      </label>
    );

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-xl">
          <Smartphone size={20} aria-hidden="true" /> This device
        </h2>
        <p className="mt-1 font-ui text-sm text-ink-2">Use ATOM like an app and get notified even when it is closed.</p>
      </div>

      <div className="space-y-2">
        <h3 className="font-ui text-sm font-medium text-ink">App</h3>
        {standalone ? (
          <p className="font-ui text-sm text-ink-2">ATOM is installed on this device.</p>
        ) : canInstall ? (
          <button type="button" className="btn-primary" onClick={() => promptInstall()}>
            <Download size={18} aria-hidden="true" /> Install ATOM
          </button>
        ) : ios ? (
          <IosSteps />
        ) : (
          <p className="font-ui text-sm text-ink-2">Open your browser menu and choose “Install app” or “Add to Home screen”.</p>
        )}
      </div>

      <div className="space-y-2 border-t border-line pt-4">
        <h3 className="font-ui text-sm font-medium text-ink">Notifications</h3>
        {push}
        {error && <Alert tone="error">{error}</Alert>}
        {info.data?.myDevices > 0 && (
          <p className="font-ui text-xs text-ink-3">
            On for {info.data.myDevices} {info.data.myDevices === 1 ? 'device' : 'devices'} of yours. Signing out turns it off on that device.
          </p>
        )}
      </div>
    </section>
  );
}
