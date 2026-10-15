import { create } from 'zustand';
import type { AuthUser } from '../lib/types';

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  login: (token: string, user: AuthUser) => void;
  /** Replace the cached profile (e.g. with the fresh role from /auth/verify). */
  setUser: (user: AuthUser) => void;
  /** Sign out: revoke the session on the server, then forget it locally. */
  logout: () => void;
  /** Forget the session locally only (the server already rejected it). */
  clearSession: () => void;
  isAuthenticated: () => boolean;
}

function readStoredUser(): AuthUser | null {
  try {
    return JSON.parse(localStorage.getItem('overwatch_admin_user') || 'null');
  } catch {
    return null;
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('overwatch_admin_token'),
  user: readStoredUser(),

  login: (token: string, user: AuthUser) => {
    localStorage.setItem('overwatch_admin_token', token);
    localStorage.setItem('overwatch_admin_user', JSON.stringify(user));
    set({ token, user });
  },

  setUser: (user: AuthUser) => {
    localStorage.setItem('overwatch_admin_user', JSON.stringify(user));
    set({ user });
  },

  logout: () => {
    const { token } = get();
    // Best effort: the local session is cleared either way. keepalive lets the
    // request finish if the page unloads.
    if (token) {
      fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, keepalive: true })
        .catch(() => {});
    }
    get().clearSession();
  },

  clearSession: () => {
    localStorage.removeItem('overwatch_admin_token');
    localStorage.removeItem('overwatch_admin_user');
    set({ token: null, user: null });
  },

  isAuthenticated: () => !!get().token,
}));
