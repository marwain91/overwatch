import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { writeFileAtomic } from '../utils/atomicJson';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-atomic-')); });
afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('fs/promises');
  await fs.rm(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('replaces the target with the requested mode and leaves no temp file', async () => {
    const f = path.join(dir, 'docker-compose.yml');
    await fs.writeFile(f, 'old', { mode: 0o644 });
    await writeFileAtomic(f, 'new', { mode: 0o600 });
    expect(await fs.readFile(f, 'utf-8')).toBe('new');
    expect((await fs.stat(f)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(dir)).toEqual(['docker-compose.yml']);
  });

  it('defaults to 0644', async () => {
    const f = path.join(dir, 'a.txt');
    await writeFileAtomic(f, 'x');
    expect((await fs.stat(f)).mode & 0o777).toBe(0o644);
  });

  it('keeps the existing file mode when none is given', async () => {
    const f = path.join(dir, 'c.yml');
    await fs.writeFile(f, 'old', { mode: 0o640 });
    await fs.chmod(f, 0o640);
    await writeFileAtomic(f, 'new');
    expect((await fs.stat(f)).mode & 0o777).toBe(0o640);
  });

  it('cleans up its temp file when the rename fails', async () => {
    const target = path.join(dir, 'is-a-dir');
    await fs.mkdir(target);
    await expect(writeFileAtomic(target, 'x')).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual(['is-a-dir']);
  });

  it('surfaces a stat failure other than ENOENT instead of falling back to 0644', async () => {
    const f = path.join(dir, 'locked.yml');
    await fs.writeFile(f, 'old', { mode: 0o640 });
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    vi.doMock('fs/promises', () => ({
      ...actual,
      stat: (p: any, ...rest: any[]) => String(p) === f
        ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
        : (actual.stat as any)(p, ...rest),
    }));
    const { writeFileAtomic: write } = await import('../utils/atomicJson');
    await expect(write(f, 'new')).rejects.toThrow('EACCES');
    expect(await fs.readFile(f, 'utf-8')).toBe('old');
    expect(await fs.readdir(dir)).toEqual(['locked.yml']);
  });
});
