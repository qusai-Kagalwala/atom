import { createContext } from 'react';

// Value: { user, isAuthenticated, login, logout, switchRole }
const AuthContext = createContext(null);

export default AuthContext;
