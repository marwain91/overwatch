import { useEffect, useRef, useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useThemeStore } from '../stores/themeStore';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export function LoginPage() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const token = useAuthStore((s) => s.token);
  const btnRef = useRef<HTMLDivElement>(null);
  const resolved = useThemeStore((s) => s.resolved);
  const [renderError, setRenderError] = useState<string | null>(null);

  const { data: authConfig, isLoading } = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => api.get<{ googleClientId: string; configured: boolean }>('/auth/config'),
  });

  const handleGoogleSignIn = useCallback(
    async (response: { credential: string }) => {
      try {
        const result = await fetch('/api/auth/google', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential: response.credential }),
        });
        const data = await result.json();
        if (!result.ok) throw new Error(data.error || 'Login failed');
        login(data.token, data.user);
        navigate('/', { replace: true });
      } catch (err) {
        console.error('Login failed:', err);
      }
    },
    [login, navigate],
  );

  const [gsiReady, setGsiReady] = useState(!!window.google?.accounts);

  // Wait for Google SDK to load (it's async)
  useEffect(() => {
    if (gsiReady) return;
    const check = setInterval(() => {
      if (window.google?.accounts) {
        setGsiReady(true);
        clearInterval(check);
      }
    }, 200);
    const timeout = setTimeout(() => {
      clearInterval(check);
      if (!window.google?.accounts) {
        setRenderError('Google Sign-In SDK failed to load. Check your network or ad-blocker.');
      }
    }, 10000);
    return () => { clearInterval(check); clearTimeout(timeout); };
  }, [gsiReady]);

  useEffect(() => {
    if (token) {
      navigate('/', { replace: true });
      return;
    }

    if (!authConfig?.configured || !authConfig.googleClientId) return;
    if (!gsiReady) return;

    if (!/^\d+-.+\.apps\.googleusercontent\.com$/.test(authConfig.googleClientId)) {
      setRenderError('GOOGLE_CLIENT_ID is invalid. Expected format: 123456-xxx.apps.googleusercontent.com');
      return;
    }

    setRenderError(null);

    window.google!.accounts.id.initialize({
      client_id: authConfig.googleClientId,
      callback: handleGoogleSignIn,
    });

    if (btnRef.current) {
      btnRef.current.innerHTML = '';
      window.google!.accounts.id.renderButton(btnRef.current, {
        theme: resolved === 'dark' ? 'outline' : 'filled_blue',
        size: 'large',
        width: '300',
      });
    }
  }, [authConfig, token, navigate, handleGoogleSignIn, resolved, gsiReady]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-base">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface-raised p-8 text-center">
        <img src="/logo.svg" alt="Overwatch" className="mx-auto mb-6 h-16 w-16" />
        <h1 className="mb-2 text-2xl font-bold text-content-primary">Overwatch</h1>
        <p className="mb-8 text-sm text-content-muted">Multi-Tenant Management</p>

        {isLoading ? (
          <div className="flex justify-center py-4"><span className="spinner" /></div>
        ) : renderError ? (
          <p className="text-sm text-red-400">{renderError}</p>
        ) : authConfig?.configured ? (
          <div ref={btnRef} className="flex justify-center" />
        ) : (
          <p className="text-sm text-red-400">
            Google Sign-In not configured. Set GOOGLE_CLIENT_ID.
          </p>
        )}
      </div>
    </div>
  );
}
