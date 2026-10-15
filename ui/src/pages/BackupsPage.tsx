import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useApp, useBackupSummary } from '../hooks/useApps';
import { useBackupStatus, useAllBackups, useTenants } from '../hooks/useTenants';
import { useCan } from '../hooks/useRole';
import { cn } from '../lib/cn';
import { formatRelativeTime, formatCron } from '../lib/format';
import type { BackupSnapshot } from '../lib/types';
import { DeleteSnapshotModal, PreRestoreBadge, RestoreSnapshotModal } from './tenants/BackupsModal';

const PAGE_SIZE = 20;

export function BackupsPage() {
  const { appId } = useParams<{ appId: string }>();
  const { data: app, isLoading: appLoading } = useApp(appId!);
  const { data: status, isLoading: statusLoading } = useBackupStatus(appId!);
  const { data: summary, isLoading: summaryLoading } = useBackupSummary(appId!);
  const { data: backups, isLoading: backupsLoading } = useAllBackups(appId!);
  const { data: tenants } = useTenants(appId!);
  const isAdmin = useCan('admin');

  const [page, setPage] = useState(0);
  const [restoreTarget, setRestoreTarget] = useState<BackupSnapshot | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupSnapshot | null>(null);

  const backupConfig = app?.backup;
  const sorted = backups ? [...backups].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()) : [];
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const pageBackups = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (appLoading || statusLoading || summaryLoading) {
    return <div className="flex justify-center py-20"><span className="spinner" /></div>;
  }

  if (!app) {
    return <p className="text-content-muted">App not found.</p>;
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-content-primary">Backups — {app.name}</h1>
      </div>

      {/* Configuration Card */}
      <div className="card mb-4">
        <h2 className="mb-4 text-lg font-semibold text-content-secondary">Configuration</h2>
        {!backupConfig?.enabled ? (
          <p className="text-sm text-content-muted">Backups are not enabled for this app.</p>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-content-faint">Status</span>
              <span className={cn('font-medium', status?.initialized ? 'text-green-400' : status?.configured ? 'text-yellow-400' : 'text-red-400')}>
                {status?.initialized ? 'Active' : status?.configured ? 'Not initialized' : 'Not configured'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-content-faint">Provider</span>
              <span className="font-medium text-content-secondary">{(backupConfig.provider ?? 's3').toUpperCase()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-content-faint">Schedule</span>
              <span className="font-medium text-content-secondary">{summary?.schedule ? formatCron(summary.schedule) : 'Manual only'}</span>
            </div>
            {summary?.bucket && (
              <div className="flex justify-between gap-4">
                <span className="shrink-0 text-content-faint">Bucket</span>
                <span className="truncate font-mono text-content-secondary" title={summary.bucket}>{summary.bucket}</span>
              </div>
            )}
            {summary?.endpoint && (
              <div className="flex justify-between gap-4">
                <span className="shrink-0 text-content-faint">Endpoint</span>
                <span className="truncate font-mono text-content-secondary" title={summary.endpoint}>{summary.endpoint}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-content-faint">Last Backup</span>
              <span className="font-medium text-content-secondary">{summary?.lastBackup ? formatRelativeTime(summary.lastBackup) : 'Never'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-content-faint">Total Snapshots</span>
              <span className="font-medium text-content-secondary">{summary?.totalSnapshots ?? 0}</span>
            </div>
            {summary?.isLocked && (
              <p className="text-xs text-yellow-400">Repository is currently locked by another operation.</p>
            )}
          </div>
        )}
      </div>

      {/* Snapshots */}
      {backupConfig?.enabled && status?.configured && (
        <div className="card">
          <h2 className="mb-4 text-lg font-semibold text-content-secondary">All Snapshots</h2>

          {backupsLoading ? (
            <div className="flex justify-center py-8"><span className="spinner" /></div>
          ) : sorted.length === 0 ? (
            <p className="py-4 text-center text-sm text-content-muted">No backups yet.</p>
          ) : (
            <>
              <div className="space-y-2">
                {pageBackups.map((b) => (
                  <div key={b.id} className="flex items-center justify-between rounded border border-border-subtle bg-surface-muted px-3 py-2">
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="text-sm text-content-secondary">{new Date(b.time).toLocaleString()}</p>
                        <p className="text-xs text-content-faint">{b.shortId}</p>
                      </div>
                      {b.tenantId && (
                        <span className="rounded bg-brand-600/20 px-1.5 py-0.5 text-xs font-medium text-brand-400">
                          {b.tenantId}
                        </span>
                      )}
                      <PreRestoreBadge snapshot={b} />
                    </div>
                    {isAdmin && (
                    <div className="flex gap-1">
                      <button className="btn btn-secondary btn-xs" onClick={() => setRestoreTarget(b)}>Restore</button>
                      <button className="btn btn-danger btn-xs" onClick={() => setDeleteTarget(b)}>Delete</button>
                    </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="mt-4 flex items-center justify-center gap-2">
                  <button className="btn btn-secondary btn-xs" disabled={page === 0} onClick={() => setPage(page - 1)}>&#9664; Prev</button>
                  <span className="text-xs text-content-muted">{page + 1} / {totalPages}</span>
                  <button className="btn btn-secondary btn-xs" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>Next &#9654;</button>
                </div>
              )}
            </>
          )}

          {restoreTarget && (
            <RestoreSnapshotModal
              appId={appId!}
              snapshot={restoreTarget}
              tenantIds={(tenants ?? []).map((t) => t.tenantId)}
              onClose={() => setRestoreTarget(null)}
            />
          )}
          {deleteTarget && <DeleteSnapshotModal appId={appId!} snapshot={deleteTarget} onClose={() => setDeleteTarget(null)} />}
        </div>
      )}
    </div>
  );
}
