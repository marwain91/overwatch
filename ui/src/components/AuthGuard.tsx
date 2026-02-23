import { useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { api } from '../lib/api';

export function AuthGuard({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  useEffect(() => {
    if (!token) {
      navigate('/login', { replace: true });
      return;
    }

    // Verify token is still valid
    api.get('/auth/verify').catch(() => {
      logout();
      navigate('/login', { replace: true });
    });
  }, [token, navigate, logout]);

  if (!token) return null;

  return <>{children}</>;
}
