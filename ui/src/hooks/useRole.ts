import { useAuthStore } from '../stores/authStore';
import type { AdminRole } from '../lib/types';

// Same ordering as the backend (src/services/users.ts `can`).
const RANK: Record<AdminRole, number> = { viewer: 1, editor: 2, admin: 3 };

export function useRole(): AdminRole | null {
  return useAuthStore((s) => s.user?.role ?? null);
}

/**
 * True when the signed-in user's role is at least `min`. False while the role
 * is unknown (before /auth/verify resolves), so controls stay hidden rather
 * than flashing and returning 403. The API remains the enforcement point.
 */
export function useCan(min: AdminRole): boolean {
  const role = useRole();
  return role !== null && RANK[role] >= RANK[min];
}
