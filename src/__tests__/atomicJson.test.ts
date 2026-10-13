import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { writeFileAtomic } from '../utils/atomicJson';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-atomic-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

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

  it('cleans up its temp file when the rename fails', async () => {
    const target = path.join(dir, 'is-a-dir');
    await fs.mkdir(target);
    await expect(writeFileAtomic(target, 'x')).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual(['is-a-dir']);
  });
});
