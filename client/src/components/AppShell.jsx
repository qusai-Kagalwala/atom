// Minimal shell for Phase 1. Sidebar, role switcher and notifications arrive in later phases.
export default function AppShell({ children }) {
  const year = new Date().getFullYear();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-primary-border bg-primary text-white">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4">
          <span className="font-display text-2xl font-bold leading-none">ATOM</span>
          <span className="hidden font-ui text-sm text-ink-on-primary sm:inline">
            AVIT Ticketing &amp; Operations Manager
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>

      <footer className="border-t border-line py-4 text-center font-ui text-xs text-ink-3">
        © {year} Aljamea-tus-Saifiyah · ATOM
      </footer>
    </div>
  );
}
