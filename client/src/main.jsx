import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import queryClient from './api/queryClient';
import AuthProvider from './auth/AuthProvider';
import App from './App';
import './index.css';
import { startPwa } from './pwa';
import SiteBackground from './components/SiteBackground';
import ThemeProvider from './theme/ThemeProvider';

// Installable app: service worker (built app only), install prompt, update banner.
startPwa();

// '/Atom/' → '/Atom' for React Router.
const basename = import.meta.env.BASE_URL.replace(/\/$/, '');

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={basename}>
        <AuthProvider>
          <ThemeProvider>
            <SiteBackground />
            <App />
          </ThemeProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
