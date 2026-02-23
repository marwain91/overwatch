import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useApp, useBackupSummary } from '../hooks/useApps';
import { useBackupStatus, useAllBackups, useTenants, useCreateBackup, useRestoreBackup, useDeleteBackup } from '../hooks/useTenants';
import { cn } from '../lib/cn';
import { formatRelativeTime } from '../lib/format';
import type { BackupSnapshot } from '../lib/types';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function groupByDate(backups: BackupSnapshot[]): Map<string, BackupSnapshot[]> {
  const map = new Map<string, BackupSnapshot[]>();
  for (const b of backups) {
    const key = toDateKey(new Date(b.time));
    const arr = map.get(key);
    if (arr) arr.push(b);
    else map.set(key, [b]);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  }
  return map;
}

function getCalendarDays(year: number, month: number): (number | null)[] {
  const firstDay = new Date(year, month, 1).getDay();
  const offset = (firstDay + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  return cells;
}

function formatMonthYear(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function formatSelectedDate(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

export function BackupsPage() {
  const { appId } = useParams<{ appId: string }>();
  const { data: app, isLoading: appLoading } = useApp(appId!);
  const { data: status } = useBackupStatus(appId!);
  const { data: summary } = useBackupSummary(appId!);
  const { data: backups, isLoading: backupsLoading } = useAllBackups(appId!);
  const { data: tenants } = useTenants(appId!);
  const createBackup = useCreateBackup(appId!);
  const restoreBackup = useRestoreBackup(appId!);
  const deleteBackup = useDeleteBackup(appId!);

  const [viewMonth, setViewMonth] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<{ snapshotId: string; tenantId: string } | null>(null);
  const [backupTenantId, setBackupTenantId] = useState('');

  const backupsByDate = useMemo(() => groupByDate(backups ?? []), [backups]);

  const autoSelected = useMemo(() => {
    if (!backups || backups.length === 0) return null;
    const sorted = [...backups].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    return toDateKey(new Date(sorted[0].time));
  }, [backups]);

  const activeDate = selectedDate ?? autoSelected;
  const todayKey = toDateKey(new Date());
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const days = getCalendarDays(year, month);
  const selectedBackups = activeDate ? (backupsByDate.get(activeDate) ?? []) : [];

  const backupConfig = app?.backup;

  if (appLoading) {
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
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs text-content-faint">Status</p>
              <p className={cn('mt-1 text-sm font-medium', status?.initialized ? 'text-green-400' : status?.configured ? 'text-yellow-400' : 'text-red-400')}>
                {status?.initialized ? 'Active' : status?.configured ? 'Not initialized' : 'Not configured'}
              </p>
            </div>
            <div>
              <p className="text-xs text-content-faint">Provider</p>
              <p className="mt-1 text-sm font-medium text-content-secondary">{backupConfig.provider.toUpperCase()}</p>
            </div>
            <div>
              <p className="text-xs text-content-faint">Schedule</p>
              <p className="mt-1 text-sm font-medium text-content-secondary">{summary?.schedule ?? 'Manual only'}</p>
            </div>
            {backupConfig.s3?.bucket_env && (
              <div>
                <p className="text-xs text-content-faint">Bucket (env)</p>
                <p className="mt-1 text-sm font-mono text-content-secondary">{backupConfig.s3.bucket_env}</p>
              </div>
            )}
            {backupConfig.s3?.endpoint_env && (
              <div>
                <p className="text-xs text-content-faint">Endpoint (env)</p>
                <p className="mt-1 text-sm font-mono text-content-secondary">{backupConfig.s3.endpoint_env}</p>
              </div>
            )}
            <div>
              <p className="text-xs text-content-faint">Last Backup</p>
              <p className="mt-1 text-sm font-medium text-content-secondary">
                {summary?.lastBackup ? formatRelativeTime(summary.lastBackup) : 'Never'}
              </p>
            </div>
            <div>
              <p className="text-xs text-content-faint">Total Snapshots</p>
              <p className="mt-1 text-sm font-medium text-content-secondary">{summary?.totalSnapshots ?? 0}</p>
            </div>
            {summary?.isLocked && (
              <div className="col-span-full">
                <p className="text-xs text-yellow-400">Repository is currently locked by another operation.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Calendar + Backups */}
      {backupConfig?.enabled && status?.configured && (
        <div className="card">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-content-secondary">All Snapshots</h2>
            <div className="flex items-center gap-2">
              <select
                className="input input-sm"
                value={backupTenantId}
                onChange={(e) => setBackupTenantId(e.target.value)}
              >
                <option value="">Select tenant...</option>
                {tenants?.map((t) => <option key={t.tenantId} value={t.tenantId}>{t.tenantId}</option>)}
              </select>
              <button
                className="btn btn-primary btn-sm"
                disabled={createBackup.isPending || !backupTenantId}
                onClick={() => createBackup.mutate(backupTenantId, {
                  onSuccess: () => toast.success('Backup created'),
                  onError: (err) => toast.error(err.message),
                })}
              >
                {createBackup.isPending ? 'Backing up...' : '+ Create Backup'}
              </button>
            </div>
          </div>

          {backupsLoading ? (
            <div className="flex justify-center py-8"><span className="spinner" /></div>
          ) : (
            <>
              {/* Calendar */}
              <div className="mb-4">
                <div className="mb-2 flex items-center justify-between">
                  <button className="btn btn-secondary btn-xs" onClick={() => setViewMonth(new Date(year, month - 1, 1))}>&#9664;</button>
                  <span className="text-sm font-medium text-content-primary">{formatMonthYear(viewMonth)}</span>
                  <button className="btn btn-secondary btn-xs" onClick={() => setViewMonth(new Date(year, month + 1, 1))}>&#9654;</button>
                </div>

                <div className="grid grid-cols-7 text-center text-xs text-content-muted">
                  {WEEKDAYS.map((d) => <div key={d} className="py-1">{d}</div>)}
                </div>

                <div className="grid grid-cols-7 text-center text-sm">
                  {days.map((day, i) => {
                    if (day === null) return <div key={`empty-${i}`} />;
                    const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    const hasBackups = backupsByDate.has(dateKey);
                    const isSelected = dateKey === activeDate;
                    const isToday = dateKey === todayKey;
                    return (
                      <button
                        key={dateKey}
                        className={cn(
                          'relative mx-auto flex h-9 w-9 flex-col items-center justify-center rounded-lg transition-colors',
                          isSelected ? 'bg-brand text-white' : 'hover:bg-surface-muted',
                          isToday && !isSelected && 'ring-1 ring-brand/40',
                        )}
                        onClick={() => setSelectedDate(dateKey)}
                      >
                        <span>{day}</span>
                        {hasBackups && (
                          <span className={cn('absolute bottom-0.5 h-1 w-1 rounded-full', isSelected ? 'bg-white' : 'bg-brand')} />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Selected day backup list */}
              {activeDate ? (
                <div>
                  <div className="mb-2 border-t border-border-subtle pt-3 text-center text-xs text-content-muted">
                    {formatSelectedDate(activeDate)} ({selectedBackups.length} backup{selectedBackups.length !== 1 ? 's' : ''})
                  </div>
                  {selectedBackups.length > 0 ? (
                    <div className="space-y-2">
                      {selectedBackups.map((b) => (
                        <div key={b.id} className="flex items-center justify-between rounded border border-border-subtle bg-surface-muted px-3 py-2">
                          <div className="flex items-center gap-3">
                            <div>
                              <p className="text-sm text-content-secondary">
                                {new Date(b.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                              </p>
                              <p className="text-xs text-content-faint">{b.shortId}</p>
                            </div>
                            {b.tenantId && (
                              <span className="rounded bg-brand-600/20 px-1.5 py-0.5 text-xs font-medium text-brand-400">
                                {b.tenantId}
                              </span>
                            )}
                          </div>
                          <div className="flex gap-1">
                            <button className="btn btn-secondary btn-xs" onClick={() => setRestoreTarget({ snapshotId: b.id, tenantId: b.tenantId || '' })}>Restore</button>
                            <button
                              className="btn btn-danger btn-xs"
                              onClick={() => deleteBackup.mutate(b.id, {
                                onSuccess: () => toast.success('Backup deleted'),
                                onError: (err) => toast.error(err.message),
                              })}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-center text-xs text-content-faint">No backups on this day.</p>
                  )}
                </div>
              ) : (
                <p className="border-t border-border-subtle pt-3 text-center text-xs text-content-faint">Click a day to view backups</p>
              )}

              {/* Restore flow */}
              {restoreTarget && (
                <div className="mt-4 border-t border-border-subtle pt-4">
                  <h3 className="mb-2 text-sm font-medium text-content-secondary">Restore to:</h3>
                  <select className="input mb-2" value={restoreTarget.tenantId} onChange={(e) => setRestoreTarget({ ...restoreTarget, tenantId: e.target.value })}>
                    {tenants?.map((t) => <option key={t.tenantId} value={t.tenantId}>{t.tenantId}</option>)}
                  </select>
                  <div className="flex gap-2">
                    <button className="btn btn-danger btn-sm" onClick={() => restoreBackup.mutate(restoreTarget, {
                      onSuccess: () => { toast.success('Backup restored'); setRestoreTarget(null); },
                      onError: (err) => toast.error(err.message),
                    })} disabled={restoreBackup.isPending}>
                      {restoreBackup.isPending ? 'Restoring...' : 'Restore'}
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setRestoreTarget(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
