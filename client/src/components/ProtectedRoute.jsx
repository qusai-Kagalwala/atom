import { Navigate, Outlet, useLocation } from 'react-router-dom';
import useAuth from '../hooks/useAuth';

// UI guard only. Every API endpoint checks the session and role on the server.
// Someone still on a temporary password only gets the "Set your password" page (the server
// answers 403 must_change_password everywhere else).
export default function ProtectedRoute({ roles }) {
  const { isAuthenticated, user } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.mustChangePassword && location.pathname !== '/set-password') return <Navigate to="/set-password" replace />;
  if (roles && !roles.includes(user.activeRole)) return <Navigate to="/" replace />;
  return <Outlet />;
}
