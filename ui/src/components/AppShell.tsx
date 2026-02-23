import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useWSStore } from '../stores/wsStore';
import { useQueryClient } from '@tanstack/react-query';

export function AppShell() {
  const connect = useWSStore((s) => s.connect);
  const disconnect = useWSStore((s) => s.disconnect);
  const subscribe = useWSStore((s) => s.subscribe);
  const qc = useQueryClient();

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  // Re-fetch queries on WS events
  useEffect(() => {
    return subscribe((msg) => {
      switch (msg.type) {
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

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-surface-base p-6">
        <Outlet />
      </main>
    </div>
  );
}
