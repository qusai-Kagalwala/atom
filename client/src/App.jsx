import { lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import rolesData from '@shared/roles.json';
import AppShell from './components/AppShell';
import ProtectedRoute from './components/ProtectedRoute';
import ComingSoonPage from './pages/ComingSoonPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import NotFoundPage from './pages/NotFoundPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import SetPasswordPage from './pages/SetPasswordPage';

// Everything past login/home is loaded on first visit, so phones download less up front.
// AppShell shows a spinner (Suspense) while a page loads.
const AllRequestsPage = lazy(() => import('./pages/AllRequestsPage'));
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage'));
const AssetPage = lazy(() => import('./pages/AssetPage'));
const AssistantPage = lazy(() => import('./pages/AssistantPage'));
const CataloguePage = lazy(() => import('./pages/CataloguePage'));
const AssignQueuePage = lazy(() => import('./pages/AssignQueuePage'));
const FaqEditPage = lazy(() => import('./pages/FaqEditPage'));
const FaqsPage = lazy(() => import('./pages/FaqsPage'));
const InventoryImportPage = lazy(() => import('./pages/InventoryImportPage'));
const InventoryPage = lazy(() => import('./pages/InventoryPage'));
const InvoicePage = lazy(() => import('./pages/InvoicePage'));
const InvoicesPage = lazy(() => import('./pages/InvoicesPage'));
const MyAssetsPage = lazy(() => import('./pages/MyAssetsPage'));
const MyRequestsPage = lazy(() => import('./pages/MyRequestsPage'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const RaiseTicketPage = lazy(() => import('./pages/RaiseTicketPage'));
const RequestPage = lazy(() => import('./pages/RequestPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const SyncStatusPage = lazy(() => import('./pages/SyncStatusPage'));
const SystemCheckPage = lazy(() => import('./pages/SystemCheckPage'));
const TicketPage = lazy(() => import('./pages/TicketPage'));
const UserDetailPage = lazy(() => import('./pages/UserDetailPage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));
const WorkQueuePage = lazy(() => import('./pages/WorkQueuePage'));

// Nav items not built yet get a placeholder route (replaced phase by phase).
const BUILT = new Set(['home', 'assistant', 'faqs', 'request', 'approvals', 'catalogue', 'settings', 'users', 'syncStatus', 'track', 'notifications', 'invoices', 'inventory', 'myAssets', 'workQueue', 'assignQueue', 'allRequests']);
const PLACEHOLDERS = Object.entries(rolesData.navItems).filter(([key]) => !BUILT.has(key));

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      {/* Signed in */}
      <Route element={<ProtectedRoute />}>
        <Route path="/set-password" element={<SetPasswordPage />} />
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/system-check" element={<SystemCheckPage />} />
          <Route path="/track" element={<MyRequestsPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/my-assets" element={<MyAssetsPage />} />
          <Route path="/assistant" element={<AssistantPage />} />
          <Route path="/request" element={<RequestPage />} />
          <Route path="/tickets/new" element={<RaiseTicketPage />} />
          <Route path="/tickets/:number" element={<TicketPage />} />

          <Route element={<ProtectedRoute roles={['ENGINEER', 'SUPER_ADMIN']} />}>
            <Route path="/work-queue" element={<WorkQueuePage />} />
            <Route path="/invoices" element={<InvoicesPage />} />
            <Route path="/invoices/:number" element={<InvoicePage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/inventory/assets/:tag" element={<AssetPage />} />
          </Route>

          {/* Super Admin (UI guard only — the API returns 404 to anyone else) */}
          <Route element={<ProtectedRoute roles={['SUPER_ADMIN']} />}>
            <Route path="/assign" element={<AssignQueuePage />} />
            <Route path="/all" element={<AllRequestsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/users/:id" element={<UserDetailPage />} />
            <Route path="/sync" element={<SyncStatusPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/inventory/import" element={<InventoryImportPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/catalogue" element={<CataloguePage />} />
            <Route path="/faqs" element={<FaqsPage />} />
            <Route path="/faqs/new" element={<FaqEditPage />} />
            <Route path="/faqs/:id" element={<FaqEditPage />} />
          </Route>

          {PLACEHOLDERS.map(([key, item]) => (
            <Route
              key={key}
              path={item.path}
              element={<ComingSoonPage title={item.label} />}
            />
          ))}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
