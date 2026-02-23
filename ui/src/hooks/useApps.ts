import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { AppDefinition } from '../lib/types';

export function useApps() {
  return useQuery({
    queryKey: ['apps'],
    queryFn: () => api.get<AppDefinition[]>('/apps'),
  });
}

export function useApp(appId: string) {
  return useQuery({
    queryKey: ['apps', appId],
    queryFn: () => api.get<AppDefinition>(`/apps/${appId}`),
    enabled: !!appId,
  });
}

export function useAppTags(appId: string) {
  return useQuery({
    queryKey: ['apps', appId, 'tags'],
    queryFn: () => api.get<{ tags: string[] }>(`/apps/${appId}/tags`),
    enabled: !!appId,
  });
}

export function useCreateApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<AppDefinition>) => api.post<AppDefinition>('/apps', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apps'] });
    },
  });
}

export function useUpdateApp(appId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<AppDefinition>) => api.put<AppDefinition>(`/apps/${appId}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apps'] });
    },
  });
}

export function useDeleteApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ appId, force }: { appId: string; force?: boolean }) =>
      api.delete<{ success: boolean }>(`/apps/${appId}${force ? '?force=true' : ''}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apps'] });
    },
  });
}

export function useTestRegistry(appId: string) {
  return useMutation({
    mutationFn: () => api.post<{ success: boolean }>(`/apps/${appId}/registry/test`),
  });
}
