import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import useAuth from '../hooks/useAuth';
import { navForRole } from '../utils/roles';
import UserMenu from './UserMenu';

const linkClass = ({ isActive }) =>
  [
    'flex min-h-tap items-center gap-3 rounded-btn px-3 font-ui text-sm transition-colors',
    isActive ? 'bg-white/10 font-medium text-white' : 'text-ink-on-primary hover:bg-white/5 hover:text-white',
  ].join(' ');

function SideNav({ items, onNavigate }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-1 p-3">
      {items.map(({ key, label, path, Icon }) => (
        <NavLink key={key} to={path} end={path === '/'} className={linkClass} onClick={onNavigate}>
          <Icon size={20} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

// Desktop: teal sidebar + top bar. Mobile: hamburger opens the sidebar over the content.
export default function AppShell() {
  const { user } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const items = navForRole(user.activeRole);
  const year = new Date().getFullYear();

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-primary-border bg-primary lg:block">
        <div className="flex h-16 items-center border-b border-primary-border px-5">
          <span className="font-display text-2xl font-bold leading-none text-white">ATOM</span>
        </div>
        <SideNav items={items} />
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
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto bg-primary shadow-xl">
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
            <SideNav items={items} onNavigate={() => setDrawerOpen(false)} />
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
            <span className="font-display text-xl font-bold leading-none lg:hidden">ATOM</span>
            <span className="hidden font-ui text-sm text-ink-on-primary lg:inline">
              AVIT Ticketing &amp; Operations Manager
            </span>
            <div className="ml-auto">
              <UserMenu />
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
          <Outlet />
        </main>

        <footer className="border-t border-line py-4 text-center font-ui text-xs text-ink-3">
          © {year} Aljamea-tus-Saifiyah · ATOM v{import.meta.env.VITE_ATOM_VERSION}
        </footer>
      </div>
    </div>
  );
}
