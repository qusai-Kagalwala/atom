// Installable app + service worker + Web Push on this device (Phase 14).
// The service worker is only registered in the built app (not in the Vite dev server).
import http from './api/http';

const BASE = import.meta.env.BASE_URL; // '/Atom/'
let installEvent = null;
let waiting = null;
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

export function subscribePwa(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- install ----------
export const canInstall = () => Boolean(installEvent);
export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export async function promptInstall() {
  if (!installEvent) return false;
  installEvent.prompt();
  const { outcome } = await installEvent.userChoice;
  installEvent = null;
  emit();
  return outcome === 'accepted';
}

// ---------- updates ----------
export const updateReady = () => Boolean(waiting);
export function applyUpdate() {
  if (!waiting) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
  waiting.postMessage('skip-waiting');
}

export function startPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    emit();
  });
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE });
      const watch = (worker) => {
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            waiting = worker;
            emit();
          }
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) {
        waiting = reg.waiting;
        emit();
      }
      reg.addEventListener('updatefound', () => watch(reg.installing));
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000); // check for a new version hourly
    } catch {
      /* no service worker: the site still works */
    }
  });
}

// ---------- push on this device ----------
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export const getPushInfo = () => http.get('/push').then((r) => r.data); // { publicKey, enabled, myDevices }

// → 'on' | 'off' | 'blocked' | 'unsupported' | 'not-ready' (no service worker yet, e.g. dev server)
export async function devicePushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.getRegistration(BASE);
  if (!reg) return 'not-ready';
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

export async function turnPushOn(publicKey) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for ATOM in this browser’s settings.');
  const reg = await navigator.serviceWorker.ready;
  // The browser's push service (Google / Mozilla / Apple) must answer; don't spin forever if it can't.
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('The push service did not answer. Try again later.')), 20000));
  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }), timeout]));
  return http.post('/push/subscriptions', { subscription: sub.toJSON() }).then((r) => r.data);
}

export async function turnPushOff() {
  const reg = await navigator.serviceWorker.getRegistration(BASE);
  const sub = reg && (await reg.pushManager.getSubscription());
  if (!sub) return null;
  const { endpoint } = sub;
  await sub.unsubscribe().catch(() => {});
  return http.delete('/push/subscriptions', { data: { endpoint } }).then((r) => r.data);
}
