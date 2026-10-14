import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useWsAwareInterval } from './useWsPolling';
import type { MetricsSnapshot, HealthState, AlertEntry, NotificationChannel } from '../lib/types';

export function useMetrics(appId?: string, tenantId?: string) {
  const url = appId && tenantId
    ? `/monitoring/metrics/${appId}/${tenantId}`
    : `/monitoring/metrics${appId ? `?appId=${appId}` : ''}`;

  const refetchInterval = useWsAwareInterval(15_000);
  return useQuery({
    queryKey: ['metrics', appId, tenantId],
    queryFn: () => api.get<MetricsSnapshot>(url),
    refetchInterval,
  });
}

export function useHealthStates(appId?: string) {
  const refetchInterval = useWsAwareInterval(30_000);
  return useQuery({
    queryKey: ['health', appId],
    queryFn: () => api.get<HealthState[]>(`/monitoring/health${appId ? `?appId=${appId}` : ''}`),
    refetchInterval,
  });
}

export function useAlertHistory(limit = 50) {
  return useQuery({
    queryKey: ['alerts', limit],
    queryFn: () => api.get<AlertEntry[]>(`/monitoring/alerts?limit=${limit}`),
  });
}

export function useNotificationChannels() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<NotificationChannel[]>('/monitoring/notifications'),
  });
}

export function useCreateNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; type: string; enabled: boolean; config: { url: string } }) =>
      api.post('/monitoring/notifications', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useUpdateNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; name: string; type: string; enabled: boolean; config: { url: string } }) =>
      api.put(`/monitoring/notifications/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useDeleteNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/monitoring/notifications/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useTestNotification() {
  return useMutation({
    mutationFn: (id: string) => api.post(`/monitoring/notifications/${id}/test`),
  });
}
