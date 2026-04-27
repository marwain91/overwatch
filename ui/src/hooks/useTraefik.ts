import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type {
  CertResolver, MiddlewareSpec, TraefikApp, TraefikDashboard,
  TraefikGlobal, TraefikOverwatchRouting, TraefikTenant,
} from '../lib/types';

// ─── Global ────────────────────────────────────────────────────────────────

export function useTraefik() {
  return useQuery({
    queryKey: ['traefik'],
    queryFn: () => api.get<TraefikGlobal | null>('/traefik'),
  });
}

export function useUpdateTraefik() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TraefikGlobal) => api.put<TraefikGlobal>('/traefik', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['traefik'] }),
  });
}

// ─── Cert resolvers ────────────────────────────────────────────────────────

export function useCertResolvers() {
  return useQuery({
    queryKey: ['traefik', 'cert-resolvers'],
    queryFn: () => api.get<CertResolver[]>('/traefik/cert-resolvers'),
  });
}

export function useUpsertCertResolver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: CertResolver }) =>
      api.put<CertResolver>(`/traefik/cert-resolvers/${encodeURIComponent(name)}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['traefik', 'cert-resolvers'] });
      qc.invalidateQueries({ queryKey: ['traefik'] });
    },
  });
}

export function useDeleteCertResolver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.delete<{ success: boolean }>(`/traefik/cert-resolvers/${encodeURIComponent(name)}`, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['traefik', 'cert-resolvers'] });
      qc.invalidateQueries({ queryKey: ['traefik'] });
    },
  });
}

// ─── Global middlewares ────────────────────────────────────────────────────

export function useGlobalMiddlewares() {
  return useQuery({
    queryKey: ['traefik', 'middlewares'],
    queryFn: () => api.get<Record<string, MiddlewareSpec>>('/traefik/middlewares'),
  });
}

export function useUpsertGlobalMiddleware() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: MiddlewareSpec }) =>
      api.put<MiddlewareSpec>(`/traefik/middlewares/${encodeURIComponent(name)}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['traefik', 'middlewares'] });
      qc.invalidateQueries({ queryKey: ['traefik'] });
    },
  });
}

export function useDeleteGlobalMiddleware() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.delete<{ success: boolean }>(`/traefik/middlewares/${encodeURIComponent(name)}`, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['traefik', 'middlewares'] });
      qc.invalidateQueries({ queryKey: ['traefik'] });
    },
  });
}

// ─── Dashboard / Overwatch self-routing ────────────────────────────────────

export function useDashboardConfig() {
  return useQuery({
    queryKey: ['traefik', 'dashboard'],
    queryFn: () => api.get<TraefikDashboard | null>('/traefik/dashboard'),
  });
}

export function useUpdateDashboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TraefikDashboard) => api.put<TraefikDashboard>('/traefik/dashboard', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['traefik', 'dashboard'] });
      qc.invalidateQueries({ queryKey: ['traefik'] });
    },
  });
}

export function useOverwatchRouting() {
  return useQuery({
    queryKey: ['traefik', 'overwatch'],
    queryFn: () => api.get<TraefikOverwatchRouting | null>('/traefik/overwatch'),
  });
}

export function useUpdateOverwatchRouting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TraefikOverwatchRouting) => api.put<TraefikOverwatchRouting>('/traefik/overwatch', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['traefik', 'overwatch'] });
      qc.invalidateQueries({ queryKey: ['traefik'] });
    },
  });
}

// ─── Reload ────────────────────────────────────────────────────────────────

export function useReloadTraefik() {
  return useMutation({
    mutationFn: () => api.post<{ success: boolean; container: string }>('/traefik/reload', {}, 'reload'),
  });
}

// ─── Per-app ───────────────────────────────────────────────────────────────

export function useAppTraefik(appId: string | undefined) {
  return useQuery({
    queryKey: ['app-traefik', appId],
    queryFn: () => api.get<TraefikApp | null>(`/apps/${appId}/traefik`),
    enabled: !!appId,
  });
}

export function useUpdateAppTraefik(appId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TraefikApp) => api.put<TraefikApp>(`/apps/${appId}/traefik`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app-traefik', appId] }),
  });
}

// ─── Per-tenant ────────────────────────────────────────────────────────────

export function useTenantTraefik(appId: string | undefined, tenantId: string | undefined) {
  return useQuery({
    queryKey: ['tenant-traefik', appId, tenantId],
    queryFn: () => api.get<TraefikTenant | null>(`/apps/${appId}/tenants/${tenantId}/traefik`),
    enabled: !!appId && !!tenantId,
  });
}

export function useUpdateTenantTraefik(appId: string, tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TraefikTenant | null) =>
      api.put<TraefikTenant | null>(`/apps/${appId}/tenants/${tenantId}/traefik`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-traefik', appId, tenantId] }),
  });
}
