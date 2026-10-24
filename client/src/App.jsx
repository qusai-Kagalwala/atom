import { Route, Routes } from 'react-router-dom';
import rolesData from '@shared/roles.json';
import AppShell from './components/AppShell';
import ProtectedRoute from './components/ProtectedRoute';
import ComingSoonPage from './pages/ComingSoonPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import NotFoundPage from './pages/NotFoundPage';
import ProfilePage from './pages/ProfilePage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import SyncStatusPage from './pages/SyncStatusPage';
import UserDetailPage from './pages/UserDetailPage';
import UsersPage from './pages/UsersPage';
import SystemCheckPage from './pages/SystemCheckPage';

// Nav items not built yet get a placeholder route (replaced phase by phase).
const BUILT = new Set(['home', 'users', 'syncStatus']);
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
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/system-check" element={<SystemCheckPage />} />

          {/* Super Admin (UI guard only — the API returns 404 to anyone else) */}
          <Route element={<ProtectedRoute roles={['SUPER_ADMIN']} />}>
            <Route path="/users" element={<UsersPage />} />
            <Route path="/users/:id" element={<UserDetailPage />} />
            <Route path="/sync" element={<SyncStatusPage />} />
          </Route>

          {PLACEHOLDERS.map(([key, item]) => (
            <Route key={key} path={item.path} element={<ComingSoonPage title={item.label} />} />
          ))}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
