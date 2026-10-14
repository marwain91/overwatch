import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-notification-channels-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe('notification channel storage', () => {
  it('persists notification channels with 0600 permissions', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    vi.doMock('../config', () => ({
      getDataDir: () => dataDir,
      loadConfig: () => ({ alert_rules: [] }),
    }));

    const { saveNotificationChannels } = await import('../services/alertEngine');
    await saveNotificationChannels([{
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Deploy alerts',
      type: 'webhook',
      enabled: true,
      config: { url: 'https://hooks.example.test/token' },
    } as any]);

    const stat = await fs.stat(path.join(dataDir, 'notification-channels.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('serialises concurrent saves: the check-and-write of one finishes before the next starts', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    vi.doMock('../config', () => ({
      getDataDir: () => dataDir,
      loadConfig: () => ({ alert_rules: [] }),
    }));
    const events: string[] = [];
    vi.doMock('../utils/security', async (orig) => {
      const actual = await orig<typeof import('../utils/security')>();
      return {
        ...actual,
        writeSecretFile: async (file: string, content: string) => {
          const tag = JSON.parse(content)[0].name;
          events.push(`start:${tag}`);
          await new Promise(r => setTimeout(r, 40));
          await actual.writeSecretFile(file, content);
          events.push(`end:${tag}`);
        },
      };
    });
    const { saveNotificationChannels } = await import('../services/alertEngine');
    const mk = (name: string) => [{
      id: '11111111-1111-4111-8111-111111111111', name, type: 'webhook', enabled: true,
      config: { url: 'https://hooks.example.test/x' },
    } as any];
    await Promise.all([saveNotificationChannels(mk('A')), saveNotificationChannels(mk('B'))]);
    vi.doUnmock('../utils/security');
    // Either may go first; what matters is that the two writes never overlap.
    expect(events).toHaveLength(4);
    expect(events[1]).toBe(events[0].replace('start', 'end'));
    expect(events[3]).toBe(events[2].replace('start', 'end'));
    expect(events[2]).not.toBe(events[0]);
  });
});
