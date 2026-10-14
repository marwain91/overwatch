import { Suspense, useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { RouteErrorBoundary } from './RouteErrorBoundary';
import { Sidebar } from './Sidebar';
import { useWSStore } from '../stores/wsStore';
import { useQueryClient } from '@tanstack/react-query';
import type { MetricsSnapshot } from '../lib/types';

export function AppShell() {
  const connect = useWSStore((s) => s.connect);
  const disconnect = useWSStore((s) => s.disconnect);
  const subscribe = useWSStore((s) => s.subscribe);
  const connected = useWSStore((s) => s.connected);
  const qc = useQueryClient();
  const location = useLocation();

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  // Re-fetch queries on WS events
  useEffect(() => {
    return subscribe((msg) => {
      switch (msg.type) {
        case 'metrics:snapshot': {
          // Same data the REST endpoint returns, scoped like each cached query's key.
          const snapshot = msg.data as MetricsSnapshot;
          for (const query of qc.getQueryCache().findAll({ queryKey: ['metrics'] })) {
            const [, appId, tenantId] = query.queryKey as [string, string?, string?];
            const keep = (x: { appId: string; tenantId: string }) =>
              (!appId || x.appId === appId) && (!tenantId || x.tenantId === tenantId);
            qc.setQueryData<MetricsSnapshot>(query.queryKey, {
              containers: snapshot.containers.filter(keep),
              tenants: snapshot.tenants.filter(keep),
            });
          }
          break;
        }
        case 'container:event':
          qc.invalidateQueries({ queryKey: ['tenants'] });
          break;
        case 'health:change':
          qc.invalidateQueries({ queryKey: ['health'] });
          break;
        case 'alert:fired':
        case 'alert:resolved':
          qc.invalidateQueries({ queryKey: ['alerts'] });
          break;
      }
    });
  }, [subscribe, qc]);

  // Polling is off while connected, so anything that changed while the socket was
  // down is refetched once on reconnect (not on the first connect: queries just loaded).
  const hasConnected = useRef(false);
  useEffect(() => {
    if (!connected) return;
    if (hasConnected.current) {
      for (const key of ['tenants', 'health', 'metrics', 'alerts']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    }
    hasConnected.current = true;
  }, [connected, qc]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-surface-base p-6">
        <RouteErrorBoundary key={location.pathname}>
        <Suspense
          fallback={
            <div className="flex justify-center py-20">
              <span className="spinner" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
        </RouteErrorBoundary>
      </main>
    </div>
  );
}
