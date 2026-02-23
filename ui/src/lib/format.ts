export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [min, hour, dom, mon, dow] = parts;

  const time = hour !== '*' && min !== '*'
    ? `at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
    : hour !== '*' ? `at ${hour.padStart(2, '0')}:00` : '';

  if (dom === '*' && mon === '*' && dow === '*') {
    if (hour === '*' && min === '*') return 'Every minute';
    if (hour === '*') return `Every hour at :${min.padStart(2, '0')}`;
    return `Every day ${time}`;
  }

  if (dom === '*' && mon === '*' && dow !== '*') {
    const dayNames = dow.split(',').map(d => DAYS_OF_WEEK[parseInt(d, 10)] || d).join(', ');
    return `Every ${dayNames} ${time}`;
  }

  if (mon === '*' && dow === '*' && dom !== '*') {
    return `Monthly on day ${dom} ${time}`;
  }

  return cron;
}

export function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
