// Client view of shared/roles.json — the one source of truth for roles and navigation.
import {
  BarChart3,
  Bell,
  Bot,
  Boxes,
  CircleHelp,
  ClipboardList,
  FileDown,
  House,
  Package,
  PackagePlus,
  Receipt,
  RefreshCw,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Store,
  Ticket,
  Tickets,
  UserCheck,
  Users,
} from 'lucide-react';
import rolesData from '@shared/roles.json';

export const ROLES = rolesData.roles;

const ICONS = {
  BarChart3, Bell, Bot, Boxes, CircleHelp, ClipboardList, FileDown, House, Package, PackagePlus,
  Receipt, RefreshCw, Settings, ShieldCheck, ShoppingCart, Store, Ticket, Tickets, UserCheck, Users,
};

// Nav items for the ACTIVE role, in order. UI only — the server decides access.
export function navForRole(role) {
  return (rolesData.navByRole[role] || []).map((key) => {
    const item = rolesData.navItems[key];
    return { key, ...item, Icon: ICONS[item.icon] || CircleHelp };
  });
}

// Sidebar sections (28 Oct 2026): Engineers and Super Admins get "Personal" (their own tickets,
// requests, assets) and "Work" (queues and admin pages), each collapsible. Employees: one plain list.
const PERSONAL = new Set(rolesData.navPersonal);
export function navSectionsForRole(role) {
  const items = navForRole(role);
  const personal = items.filter((i) => PERSONAL.has(i.key));
  const work = items.filter((i) => !PERSONAL.has(i.key));
  if (!work.length) return [{ key: null, label: null, items }];
  return [
    { key: 'personal', label: 'Personal', items: personal },
    { key: 'work', label: 'Work', items: work },
  ];
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
