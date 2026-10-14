import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-jsonl-prune-'));
  vi.doMock('../config', () => ({ getDataDir: () => dir }));
});

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('../config');
  vi.doUnmock('../utils/atomicJson');
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('JsonlLog prune on a bind-mounted file', () => {
  for (const code of ['EBUSY', 'EXDEV', 'EPERM']) {
    it(`rewrites in place when rename fails with ${code}`, async () => {
      vi.doMock('../utils/atomicJson', () => ({
        writeFileAtomic: vi.fn(async () => { throw Object.assign(new Error('rename failed'), { code }); }),
      }));
      const file = path.join(dir, 'audit.log');
      await fs.writeFile(file, ['a', 'b', 'c', 'd'].join('\n') + '\n', { mode: 0o640 });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { JsonlLog } = await import('../utils/jsonlLog');
      const log = new JsonlLog(() => file, 'test');
      expect(await log.prune(2)).toBe(2);
      expect(await fs.readFile(file, 'utf-8')).toBe('c\nd\n');
      expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
      await fs.writeFile(file, 'x\ny\nz\n');
      expect(await log.prune(1)).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  }

  it('still surfaces unrelated write errors', async () => {
    vi.doMock('../utils/atomicJson', () => ({
      writeFileAtomic: vi.fn(async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }),
    }));
    const file = path.join(dir, 'audit.log');
    await fs.writeFile(file, 'a\nb\nc\n');
    const { JsonlLog } = await import('../utils/jsonlLog');
    await expect(new JsonlLog(() => file, 'test').prune(1)).rejects.toThrow('disk full');
    expect(await fs.readFile(file, 'utf-8')).toBe('a\nb\nc\n');
  });
});
