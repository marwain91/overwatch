import { NavLink, useParams } from 'react-router-dom';
import { useApps } from '../hooks/useApps';
import { useAuthStore } from '../stores/authStore';
import { useWSStore } from '../stores/wsStore';
import { useThemeStore } from '../stores/themeStore';
import { cn } from '../lib/cn';

const navItemClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
    isActive
      ? 'bg-brand-600/20 text-brand-400'
      : 'text-content-muted hover:bg-surface-subtle hover:text-content-secondary',
  );

const themeIcons = {
  light: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="5" /><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  ),
  dark: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  ),
  system: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
};

const themeOrder: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system'];
const themeLabels = { light: 'Light', dark: 'Dark', system: 'System' };

export function Sidebar() {
  const { appId } = useParams();
  const { data: apps } = useApps();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const wsConnected = useWSStore((s) => s.connected);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const cycleTheme = () => {
    const idx = themeOrder.indexOf(theme);
    setTheme(themeOrder[(idx + 1) % themeOrder.length]);
  };

  return (
    <aside className="flex h-full w-64 flex-col border-r border-border bg-surface-base">
      {/* Brand */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-4">
        <img src="/logo.svg" alt="Overwatch" className="h-8 w-8" />
        <span className="text-lg font-semibold text-content-primary">Overwatch</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <NavLink to="/" end className={navItemClass}>
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
          </svg>
          All Apps
        </NavLink>

        {/* Apps */}
        {apps && apps.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-content-faint">
              Apps
            </div>
            {apps.map((app) => (
              <div key={app.id} className="mb-1">
                <NavLink
                  to={`/apps/${app.id}/tenants`}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                      isActive || appId === app.id
                        ? 'bg-surface-subtle text-content-primary'
                        : 'text-content-muted hover:bg-surface-muted hover:text-content-tertiary',
                    )
                  }
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded bg-brand-600/20 text-xs font-bold text-brand-400">
                    {app.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="truncate">{app.name}</span>
                </NavLink>

                {/* Sub-navigation when app is selected */}
                {appId === app.id && (
                  <div className="ml-6 mt-1 flex flex-col gap-0.5 border-l border-border pl-3">
                    <NavLink to={`/apps/${app.id}/tenants`} end className={navItemClass}>
                      Tenants
                    </NavLink>
                    <NavLink to={`/apps/${app.id}/monitoring`} className={navItemClass}>
                      Monitoring
                    </NavLink>
                    <NavLink to={`/apps/${app.id}/environment`} className={navItemClass}>
                      Environment
                    </NavLink>
                    <NavLink to={`/apps/${app.id}/activity`} className={navItemClass}>
                      Activity
                    </NavLink>
                    <NavLink to={`/apps/${app.id}/settings`} className={navItemClass}>
                      Settings
                    </NavLink>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Global */}
        <div className="mt-4">
          <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-content-faint">
            Global
          </div>
          <NavLink to="/admins" className={navItemClass}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
            Admins
          </NavLink>
        </div>
      </nav>

      {/* Footer */}
      <div className="border-t border-border px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={cn('h-2 w-2 rounded-full', wsConnected ? 'bg-green-400' : 'bg-gray-600')} />
            <span className="text-xs text-content-faint">{wsConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
          <button
            onClick={cycleTheme}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-content-muted hover:bg-surface-subtle hover:text-content-secondary transition-colors"
            title={`Theme: ${themeLabels[theme]}`}
          >
            {themeIcons[theme]}
            <span>{themeLabels[theme]}</span>
          </button>
        </div>
        {user && (
          <div className="flex items-center gap-3">
            {user.picture && (
              <img src={user.picture} alt={user.name} className="h-8 w-8 rounded-full" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-content-tertiary">{user.name}</p>
              <button onClick={logout} className="text-xs text-content-faint hover:text-content-tertiary">
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
