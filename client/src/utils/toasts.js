// Tiny toast store (no library). Components read it with useSyncExternalStore.
const MAX = 3;
const DURATION_MS = 6000;

let toasts = [];
let nextId = 1;
const listeners = new Set();

const emit = () => listeners.forEach((fn) => fn());

export function dismissToast(id) {
  const before = toasts.length;
  toasts = toasts.filter((t) => t.id !== id);
  if (toasts.length !== before) emit();
}

// { title, body?, link?, notificationId? }
export function pushToast(toast) {
  const id = nextId++;
  toasts = [...toasts, { ...toast, id }].slice(-MAX);
  emit();
  setTimeout(() => dismissToast(id), DURATION_MS);
  return id;
}

export function subscribeToasts(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getToasts = () => toasts;
