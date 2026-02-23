import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { AuditEntry } from '../lib/types';
import { cn } from '../lib/cn';

export function ActivityPage() {
  const { data: logs, isLoading, refetch } = useQuery({
    queryKey: ['audit-logs'],
    queryFn: () => api.get<AuditEntry[]>('/audit-logs?limit=200'),
  });

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const perPage = 20;

  const filtered = (logs || []).filter(
    (e) =>
      !search ||
      e.action.toLowerCase().includes(search.toLowerCase()) ||
      e.user.toLowerCase().includes(search.toLowerCase()),
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const paged = filtered.slice((page - 1) * perPage, page * perPage);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-content-primary">Activity</h1>
        <button className="btn btn-secondary btn-sm" onClick={() => refetch()}>
          Refresh
        </button>
      </div>

      <input
        className="input mb-4 max-w-xs"
        placeholder="Search by action or user..."
        value={search}
        onChange={(e) => { setSearch(e.target.value); setPage(1); }}
      />

      {isLoading ? (
        <div className="flex justify-center py-20"><span className="spinner" /></div>
      ) : paged.length > 0 ? (
        <>
          <div className="space-y-2">
            {paged.map((entry, i) => {
              const isError = entry.status >= 400;
              return (
                <div key={i} className="flex items-center justify-between rounded-lg border border-border bg-surface-raised px-4 py-3">
                  <div>
                    <p className="text-sm text-content-secondary">{entry.action}</p>
                    <p className="text-xs text-content-faint">
                      {entry.user} &middot; {new Date(entry.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                  <span className={cn('badge', isError ? 'badge-red' : 'badge-green')}>
                    {entry.status}
                  </span>
                </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-4">
              <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
              <span className="text-sm text-content-muted">Page {page} of {totalPages}</span>
              <button className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-content-muted">No activity recorded.</p>
      )}
    </div>
  );
}
