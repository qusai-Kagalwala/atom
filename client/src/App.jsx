import { Route, Routes } from 'react-router-dom';
import AppShell from './components/AppShell';
import NotFoundPage from './pages/NotFoundPage';
import SystemCheckPage from './pages/SystemCheckPage';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<SystemCheckPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}
