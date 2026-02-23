import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Tenant, BackupSnapshot, BackupStatus, TenantEnvVar } from '../lib/types';

export function useTenants(appId: string) {
  return useQuery({
    queryKey: ['tenants', appId],
    queryFn: () => api.get<Tenant[]>(`/apps/${appId}/tenants`),
    enabled: !!appId,
    refetchInterval: 30_000,
  });
}

export function useCreateTenant(appId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { tenantId: string; domain: string; imageTag: string }) =>
      api.post(`/apps/${appId}/tenants`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants', appId] });
    },
  });
}

export function useDeleteTenant(appId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tenantId, keepData }: { tenantId: string; keepData: boolean }) =>
      api.delete(`/apps/${appId}/tenants/${tenantId}?keepData=${keepData}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants', appId] });
    },
  });
}

export function useUpdateTenant(appId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tenantId, imageTag }: { tenantId: string; imageTag: string }) =>
      api.patch(`/apps/${appId}/tenants/${tenantId}`, { imageTag }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants', appId] });
    },
  });
}

export function useTenantAction(appId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tenantId, action }: { tenantId: string; action: 'start' | 'stop' | 'restart' }) =>
      api.post(`/apps/${appId}/tenants/${tenantId}/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants', appId] });
    },
  });
}

export function useAccessToken(appId: string) {
  return useMutation({
    mutationFn: (tenantId: string) =>
      api.post<{ accessUrl: string }>(`/apps/${appId}/tenants/${tenantId}/access-token`),
  });
}

// Backups
export function useBackupStatus(appId: string) {
  return useQuery({
    queryKey: ['backups', appId, 'status'],
    queryFn: () => api.get<BackupStatus>(`/apps/${appId}/backups/status`),
    enabled: !!appId,
  });
}

export function useAllBackups(appId: string) {
  return useQuery({
    queryKey: ['backups', appId],
    queryFn: () => api.get<BackupSnapshot[]>(`/apps/${appId}/backups`),
    enabled: !!appId,
  });
}

export function useTenantBackups(appId: string, tenantId: string | null) {
  return useQuery({
    queryKey: ['backups', appId, tenantId],
    queryFn: () => api.get<BackupSnapshot[]>(`/apps/${appId}/backups?tenantId=${tenantId}`),
    enabled: !!appId && !!tenantId,
  });
}

export function useCreateBackup(appId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string) => api.post(`/apps/${appId}/backups`, { tenantId }),
    onSuccess: (_, tenantId) => {
      qc.invalidateQueries({ queryKey: ['backups', appId, tenantId] });
      qc.invalidateQueries({ queryKey: ['backups', appId], exact: true });
      qc.invalidateQueries({ queryKey: ['backup-summary', appId] });
    },
  });
}

export function useRestoreBackup(appId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ snapshotId, tenantId }: { snapshotId: string; tenantId: string }) =>
      api.post(`/apps/${appId}/backups/${snapshotId}/restore`, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants', appId] });
    },
  });
}

export function useDeleteBackup(appId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (snapshotId: string) => api.delete(`/apps/${appId}/backups/${snapshotId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backups', appId] });
      qc.invalidateQueries({ queryKey: ['backup-summary', appId] });
    },
  });
}

// Tenant Env Vars
export function useTenantEnvVars(appId: string, tenantId: string | null) {
  return useQuery({
    queryKey: ['tenant-env-vars', appId, tenantId],
    queryFn: () => api.get<TenantEnvVar[]>(`/apps/${appId}/env-vars/tenants/${tenantId}`),
    enabled: !!appId && !!tenantId,
  });
}

export function useSetTenantOverride(appId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tenantId, key, value, sensitive }: { tenantId: string; key: string; value: string; sensitive: boolean }) =>
      api.post(`/apps/${appId}/env-vars/tenants/${tenantId}/overrides`, { key, value, sensitive }),
    onSuccess: (_, { tenantId }) => {
      qc.invalidateQueries({ queryKey: ['tenant-env-vars', appId, tenantId] });
    },
  });
}

export function useResetTenantOverride(appId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tenantId, key }: { tenantId: string; key: string }) =>
      api.delete(`/apps/${appId}/env-vars/tenants/${tenantId}/overrides/${encodeURIComponent(key)}`),
    onSuccess: (_, { tenantId }) => {
      qc.invalidateQueries({ queryKey: ['tenant-env-vars', appId, tenantId] });
    },
  });
}
