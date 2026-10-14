import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { AdminUser, AdminRole } from '../lib/types';

export function useAdminUsers() {
  return useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<AdminUser[]>('/admin-users'),
  });
}

export function useAddAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { email: string; role: AdminRole }) => api.post<AdminUser>('/admin-users', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}

export function useSetAdminUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role: AdminRole }) =>
      api.patch<AdminUser>(`/admin-users/${encodeURIComponent(email)}`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}

export function useDeleteAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => api.delete(`/admin-users/${encodeURIComponent(email)}`, email),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}
