import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { DatabaseServerInfo, DatabaseServerStats, DatabaseDetail, DatabaseProcess } from '../lib/types';

export function useDatabaseInfo() {
  return useQuery({
    queryKey: ['database-info'],
    queryFn: () => api.get<DatabaseServerInfo>('/database/info'),
    staleTime: 60_000,
  });
}

export function useDatabaseStats() {
  return useQuery({
    queryKey: ['database-stats'],
    queryFn: () => api.get<DatabaseServerStats>('/database/stats'),
    refetchInterval: 15_000,
  });
}

export function useDatabaseList() {
  return useQuery({
    queryKey: ['database-list'],
    queryFn: () => api.get<DatabaseDetail[]>('/database/databases'),
    staleTime: 30_000,
  });
}

export function useDatabaseProcesses() {
  return useQuery({
    queryKey: ['database-processes'],
    queryFn: () => api.get<DatabaseProcess[]>('/database/processes'),
    refetchInterval: 5_000,
  });
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
