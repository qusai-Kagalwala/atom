// Centred card on cream used by login, forgot-password and reset-password.
export default function AuthLayout({ prompt, children, below }) {
  const year = new Date().getFullYear();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-cream px-4 py-10">
      <div className="card w-full max-w-sm p-6 sm:p-8">
        <header className="text-center">
          <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Aljamea-tus-Saifiyah</p>
          <h1 className="mt-2 text-4xl">ATOM</h1>
          <p className="mt-1 font-ui text-sm text-ink-2">Ticketing &amp; Operations Manager</p>
          <p className="mt-0.5 font-ui text-xs text-ink-3">AVIT · Siyanaat · Tanzeem</p>
          <div className="mt-4 flex items-center justify-center gap-3 text-gold" aria-hidden="true">
            <span className="h-px w-12 bg-gold/50" />
            <span className="text-xs">◆</span>
            <span className="h-px w-12 bg-gold/50" />
          </div>
          {prompt && <p className="mt-4 font-ui text-sm text-ink-2">{prompt}</p>}
        </header>

        {children}

        {below && <div className="mt-5 text-center font-ui text-sm">{below}</div>}
      </div>

      <footer className="mt-6 text-center font-ui text-xs text-ink-3">
        <p>Access is restricted to authorised AJSM staff only.</p>
        <p className="mt-1">
          © {year} Aljamea-tus-Saifiyah · ATOM v{import.meta.env.VITE_ATOM_VERSION}
        </p>
      </footer>
    </div>
  );
}
