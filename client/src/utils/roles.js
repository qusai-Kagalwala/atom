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
  LayoutDashboard,
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
  UserCog,
  Wifi,
  CalendarDays,
  CalendarCheck,
} from 'lucide-react';
import rolesData from '@shared/roles.json';

export const ROLES = rolesData.roles;

const ICONS = {
  BarChart3, Bell, Bot, Boxes, CircleHelp, ClipboardList, FileDown, HardHat, House, LayoutDashboard, ListTree, Package, PackagePlus,
  Receipt, RefreshCw, Settings, ShieldCheck, ShieldUser, ShoppingCart, Sparkles, Store, Ticket, Tickets, UserCheck, UserCog, Users, Wifi, CalendarDays, CalendarCheck,
};

// Admin features that can be given to staff (Delegate access, 6 Nov 2026): { key: { nav, label, hint, companies? } }.
export const FEATURES = rolesData.features;
// The Admin, or someone given this feature in the active company. UI only — the server decides.
export const hasFeature = (user, key) => isAdminRole(user?.activeRole) || Boolean(user?.features?.includes(key));

// Admin of the active company (or the Super Admin inside it).
export const isAdminRole = (role) => role === 'ADMIN' || role === 'SUPER_ADMIN';
// Add / edit / move / assign / return assets: the Admin, and AVIT engineers (the server decides; this only shows the buttons).
export const canEditAssets = (user) =>
  isAdminRole(user?.activeRole) || Boolean(user?.features?.includes('inventory')) || (user?.activeRole === 'ENGINEER' && user?.company?.code === 'AVIT');

// Nav items for the ACTIVE role, in order. Items limited to some companies are left out elsewhere;
// the AI assistant shows only while the company's assistant is switched on (Super Admin, step C).
// UI only — the server decides access.
export function navForRole(role, company) {
  return (rolesData.navByRole[role] || [])
    .map((key) => ({ key, ...rolesData.navItems[key] }))
    .filter((item) => !item.companies || item.companies.includes(company?.code))
    .filter((item) => item.needs !== 'assistant' || company?.assistantEnabled !== false)
    .map((item) => ({ ...item, Icon: ICONS[item.icon] || CircleHelp }));
}

// Sidebar sections (28 Oct 2026):
//   Employees: one plain list.
//   Staff / Admins: "Personal" (their own tickets, requests, assets) and "Work" (queues, admin pages).
//   Super Admin: plus "Super Admin" (admins, users, sync, AI, settings). With no company chosen, only that.
const PERSONAL = new Set(rolesData.navPersonal);
const CONSOLE = new Set(rolesData.navConsole);
// extras.wifiHod: this person is a department HOD (Masool) — Jamea Internet Access joins their own menu.
export function navSectionsForUser(user, extras = {}) {
  const role = user?.activeRole;
  const items = navForRole(role, user?.company);
  if (extras.wifiHod && user?.company?.code === 'AVIT' && !items.some((i) => i.key === 'wifi')) {
    const at = items.findIndex((i) => i.key === 'notifications');
    items.splice(at === -1 ? items.length : at, 0, { key: 'wifi', ...rolesData.navItems.wifi, Icon: Wifi });
  }
  const console = items.filter((i) => CONSOLE.has(i.key));
  if (!user?.company) return console.length ? [{ key: 'console', label: 'Super Admin', items: console }] : [];
  const personal = items.filter((i) => PERSONAL.has(i.key));
  const work = items.filter((i) => !PERSONAL.has(i.key) && !CONSOLE.has(i.key));
  // Features given to this person (Delegate access): their own section, whatever role they are in.
  const shown = new Set(items.map((i) => i.key));
  const delegated = Object.keys(FEATURES)
    .filter((k) => user?.features?.includes(k))
    .map((k) => FEATURES[k])
    .filter((f) => f && (!f.companies || f.companies.includes(user.company.code)) && !shown.has(f.nav))
    .map((f) => ({ key: f.nav, ...rolesData.navItems[f.nav], Icon: ICONS[rolesData.navItems[f.nav]?.icon] || CircleHelp }));
  if (!work.length && !console.length && !delegated.length) return [{ key: null, label: null, items }];
  const sections = [{ key: 'personal', label: 'Personal', items: personal }];
  if (work.length) sections.push({ key: 'work', label: 'Work', items: work });
  if (delegated.length) sections.push({ key: 'delegated', label: 'Delegated', items: delegated });
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
