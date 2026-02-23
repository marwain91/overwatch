import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthGuard } from './components/AuthGuard';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { AppListPage } from './pages/AppListPage';
import { AppCreateWizard } from './pages/AppCreateWizard';
import { AppSettingsPage } from './pages/AppSettingsPage';
import { TenantsPage } from './pages/TenantsPage';
import { MonitoringPage } from './pages/MonitoringPage';
import { ActivityPage } from './pages/ActivityPage';
import { EnvironmentPage } from './pages/EnvironmentPage';
import { BackupsPage } from './pages/BackupsPage';
import { AdminsPage } from './pages/AdminsPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <AuthGuard>
            <AppShell />
          </AuthGuard>
        }
      >
        <Route index element={<AppListPage />} />
        <Route path="apps/new" element={<AppCreateWizard />} />
        <Route path="apps/:appId/settings" element={<AppSettingsPage />} />
        <Route path="apps/:appId/tenants" element={<TenantsPage />} />
        <Route path="apps/:appId/monitoring" element={<MonitoringPage />} />
        <Route path="apps/:appId/activity" element={<ActivityPage />} />
        <Route path="apps/:appId/backups" element={<BackupsPage />} />
        <Route path="apps/:appId/environment" element={<EnvironmentPage />} />
        <Route path="admins" element={<AdminsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
