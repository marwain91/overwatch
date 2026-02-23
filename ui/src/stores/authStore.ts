import { create } from 'zustand';
import type { AuthUser } from '../lib/types';

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  login: (token: string, user: AuthUser) => void;
  logout: () => void;
  isAuthenticated: () => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('overwatch_admin_token'),
  user: JSON.parse(localStorage.getItem('overwatch_admin_user') || 'null'),

  login: (token: string, user: AuthUser) => {
    localStorage.setItem('overwatch_admin_token', token);
    localStorage.setItem('overwatch_admin_user', JSON.stringify(user));
    set({ token, user });
  },

  logout: () => {
    localStorage.removeItem('overwatch_admin_token');
    localStorage.removeItem('overwatch_admin_user');
    set({ token: null, user: null });
  },

  isAuthenticated: () => !!get().token,
}));
