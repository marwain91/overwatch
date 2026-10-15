import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;
let usersFile: string;

const rec = (email: string, role?: string) => ({ email, addedAt: '2026-01-01T00:00:00.000Z', addedBy: 'system', ...(role ? { role } : {}) });
const seed = (users: unknown[]) => fs.writeFile(usersFile, JSON.stringify(users));
const onDisk = async () => JSON.parse(await fs.readFile(usersFile, 'utf-8'));
const exists = (p: string) => fs.access(p).then(() => true, () => false);

beforeEach(async () => {
  vi.resetModules();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-admin-store-'));
  usersFile = path.join(tmpRoot, 'admin-users.json');
  vi.doMock('../config', () => ({ getDataDir: () => tmpRoot }));
});

afterEach(async () => {
  delete process.env.ALLOWED_ADMIN_EMAILS;
  vi.restoreAllMocks();
  vi.doUnmock('../config');
  vi.doUnmock('fs/promises');
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('seeding from ALLOWED_ADMIN_EMAILS', () => {
  // `overwatch init` writes [], and the last-admin guards keep the API and CLI
  // from producing it, so an empty list means nobody has been set up yet.
  it('seeds an empty list, so the first login after a fresh init is accepted', async () => {
    process.env.ALLOWED_ADMIN_EMAILS = 'Root@Example.com, second@example.com';
    await seed([]);
    const { getUserRole } = await import('../services/users');
    expect(await getUserRole('root@example.com')).toBe('admin');
    expect((await onDisk()).map((u: any) => u.email)).toEqual(['root@example.com', 'second@example.com']);
  });

  it('still seeds a missing file', async () => {
    process.env.ALLOWED_ADMIN_EMAILS = 'root@example.com';
    const { isAdminEmail } = await import('../services/users');
    expect(await isAdminEmail('root@example.com')).toBe(true);
    expect((await onDisk()).map((u: any) => u.email)).toEqual(['root@example.com']);
  });

  it('never re-seeds a list that has users', async () => {
    process.env.ALLOWED_ADMIN_EMAILS = 'intruder@example.com';
    await seed([rec('root@example.com', 'admin')]);
    const { getUserRole } = await import('../services/users');
    expect(await getUserRole('intruder@example.com')).toBeUndefined();
    expect((await onDisk()).map((u: any) => u.email)).toEqual(['root@example.com']);
  });

  it('leaves an empty list alone, and does not create a missing file, without seed emails', async () => {
    await seed([]);
    const users = await import('../services/users');
    expect(await users.listAdminUsers()).toEqual([]);
    expect(await onDisk()).toEqual([]);
    await fs.rm(usersFile);
    expect(await users.listAdminUsers()).toEqual([]);
    expect(await exists(usersFile)).toBe(false);
  });

  it('skips a seed email the stored schema would reject, so reads keep working', async () => {
    process.env.ALLOWED_ADMIN_EMAILS = 'good@example.com,bad..dots@example.com';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seed([]);
    const { listAdminUsers } = await import('../services/users');
    expect((await listAdminUsers()).map(u => u.email)).toEqual(['good@example.com']);
    expect((await listAdminUsers()).map(u => u.email)).toEqual(['good@example.com']);
  });

  it('seeds under the file lock: a reader waits for a writer and keeps what it wrote', async () => {
    process.env.ALLOWED_ADMIN_EMAILS = 'seed@example.com';
    const { withFileLock } = await import('../services/fileLock');
    const { getUserRole } = await import('../services/users');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let acquired!: () => void;
    const held = new Promise<void>(r => { acquired = r; });
    const writer = withFileLock('admin-users', async () => {
      acquired();
      await gate;
      await seed([rec('writer@example.com', 'editor')]);
    });
    await held;

    const reader = getUserRole('writer@example.com');
    await new Promise(r => setTimeout(r, 80));
    expect(await exists(usersFile)).toBe(false);
    release();
    await writer;
    expect(await reader).toBe('editor');
    expect((await onDisk()).map((u: any) => u.email)).toEqual(['writer@example.com']);
  });
});

describe('admin users cache', () => {
  async function countingReads() {
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    let reads = 0;
    vi.doMock('fs/promises', () => ({
      ...actual,
      readFile: (p: any, ...rest: any[]) => {
        if (String(p) === usersFile) reads++;
        return (actual.readFile as any)(p, ...rest);
      },
    }));
    return () => reads;
  }

  it('does not re-read the file while it is unchanged', async () => {
    await seed([rec('root@example.com', 'admin'), rec('v@example.com', 'viewer')]);
    const reads = await countingReads();
    const { getUserRole, isAdminEmail, listAdminUsers } = await import('../services/users');
    for (let i = 0; i < 5; i++) {
      expect(await getUserRole('root@example.com')).toBe('admin');
      expect(await isAdminEmail('v@example.com')).toBe(true);
    }
    expect((await listAdminUsers()).length).toBe(2);
    expect(reads()).toBe(1);
  });

  it('a removal written by another process (the CLI) takes effect on the next call', async () => {
    await seed([rec('root@example.com', 'admin'), rec('gone@example.com', 'editor')]);
    const { getUserRole } = await import('../services/users');
    expect(await getUserRole('gone@example.com')).toBe('editor');
    await seed([rec('root@example.com', 'admin')]);
    expect(await getUserRole('gone@example.com')).toBeUndefined();
  });

  it('a same-size in-place rewrite by another process is noticed too', async () => {
    await seed([rec('root@example.com', 'admin'), rec('e@example.com', 'editor')]);
    const { getUserRole } = await import('../services/users');
    expect(await getUserRole('e@example.com')).toBe('editor');
    const before = (await fs.stat(usersFile)).size;
    await seed([rec('root@example.com', 'admin'), rec('e@example.com', 'viewer')]);
    expect((await fs.stat(usersFile)).size).toBe(before);
    expect(await getUserRole('e@example.com')).toBe('viewer');
  });

  it('in-process writes take effect at once', async () => {
    await seed([rec('root@example.com', 'admin'), rec('e@example.com', 'editor')]);
    const { getUserRole, setAdminUserRole, removeAdminUser } = await import('../services/users');
    expect(await getUserRole('e@example.com')).toBe('editor');
    await setAdminUserRole('e@example.com', 'viewer', 'root@example.com');
    expect(await getUserRole('e@example.com')).toBe('viewer');
    await removeAdminUser('e@example.com', 'root@example.com');
    expect(await getUserRole('e@example.com')).toBeUndefined();
  });

  it('callers cannot change the cached list', async () => {
    await seed([rec('root@example.com', 'admin')]);
    const { listAdminUsers, getUserRole } = await import('../services/users');
    const list = await listAdminUsers();
    list[0].role = 'viewer';
    list.push(rec('mallory@example.com', 'admin') as any);
    expect(await getUserRole('root@example.com')).toBe('admin');
    expect(await getUserRole('mallory@example.com')).toBeUndefined();
  });
});
