import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Building2, LoaderCircle, LogOut, MonitorSmartphone, PackageOpen, ShieldUser, Wrench } from 'lucide-react';
import { companiesRequest } from '../api/auth';
import { errorMessage } from '../api/http';
import { getLastCompany } from '../auth/storage';
import { Alert } from '../components/FormControls';
import UserName from '../components/UserName';
import useAuth from '../hooks/useAuth';
import { roleLabel, sortRoles } from '../utils/roles';

const ICONS = { AVIT: MonitorSmartphone, SIYANAAT: Wrench, TANZEEM: PackageOpen };
const BASE = import.meta.env.BASE_URL;

// After every login (and from the top bar): which company to work in now. Each company opens its own
// space — tickets, requests, catalogue, inventory. The last one used on this device is highlighted.
export default function ChooseCompanyPage() {
  const { user, switchCompany, logout } = useAuth();
  const location = useLocation();
  const companies = useQuery({ queryKey: ['auth', 'companies'], queryFn: companiesRequest, staleTime: 0 });
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const last = getLastCompany(user.id);
  const isSuper = user.roles.includes('SUPER_ADMIN');
  const from = location.state?.from;
  const year = new Date().getFullYear();

  async function open(company, key) {
    setBusy(key);
    setError('');
    try {
      // Back to the page they came for only when it belongs to the same company they pick.
      const target = company && from && company.id === user.companyId ? `${BASE}${from.replace(/^\//, '')}` : company ? BASE : `${BASE}admins`;
      await switchCompany(company, target); // full page reload on success
    } catch (err) {
      setBusy(null);
      setError(errorMessage(err, 'Could not open this company.'));
    }
  }

  const usable = (companies.data || []).filter((c) => c.roles.length);

  return (
    <div className="flex min-h-screen flex-col items-center bg-cream px-4 py-10">
      <header className="text-center">
        <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Aljamea-tus-Saifiyah</p>
        <h1 className="mt-2 text-4xl">ATOM</h1>
        <div className="mt-3 flex items-center justify-center gap-3 text-gold" aria-hidden="true">
          <span className="h-px w-12 bg-gold/50" />
          <span className="text-xs">◆</span>
          <span className="h-px w-12 bg-gold/50" />
        </div>
        <p className="mt-4 font-ui text-sm text-ink-2">
          Welcome, <UserName user={user} className="font-medium text-ink" />. Where do you need to go?
        </p>
      </header>

      <main className="mt-8 w-full max-w-3xl">
        {error && (
          <div className="mb-4">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
        {companies.isPending && (
          <p className="flex items-center justify-center gap-2 font-ui text-sm text-ink-2">
            <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading…
          </p>
        )}
        {companies.isError && <Alert tone="error">{errorMessage(companies.error, 'Could not load the companies.')}</Alert>}
        {companies.isSuccess && !usable.length && !isSuper && (
          <Alert tone="warning">Your account has no access to any company yet. Please contact your Admin.</Alert>
        )}

        <ul className="grid gap-4 sm:grid-cols-3">
          {usable.map((c) => {
            const Icon = ICONS[c.code] || Building2;
            const isLast = last ? last === c.id : false;
            const top = sortRoles(c.roles)[0];
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => open(c, c.id)}
                  disabled={Boolean(busy)}
                  className={[
                    'card group flex h-full w-full flex-col text-left transition-shadow hover:border-gold hover:shadow-glow-gold focus-visible:shadow-glow-gold disabled:opacity-70',
                    isLast ? 'border-gold ring-2 ring-gold/40' : '',
                  ].join(' ')}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="flex h-12 w-12 items-center justify-center rounded-card bg-primary-tint text-primary">
                      <Icon size={24} aria-hidden="true" />
                    </span>
                    {isLast && <span className="badge bg-gold-muted text-gold-dark">Last used</span>}
                  </span>
                  <span className="mt-4 font-display text-2xl leading-tight text-ink">{c.name}</span>
                  {c.tagline && <span className="mt-1 flex-1 font-ui text-sm text-ink-2">{c.tagline}</span>}
                  <span className="mt-4 flex items-center justify-between gap-2 font-ui text-sm">
                    <span className="text-ink-3">
                      As <span className="font-medium text-ink">{roleLabel(top, top === 'ENGINEER' ? user : null)}</span>
                    </span>
                    {busy === c.id ? (
                      <LoaderCircle size={18} className="animate-spin text-primary" aria-label="Opening" />
                    ) : (
                      <ArrowRight size={18} aria-hidden="true" className="text-primary transition-transform group-hover:translate-x-0.5" />
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {isSuper && (
          <button
            type="button"
            onClick={() => open(null, 'console')}
            disabled={Boolean(busy)}
            className="card mt-4 flex w-full items-center gap-4 text-left transition-shadow hover:border-gold hover:shadow-glow-gold focus-visible:shadow-glow-gold disabled:opacity-70"
          >
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-card bg-role-super-bg text-role-super">
              <ShieldUser size={24} aria-hidden="true" />
            </span>
            <span className="flex-1">
              <span className="block font-display text-xl text-ink">Super Admin console</span>
              <span className="block font-ui text-sm text-ink-2">Company admins, users, sync, AI and settings for all companies.</span>
            </span>
            {busy === 'console' ? (
              <LoaderCircle size={18} className="animate-spin text-primary" aria-label="Opening" />
            ) : (
              <ArrowRight size={18} aria-hidden="true" className="text-primary" />
            )}
          </button>
        )}

        <div className="mt-6 text-center">
          <button type="button" onClick={logout} className="inline-flex min-h-tap items-center gap-2 font-ui text-sm text-ink-2 hover:text-primary">
            <LogOut size={16} aria-hidden="true" /> Sign out
          </button>
        </div>
      </main>

      <footer className="mt-auto pt-10 text-center font-ui text-xs text-ink-3">
        © {year} Aljamea-tus-Saifiyah · ATOM v{import.meta.env.VITE_ATOM_VERSION}
      </footer>
    </div>
  );
}
