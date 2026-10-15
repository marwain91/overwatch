import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useWindowActive } from './useWsPolling';
import type { DatabaseServerInfo, DatabaseServerStats, DatabaseDetail, DatabaseProcess } from '../lib/types';

/**
 * Poll only while the tab is visible and focused: a Database page left open
 * in an unfocused window otherwise queries the DB server around the clock.
 * Catches up once when the window becomes active again.
 */
function useActivePolledQuery<T>(key: string, path: string, intervalMs: number) {
  const windowActive = useWindowActive();
  const query = useQuery({
    queryKey: [key],
    queryFn: () => api.get<T>(path),
    refetchInterval: windowActive ? intervalMs : false,
  });

  const { refetch } = query;
  const wasActive = useRef(windowActive);
  useEffect(() => {
    if (windowActive && !wasActive.current) void refetch();
    wasActive.current = windowActive;
  }, [windowActive, refetch]);

  return query;
}

export function useDatabaseInfo() {
  return useQuery({
    queryKey: ['database-info'],
    queryFn: () => api.get<DatabaseServerInfo>('/database/info'),
    staleTime: 60_000,
  });
}

export function useDatabaseStats() {
  return useActivePolledQuery<DatabaseServerStats>('database-stats', '/database/stats', 15_000);
}

export function useDatabaseList() {
  return useQuery({
    queryKey: ['database-list'],
    queryFn: () => api.get<DatabaseDetail[]>('/database/databases'),
    staleTime: 30_000,
  });
}

export function useDatabaseProcesses() {
  return useActivePolledQuery<DatabaseProcess[]>('database-processes', '/database/processes', 10_000);
}

export function useKillProcess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post(`/database/processes/${id}/kill`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['database-processes'] });
    },
  });
}
