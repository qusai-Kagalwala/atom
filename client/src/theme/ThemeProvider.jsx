import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { saveThemeRequest, themeRequest } from '../api/theme';
import useAuth from '../hooks/useAuth';
import { applyMotion, motionAllowed, persistMotion, readMotion } from './motion';
import ThemeContext from './themeContext';
import { STORAGE_KEYS, applyTheme, normalizePrefs, persist, readStored, resolveMode, systemPrefersDark } from './themes';

const SAVE_DELAY_MS = 400; // quick taps through the options save once, with the last choice

// Keeps <html data-theme data-mode data-motion> in step with the person's choices. Colour and light/dark
// are remembered on this device straight away (so the login page and the first paint are themed) and,
// once signed in, saved to the account so they follow the person to other devices. Sits inside
// AuthProvider for that. Animations is device-only (motion.js).
//
// Account sync never gets in the way: if the server cannot be reached, or does not have the feature yet
// (503 theme_unavailable), this device's choice keeps working and `sync` becomes 'device-only'.
export default function ThemeProvider({ children }) {
  const { isAuthenticated, user } = useAuth();
  const { pathname } = useLocation();
  const [prefs, setPrefs] = useState(readStored);
  const [motion, setMotionState] = useState(readMotion);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const [sync, setSync] = useState('idle'); // 'idle' | 'saved' | 'device-only'
  const prefsRef = useRef(prefs);
  const touchedRef = useRef(false); // the person chose something since signing in
  const saveTimer = useRef(null);
  const originRef = useRef(null); // centre of the control last tapped: where a theme change grows from
  const resolvedMode = resolveMode(prefs.mode, systemDark);

  // Every other call is answered "set your password first" (and the app sends them there) while a
  // temporary password is in place, so stay out of the way — especially on that page itself.
  const userId = isAuthenticated ? user?.id : null;
  const canSync = Boolean(userId) && !user?.mustChangePassword && !pathname.endsWith('/set-password');
  const canSyncRef = useRef(canSync);

  useEffect(() => {
    applyTheme(prefs.theme, resolvedMode);
  }, [prefs.theme, resolvedMode]);

  useEffect(() => {
    applyMotion(motion);
  }, [motion]);

  // "Auto" follows the device, live.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // A change made in another tab shows up here too.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== STORAGE_KEYS.theme && e.key !== STORAGE_KEYS.mode) return;
      const next = readStored();
      prefsRef.current = next;
      setPrefs(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Phones restore pages from a back/forward cache and can reset the browser-bar colour while the page is
  // away; put the theme back when the page returns, so the bars never stay on an old colour.
  useEffect(() => {
    const reapply = () => applyTheme(prefsRef.current.theme, resolveMode(prefsRef.current.mode, systemPrefersDark()));
    const onShow = (e) => {
      if (e.persisted) reapply();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') reapply();
    };
    window.addEventListener('pageshow', onShow);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('pageshow', onShow);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Remember where the last tap was (works for keyboard "clicks" too: the control's centre).
  useEffect(() => {
    const onClick = (e) => {
      const el = e.target instanceof Element ? e.target.closest('button, a, [role="radio"]') || e.target : null;
      const r = el?.getBoundingClientRect?.();
      originRef.current = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // Signed in: the account's saved choice wins over what this device had, unless the person has already
  // picked something here in the meantime. Nothing saved yet = keep this device's choice (and do not
  // push it: a shared computer must not hand one person's colours to the next person who signs in).
  useEffect(() => {
    canSyncRef.current = canSync;
    if (!canSync) return undefined;
    let cancelled = false;
    touchedRef.current = false;
    themeRequest()
      .then((saved) => {
        if (cancelled || touchedRef.current || !saved) return;
        const next = normalizePrefs(saved);
        prefsRef.current = next;
        persist(next);
        setPrefs(next);
      })
      .catch(() => {
        /* offline or not available yet: this device's choice stays */
      });
    return () => {
      cancelled = true;
    };
  }, [canSync, userId]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const update = useCallback((patch) => {
    const before = prefsRef.current;
    const next = normalizePrefs({ ...before, ...patch });
    prefsRef.current = next;
    touchedRef.current = true;
    persist(next);

    // The new look grows from the tapped control as a circle (browsers that can; never with reduced motion).
    const looksDifferent =
      next.theme !== before.theme || resolveMode(next.mode, systemPrefersDark()) !== resolveMode(before.mode, systemPrefersDark());
    if (looksDifferent && motionAllowed() && typeof document.startViewTransition === 'function') {
      const o = originRef.current;
      const root = document.documentElement;
      root.style.setProperty('--vt-x', `${o ? o.x : window.innerWidth / 2}px`);
      root.style.setProperty('--vt-y', `${o ? o.y : window.innerHeight / 2}px`);
      const t = document.startViewTransition(() => applyTheme(next.theme, resolveMode(next.mode, systemPrefersDark())));
      // A skipped transition (tab hidden, page busy) is fine: the new look is applied either way. Both
      // promises reject when skipped, so both are handled.
      t.ready.catch(() => {});
      t.finished.catch(() => {});
    }
    setPrefs(next);

    if (!canSyncRef.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveThemeRequest(prefsRef.current)
        .then(() => setSync('saved'))
        .catch(() => setSync('device-only'));
    }, SAVE_DELAY_MS);
  }, []);
  const setTheme = useCallback((theme) => update({ theme }), [update]);
  const setMode = useCallback((mode) => update({ mode }), [update]);
  const setMotion = useCallback((next) => {
    persistMotion(next);
    setMotionState(next);
  }, []);

  const value = useMemo(
    () => ({ theme: prefs.theme, mode: prefs.mode, resolvedMode, sync, motion, setTheme, setMode, setMotion, update }),
    [prefs.theme, prefs.mode, resolvedMode, sync, motion, setTheme, setMode, setMotion, update]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
