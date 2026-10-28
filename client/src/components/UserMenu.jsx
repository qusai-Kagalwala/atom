import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight, Check, ChevronDown, LoaderCircle, LogOut, Repeat, UserRound } from 'lucide-react';
import { errorMessage } from '../api/http';
import useAuth from '../hooks/useAuth';
import UserName from './UserName';
import { initials, roleBadgeClass, roleLabel, sortRoles } from '../utils/roles';

// Avatar + name, role switcher (roles available in this company, when more than one), switch
// company, and sign out. Staff show their occupation ("Carpenter") instead of "Staff".
export default function UserMenu() {
  const { user, switchRole, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(null);
  const [error, setError] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const roles = sortRoles(user.rolesHere || user.roles);
  const canSwitch = roles.length > 1;

  async function onSwitch(role) {
    if (role === user.activeRole) return setOpen(false);
    setError('');
    setSwitching(role);
    try {
      await switchRole(role); // full page reload on success
    } catch (err) {
      setSwitching(null);
      setError(errorMessage(err, 'Could not switch role.'));
    }
    return undefined;
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex min-h-tap items-center gap-2 rounded-btn px-2 text-white hover:bg-primary-dark"
      >
        <span
          aria-hidden="true"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-gold font-ui text-sm font-bold text-gold-on"
        >
          {initials(user.displayName || user.name)}
        </span>
        <span className="hidden text-left font-ui leading-tight sm:block">
          <UserName user={user} className="block max-w-[12rem] truncate text-sm font-medium" />
          <span className="block text-xs text-ink-on-primary">{roleLabel(user.activeRole, user)}</span>
        </span>
        <ChevronDown size={16} aria-hidden="true" className="text-ink-on-primary" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-2 w-72 overflow-hidden rounded-card border border-line bg-white font-ui text-sm text-ink shadow-lg"
        >
          <div className="border-b border-line bg-cream-dark px-4 py-3">
            <p className="truncate font-medium">
              <UserName user={user} />
            </p>
            <p className="text-xs tabular-nums text-ink-3">
              {user.loginType === 'ITS' ? `ITS ${user.itsNumber}` : `Employee ID ${user.employeeId}`}
            </p>
          </div>

          {canSwitch && (
            <div className="border-b border-line py-1">
              <p className="flex items-center gap-1.5 px-4 pb-1 pt-2 text-xs uppercase tracking-wider text-ink-3">
                <Repeat size={14} aria-hidden="true" /> Switch role
              </p>
              {roles.map((role) => (
                <button
                  key={role}
                  type="button"
                  role="menuitemradio"
                  aria-checked={role === user.activeRole}
                  disabled={Boolean(switching)}
                  onClick={() => onSwitch(role)}
                  className="flex min-h-tap w-full items-center justify-between px-4 hover:bg-gold-muted disabled:opacity-60"
                >
                  <span className={roleBadgeClass(role)}>{roleLabel(role, user)}</span>
                  {switching === role && <LoaderCircle size={16} className="animate-spin text-ink-3" aria-hidden="true" />}
                  {!switching && role === user.activeRole && <Check size={16} className="text-primary" aria-hidden="true" />}
                </button>
              ))}
              {error && <p className="px-4 pb-2 text-xs text-error">{error}</p>}
            </div>
          )}

          <Link
            to="/choose-company"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex min-h-tap w-full items-center gap-2 border-b border-line px-4 hover:bg-gold-muted"
          >
            <ArrowLeftRight size={18} aria-hidden="true" className="text-ink-2" /> Switch company
          </Link>

          <Link
            to="/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex min-h-tap w-full items-center gap-2 border-b border-line px-4 hover:bg-gold-muted"
          >
            <UserRound size={18} aria-hidden="true" className="text-ink-2" /> My profile
          </Link>

          <button
            type="button"
            role="menuitem"
            onClick={logout}
            className="flex min-h-tap w-full items-center gap-2 px-4 hover:bg-gold-muted"
          >
            <LogOut size={18} aria-hidden="true" className="text-ink-2" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
