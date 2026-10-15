import { useState, useMemo, useEffect } from 'react';
import { toast } from 'sonner';
import { useBackupStatus, useTenantBackups, useCreateBackup, useRestoreBackup, useDeleteBackup } from '../../hooks/useTenants';
import { useBackupSummary } from '../../hooks/useApps';
import { useCan } from '../../hooks/useRole';
import { Modal } from '../../components/Modal';
import { cn } from '../../lib/cn';
import { formatCron } from '../../lib/format';
import type { Tenant, BackupSnapshot } from '../../lib/types';

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
  // Sort each day's backups newest-first
  for (const arr of map.values()) {
    arr.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  }
  return map;
}

function getCalendarDays(year: number, month: number): (number | null)[] {
  const firstDay = new Date(year, month, 1).getDay();
  // Convert Sunday=0 to Monday-start: Mon=0, Tue=1, ..., Sun=6
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

function snapshotTime(b: BackupSnapshot): string {
  return new Date(b.time).toLocaleString();
}

/** Marks the snapshot an in-place restore took of the tenant's data just before. */
export function PreRestoreBadge({ snapshot }: { snapshot: BackupSnapshot }) {
  if (!snapshot.tags.includes('pre-restore')) return null;
  return (
    <span className="rounded bg-yellow-500/15 px-1.5 py-0.5 text-xs font-medium text-yellow-400" title="Taken automatically just before a restore replaced this tenant's data">
      pre-restore
    </span>
  );
}

/**
 * Restore one snapshot into a tenant. The target's live data is replaced, so
 * the user types the target tenant id; restoring into a tenant other than the
 * one the snapshot was taken of is a separate, explicit choice.
 */
export function RestoreSnapshotModal({ appId, snapshot, tenantIds, onClose }: {
  appId: string;
  snapshot: BackupSnapshot;
  tenantIds: string[];
  onClose: () => void;
}) {
  const restoreBackup = useRestoreBackup(appId);
  const source = snapshot.tenantId;
  const sourceExists = !!source && tenantIds.includes(source);
  const otherTenants = tenantIds.filter((t) => t !== source);
  const [crossTenantChoice, setCrossTenantChoice] = useState(false);
  const [otherChoice, setOtherChoice] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');

  // Derived, not stored: the tenant list may still be loading when this opens.
  const crossTenant = !sourceExists || crossTenantChoice;
  const otherTarget = otherChoice && otherTenants.includes(otherChoice) ? otherChoice : (otherTenants[0] ?? '');

  const target = crossTenant ? otherTarget : (source ?? '');
  const canRestore = !!target && confirmText === target && !restoreBackup.isPending;

  const restore = () => restoreBackup.mutate({ snapshotId: snapshot.id, tenantId: target, allowCrossTenant: crossTenant }, {
    onSuccess: (res) => {
      const safety = res?.safetySnapshotId ? ` The previous data is in snapshot ${res.safetySnapshotId.slice(0, 8)}.` : '';
      if (res?.warnings?.length) toast.warning(`Backup restored to ${target} with warnings: ${res.warnings.join('; ')}.${safety}`);
      else toast.success(`Backup restored to ${target}.${safety}`);
      onClose();
    },
    onError: (err) => toast.error(err.message, { duration: 20_000 }),
  });

  return (
    <Modal title={`Restore snapshot ${snapshot.shortId}`} size="md" onClose={onClose}>
      <p className="mb-3 text-sm text-content-muted">
        Taken {snapshotTime(snapshot)}{source ? <> of tenant <code className="text-content-secondary">{source}</code></> : ' (tenant unknown)'}.
      </p>

      {sourceExists ? (
        <label className="mb-3 flex items-center gap-2 text-sm text-content-tertiary">
          <input
            type="checkbox"
            checked={crossTenant}
            disabled={otherTenants.length === 0}
            onChange={(e) => { setCrossTenantChoice(e.target.checked); setConfirmText(''); }}
          />
          Restore into a different tenant (cross-tenant)
        </label>
      ) : (
        <p className="mb-3 text-sm text-content-muted">
          {source ? `Tenant ${source} no longer exists. ` : ''}It can only be restored into another tenant.
        </p>
      )}

      {crossTenant && (
        <select className="input mb-3" value={otherTarget} onChange={(e) => { setOtherChoice(e.target.value); setConfirmText(''); }}>
          {otherTenants.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      )}

      {target && (
        <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          <p>
            This overwrites the live database and files of <code className="font-semibold">{target}</code> with this snapshot.
            Overwatch first saves the current data as a <em>pre-restore</em> snapshot and stops the tenant while it restores.
          </p>
          {crossTenant && (
            <p className="mt-2 font-medium">
              Cross-tenant: <code>{target}</code> gets the data of {source ? <code>{source}</code> : 'another tenant'}.
            </p>
          )}
        </div>
      )}

      <input
        className="input mb-3"
        placeholder={target ? `Type ${target} to confirm` : 'No tenant to restore into'}
        value={confirmText}
        disabled={!target}
        onChange={(e) => setConfirmText(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" disabled={!canRestore} onClick={restore}>
          {restoreBackup.isPending ? 'Restoring...' : 'Restore'}
        </button>
      </div>
    </Modal>
  );
}

/** Deleting a snapshot is permanent: confirm before the request goes out. */
export function DeleteSnapshotModal({ appId, snapshot, onClose }: { appId: string; snapshot: BackupSnapshot; onClose: () => void }) {
  const deleteBackup = useDeleteBackup(appId);
  return (
    <Modal title={`Delete snapshot ${snapshot.shortId}`} size="md" onClose={onClose}>
      <p className="mb-4 text-sm text-content-muted">
        Snapshot {snapshot.shortId}, taken {snapshotTime(snapshot)}{snapshot.tenantId ? ` of ${snapshot.tenantId}` : ''}, is removed
        from the backup repository. Its data cannot be restored afterwards.
      </p>
      <div className="flex justify-end gap-2">
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-danger"
          disabled={deleteBackup.isPending}
          onClick={() => deleteBackup.mutate(snapshot.id, {
            onSuccess: () => { toast.success('Backup deleted'); onClose(); },
            onError: (err) => toast.error(err.message),
          })}
        >
          {deleteBackup.isPending ? 'Deleting...' : 'Delete snapshot'}
        </button>
      </div>
    </Modal>
  );
}

export function BackupsModal({ appId, tenantId, tenants, onClose }: { appId: string; tenantId: string; tenants: Tenant[]; onClose: () => void }) {
  const { data: status, isLoading: statusLoading } = useBackupStatus(appId);
  const { data: backups, isLoading } = useTenantBackups(appId, tenantId);
  const { data: summary } = useBackupSummary(appId);
  const createBackup = useCreateBackup(appId);
  const isAdmin = useCan('admin');
  const canEdit = useCan('editor');

  const [viewMonth, setViewMonth] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupSnapshot | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupSnapshot | null>(null);

  const backupsByDate = useMemo(() => groupByDate(backups ?? []), [backups]);

  // Auto-select most recent day with backups on first load
  const autoSelected = useMemo(() => {
    if (!backups || backups.length === 0) return null;
    const sorted = [...backups].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    return toDateKey(new Date(sorted[0].time));
  }, [backups]);

  // Navigate calendar to the month of the most recent backup
  useEffect(() => {
    if (autoSelected && !selectedDate) {
      const [y, m] = autoSelected.split('-').map(Number);
      setViewMonth(new Date(y, m - 1, 1));
    }
  }, [autoSelected, selectedDate]);

  const activeDate = selectedDate ?? autoSelected;

  const todayKey = toDateKey(new Date());
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const days = getCalendarDays(year, month);
  const selectedBackups = activeDate ? (backupsByDate.get(activeDate) ?? []) : [];

  if (statusLoading || isLoading) {
    return <Modal title={`Backups: ${tenantId}`} onClose={onClose}><div className="flex justify-center py-8"><span className="spinner" /></div></Modal>;
  }

  if (!status?.configured) {
    return <Modal title={`Backups: ${tenantId}`} onClose={onClose}><p className="text-content-muted">Backups not configured.</p></Modal>;
  }

  return (
    <Modal title={`Backups: ${tenantId}`} size="xl" maxHeight onClose={onClose}>
      {/* Schedule + Create button */}
      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs text-content-muted">
          Schedule: {summary?.schedule ? formatCron(summary.schedule) : 'Manual only'}
        </p>
        {canEdit && (
        <button
          className="btn btn-primary btn-sm"
          disabled={createBackup.isPending}
          onClick={() => createBackup.mutate(tenantId, {
            onSuccess: (res) => {
              if (res?.incomplete) toast.warning(`Backup created, but incomplete. Not backed up: ${(res.missingPaths ?? []).join(', ')}`);
              else toast.success('Backup created');
            },
            onError: (err) => toast.error(err.message),
          })}
        >
          {createBackup.isPending ? 'Backing up...' : '+ Create Backup'}
        </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
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
                    hasBackups ? 'bg-brand/20 text-brand-400 hover:bg-brand/30' : 'hover:bg-surface-muted',
                    isSelected ? 'ring-2 ring-brand' : isToday && 'ring-1 ring-brand/40',
                  )}
                  onClick={() => setSelectedDate(dateKey)}
                >
                  <span>{day}</span>
                  {hasBackups && (
                    <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-brand" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected day backups */}
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
            ) : (
              <p className="text-center text-xs text-content-faint">No backups on this day.</p>
            )}
          </div>
        ) : (
          <p className="border-t border-border-subtle pt-3 text-center text-xs text-content-faint">Click a day to view backups</p>
        )}
      </div>

      {restoreTarget && (
        <RestoreSnapshotModal
          appId={appId}
          snapshot={restoreTarget}
          tenantIds={tenants.map((t) => t.tenantId)}
          onClose={() => setRestoreTarget(null)}
        />
      )}
      {deleteTarget && <DeleteSnapshotModal appId={appId} snapshot={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    </Modal>
  );
}
