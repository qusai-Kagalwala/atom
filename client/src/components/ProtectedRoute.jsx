import { Navigate, Outlet, useLocation } from 'react-router-dom';
import useAuth from '../hooks/useAuth';

// UI guard only. Every API endpoint checks the session, role and company on the server.
// Someone still on a temporary password only gets the "Set your password" page (the server
// answers 403 must_change_password everywhere else).
//   roles    allowed ACTIVE roles
//   company  the page lives inside a company: without one, open the company picker
//   feature  an Admin feature that can be given to staff (Delegate access): roles OR the feature lets them in
export default function ProtectedRoute({ roles, company = false, feature = null }) {
  const { isAuthenticated, user } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.mustChangePassword && location.pathname !== '/set-password') return <Navigate to="/set-password" replace />;
  if (company && !user.company) return <Navigate to="/choose-company" replace />;
  const given = feature && Array.isArray(user.features) && user.features.includes(feature);
  if (roles && !roles.includes(user.activeRole) && !given) return <Navigate to={user.company ? '/' : '/choose-company'} replace />;
  return <Outlet />;
}
