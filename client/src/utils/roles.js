// Client view of shared/roles.json — the one source of truth for roles and navigation.
import {
  BarChart3,
  Bell,
  Bot,
  Boxes,
  CircleHelp,
  ClipboardList,
  FileDown,
  HardHat,
  House,
  ListTree,
  Package,
  PackagePlus,
  Receipt,
  RefreshCw,
  Settings,
  ShieldCheck,
  ShieldUser,
  ShoppingCart,
  Sparkles,
  Store,
  Ticket,
  Tickets,
  UserCheck,
  Users,
} from 'lucide-react';
import rolesData from '@shared/roles.json';

export const ROLES = rolesData.roles;

const ICONS = {
  BarChart3, Bell, Bot, Boxes, CircleHelp, ClipboardList, FileDown, HardHat, House, ListTree, Package, PackagePlus,
  Receipt, RefreshCw, Settings, ShieldCheck, ShieldUser, ShoppingCart, Sparkles, Store, Ticket, Tickets, UserCheck, Users,
};

// Admin of the active company (or the Super Admin inside it).
export const isAdminRole = (role) => role === 'ADMIN' || role === 'SUPER_ADMIN';

// Nav items for the ACTIVE role, in order. Items limited to some companies (e.g. the AI assistant,
// AVIT only for now) are left out elsewhere. UI only — the server decides access.
export function navForRole(role, companyCode) {
  return (rolesData.navByRole[role] || [])
    .map((key) => ({ key, ...rolesData.navItems[key] }))
    .filter((item) => !item.companies || item.companies.includes(companyCode))
    .map((item) => ({ ...item, Icon: ICONS[item.icon] || CircleHelp }));
}

// Sidebar sections (28 Oct 2026):
//   Employees: one plain list.
//   Staff / Admins: "Personal" (their own tickets, requests, assets) and "Work" (queues, admin pages).
//   Super Admin: plus "Super Admin" (admins, users, sync, AI, settings). With no company chosen, only that.
const PERSONAL = new Set(rolesData.navPersonal);
const CONSOLE = new Set(rolesData.navConsole);
export function navSectionsForUser(user) {
  const role = user?.activeRole;
  const items = navForRole(role, user?.company?.code);
  const console = items.filter((i) => CONSOLE.has(i.key));
  if (!user?.company) return console.length ? [{ key: 'console', label: 'Super Admin', items: console }] : [];
  const personal = items.filter((i) => PERSONAL.has(i.key));
  const work = items.filter((i) => !PERSONAL.has(i.key) && !CONSOLE.has(i.key));
  if (!work.length && !console.length) return [{ key: null, label: null, items }];
  const sections = [{ key: 'personal', label: 'Personal', items: personal }];
  if (work.length) sections.push({ key: 'work', label: 'Work', items: work });
  if (console.length) sections.push({ key: 'console', label: 'Super Admin', items: console });
  return sections;
}

// "Staff" shows as the person's occupation ("Carpenter") when we know it.
export function roleLabel(role, user) {
  if (role === 'ENGINEER' && user?.occupation) return user.occupation;
  return ROLES[role]?.label || role;
}

export function roleBadgeClass(role) {
  return ROLES[role]?.badge || 'badge';
}

// Highest rank first, for the switcher list.
export function sortRoles(roles = []) {
  return [...roles].sort((a, b) => (ROLES[b]?.rank ?? 0) - (ROLES[a]?.rank ?? 0));
}

// "Alice Hamid" → "AH"; "Employee 1002" → "E1"
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}
