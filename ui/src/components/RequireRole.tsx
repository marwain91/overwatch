import type { ReactNode } from 'react';
import { useCan, useRole } from '../hooks/useRole';
import type { AdminRole } from '../lib/types';

/** Page-level gate for routes whose every action needs `min`; the API still enforces it. */
export function RequireRole({ min, children }: { min: AdminRole; children: ReactNode }) {
  const role = useRole();
  const allowed = useCan(min);
  if (role === null) {
    return (
      <div className="flex justify-center py-20">
        <span className="spinner" />
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="card mx-auto mt-20 max-w-md text-center">
        <h2 className="text-lg font-semibold text-content-primary">Not available for your role</h2>
        <p className="mt-2 text-sm text-content-muted">
          This page requires the '{min}' role; yours is '{role}'.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
