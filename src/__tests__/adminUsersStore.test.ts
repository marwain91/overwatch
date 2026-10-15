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
