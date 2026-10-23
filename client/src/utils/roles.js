// Client view of shared/roles.json — the one source of truth for roles and navigation.
import {
  BarChart3,
  Bell,
  Bot,
  CircleHelp,
  FileDown,
  House,
  Package,
  PackagePlus,
  Receipt,
  RefreshCw,
  ShieldCheck,
  ShoppingCart,
  Ticket,
  Users,
} from 'lucide-react';
import rolesData from '@shared/roles.json';

export const ROLES = rolesData.roles;

const ICONS = {
  BarChart3, Bell, Bot, CircleHelp, FileDown, House, Package, PackagePlus,
  Receipt, RefreshCw, ShieldCheck, ShoppingCart, Ticket, Users,
};

// Nav items for the ACTIVE role, in order. UI only — the server decides access.
export function navForRole(role) {
  return (rolesData.navByRole[role] || []).map((key) => {
    const item = rolesData.navItems[key];
    return { key, ...item, Icon: ICONS[item.icon] || CircleHelp };
  });
}

export function roleLabel(role) {
  return ROLES[role]?.label || role;
}

export function roleBadgeClass(role) {
  return ROLES[role]?.badge || 'badge';
}

// Highest rank first, for the switcher list.
export function sortRoles(roles = []) {
  return [...roles].sort((a, b) => (ROLES[b]?.rank ?? 0) - (ROLES[a]?.rank ?? 0));
}

// "Qusai Kagalwala" → "QK"; "Employee 1002" → "E1"
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}
