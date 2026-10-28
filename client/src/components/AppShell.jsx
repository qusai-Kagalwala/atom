import { Suspense, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, Building2, ChevronDown, LoaderCircle, Menu, ShieldUser, X } from 'lucide-react';
import { queueCounts } from '../api/requests';
import useAuth from '../hooks/useAuth';
import useLiveUpdates from '../hooks/useLiveUpdates';
import useUnreadCount from '../hooks/useUnreadCount';
import NotificationBell from './NotificationBell';
import Toasts from './Toasts';
import { navSectionsForUser } from '../utils/roles';
import UserMenu from './UserMenu';

const linkClass = ({ isActive }) =>
  [
    'flex min-h-tap items-center gap-3 rounded-btn px-3 font-ui text-sm transition-colors',
    isActive ? 'bg-white/10 font-medium text-white' : 'text-ink-on-primary hover:bg-white/5 hover:text-white',
  ].join(' ');

// Numbers on nav items: work waiting for the active role in this company + unread notifications.
// Live pushes refresh them; the interval is only a fallback if the live connection is down.
function useNavCounts(user) {
  const enabled = Boolean(user.company) && ['ENGINEER', 'ADMIN', 'SUPER_ADMIN'].includes(user.activeRole);
  const { data } = useQuery({
    queryKey: ['requests', 'counts'],
    queryFn: queueCounts,
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const notifications = useUnreadCount();
  return { ...(enabled && data ? data : {}), notifications };
}

const SECTIONS_KEY = 'atom.nav.sections';
function readOpen() {
  try {
    return { personal: true, work: true, console: true, ...JSON.parse(localStorage.getItem(SECTIONS_KEY) || '{}') };
  } catch {
    return { personal: true, work: true, console: true };
  }
}

function NavItems({ items, counts, onNavigate }) {
  return items.map(({ key, label, path, Icon }) => (
    <NavLink key={key} to={path} end={path === '/'} className={linkClass} onClick={onNavigate}>
      <Icon size={20} aria-hidden="true" className="shrink-0" />
      <span className="truncate">{label}</span>
      {counts[key] > 0 && (
        <span className="ml-auto rounded-full bg-gold px-2 py-0.5 text-xs font-bold text-gold-on" aria-label={`${counts[key]} ${key === 'notifications' ? 'unread' : 'waiting'}`}>
          {counts[key] > 99 ? '99+' : counts[key]}
        </span>
      )}
    </NavLink>
  ));
}

// Staff / Admins: "Personal" and "Work" (+ "Super Admin" for the Super Admin), each opens and closes
// on its own; remembered on this device. A closed section shows the total of its counts.
function SideNav({ sections, counts, onNavigate, open, onToggle }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-1 p-3">
      {sections.map((sec) => {
        if (!sec.key) return <NavItems key="all" items={sec.items} counts={counts} onNavigate={onNavigate} />;
        const isOpen = open[sec.key] !== false;
        const total = sec.items.reduce((n, i) => n + (counts[i.key] > 0 ? counts[i.key] : 0), 0);
        const id = `nav-${sec.key}`;
        return (
          <div key={sec.key} className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => onToggle(sec.key)}
              aria-expanded={isOpen}
              aria-controls={id}
              className="mt-1 flex min-h-tap items-center gap-2 rounded-btn px-3 font-ui text-xs font-semibold uppercase tracking-wider text-gold-light hover:bg-white/5"
            >
              <span>{sec.label}</span>
              {!isOpen && total > 0 && (
                <span className="rounded-full bg-gold px-2 py-0.5 text-xs font-bold normal-case text-gold-on" aria-label={`${total} waiting`}>
                  {total > 99 ? '99+' : total}
                </span>
              )}
              <ChevronDown size={16} aria-hidden="true" className={`ml-auto transition-transform ${isOpen ? '' : '-rotate-90'}`} />
            </button>
            {isOpen && (
              <div id={id} className="flex flex-col gap-1">
                <NavItems items={sec.items} counts={counts} onNavigate={onNavigate} />
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

// Desktop: teal sidebar + top bar. Mobile: hamburger opens the sidebar over the content.
export default function AppShell() {
  const { user } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sections = navSectionsForUser(user);
  const counts = useNavCounts(user);
  const [open, setOpen] = useState(readOpen);
  const toggle = (key) =>
    setOpen((o) => {
      const next = { ...o, [key]: o[key] === false };
      try {
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked */
      }
      return next;
    });
  useLiveUpdates();
  const year = new Date().getFullYear();

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      {/* Stays in place while the page scrolls; scrolls on its own when the nav is long (Super Admin). */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-primary-border bg-primary lg:flex">
        <div className="flex h-16 shrink-0 items-center border-b border-primary-border px-5">
          <span className="font-display text-2xl font-bold leading-none text-white">ATOM</span>
        </div>
        <div className="scrollbar-nav min-h-0 flex-1 overflow-y-auto">
          <SideNav sections={sections} counts={counts} open={open} onToggle={toggle} />
        </div>
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button
            type="button"
            className="absolute inset-0 bg-charcoal/40"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="scrollbar-nav absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto bg-primary shadow-xl">
            <div className="flex h-16 items-center justify-between border-b border-primary-border px-4">
              <span className="font-display text-2xl font-bold leading-none text-white">ATOM</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="flex min-h-tap min-w-tap items-center justify-center rounded-btn text-white hover:bg-primary-dark"
                aria-label="Close menu"
              >
                <X size={20} />
              </button>
            </div>
            <SideNav sections={sections} counts={counts} open={open} onToggle={toggle} onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-primary-border bg-primary text-white">
          <div className="flex h-16 items-center gap-2 px-3 sm:px-5">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="flex min-h-tap min-w-tap items-center justify-center rounded-btn hover:bg-primary-dark lg:hidden"
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
            <span className="hidden font-display text-xl font-bold leading-none sm:inline lg:hidden">ATOM</span>
            {/* The company this session works in — tap to switch (company picker). */}
            <Link
              to="/choose-company"
              className="ml-1 flex min-h-tap min-w-0 items-center gap-2 rounded-btn px-2 font-ui text-sm text-white hover:bg-primary-dark"
              title="Switch company"
            >
              {user.company ? <Building2 size={18} aria-hidden="true" className="shrink-0 text-gold-light" /> : <ShieldUser size={18} aria-hidden="true" className="shrink-0 text-gold-light" />}
              <span className="truncate font-medium">{user.company ? user.company.name : 'Super Admin console'}</span>
              <ArrowLeftRight size={14} aria-hidden="true" className="shrink-0 text-ink-on-primary" />
              <span className="sr-only">Switch company</span>
            </Link>
            <div className="ml-auto flex items-center gap-1">
              <NotificationBell />
              <UserMenu />
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
          <Suspense
            fallback={
              <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
                <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading…
              </p>
            }
          >
            <Outlet />
          </Suspense>
        </main>

        <footer className="border-t border-line py-4 text-center font-ui text-xs text-ink-3">
          © {year} Aljamea-tus-Saifiyah · ATOM v{import.meta.env.VITE_ATOM_VERSION}
        </footer>
      </div>
      <Toasts />
    </div>
  );
}
