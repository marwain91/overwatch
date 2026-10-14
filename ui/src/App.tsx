import { lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthGuard } from './components/AuthGuard';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { AppListPage } from './pages/AppListPage';
import { TenantsPage } from './pages/TenantsPage';
import { ActivityPage } from './pages/ActivityPage';
import { EnvironmentPage } from './pages/EnvironmentPage';
import { AdminsPage } from './pages/AdminsPage';
import { TenantDetailPage } from './pages/TenantDetailPage';

// Heavy, rarely-first-visited pages load on demand (Suspense lives in AppShell).
const AppCreateWizard = lazy(() => import('./pages/AppCreateWizard').then((m) => ({ default: m.AppCreateWizard })));
const AppSettingsPage = lazy(() => import('./pages/AppSettingsPage').then((m) => ({ default: m.AppSettingsPage })));
const TrashPage = lazy(() => import('./pages/TrashPage').then((m) => ({ default: m.TrashPage })));
const MonitoringPage = lazy(() => import('./pages/MonitoringPage').then((m) => ({ default: m.MonitoringPage })));
const BackupsPage = lazy(() => import('./pages/BackupsPage').then((m) => ({ default: m.BackupsPage })));
const DatabasePage = lazy(() => import('./pages/DatabasePage').then((m) => ({ default: m.DatabasePage })));
const InfrastructureTraefikPage = lazy(() =>
  import('./pages/InfrastructureTraefikPage').then((m) => ({ default: m.InfrastructureTraefikPage })),
);

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
        <Route path="apps/:appId/tenants/:tenantId" element={<TenantDetailPage />} />
        <Route path="apps/:appId/monitoring" element={<MonitoringPage />} />
        <Route path="apps/:appId/activity" element={<ActivityPage />} />
        <Route path="apps/:appId/backups" element={<BackupsPage />} />
        <Route path="apps/:appId/environment" element={<EnvironmentPage />} />
        <Route path="trash" element={<TrashPage />} />
        <Route path="admins" element={<AdminsPage />} />
        <Route path="database" element={<DatabasePage />} />
        <Route path="infrastructure/traefik" element={<InfrastructureTraefikPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
