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

describe('JsonlLog prune byte cap', () => {
  it('keeps only the newest lines that fit in maxBytes, and the entry cap still applies', async () => {
    const file = path.join(dir, 'audit.log');
    await fs.writeFile(file, Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n') + '\n', { mode: 0o600 });
    const { JsonlLog } = await import('../utils/jsonlLog');
    const log = new JsonlLog(() => file, 'test');
    expect(await log.prune(100, 22)).toBe(7); // 7 bytes per line: three fit
    expect(await fs.readFile(file, 'utf-8')).toBe('line-7\nline-8\nline-9\n');
    expect(await log.prune(2, 1000)).toBe(1);
    expect(await fs.readFile(file, 'utf-8')).toBe('line-8\nline-9\n');
    expect(await log.prune(100, 1000)).toBe(0);
    expect(await fs.readFile(file, 'utf-8')).toBe('line-8\nline-9\n');
  });

  it('treats an entry cap of 0 as no entry cap, as before, while the byte cap still applies', async () => {
    const file = path.join(dir, 'audit.log');
    await fs.writeFile(file, 'a\nb\nc\n');
    const { JsonlLog } = await import('../utils/jsonlLog');
    const log = new JsonlLog(() => file, 'test');
    expect(await log.prune(0)).toBe(0);
    expect(await fs.readFile(file, 'utf-8')).toBe('a\nb\nc\n');
    expect(await log.prune(0, 4)).toBe(1);
    expect(await fs.readFile(file, 'utf-8')).toBe('b\nc\n');
  });
});

describe('readLinesReverse', () => {
  async function collect(content: string | Buffer, chunkSize: number) {
    const file = path.join(dir, 'log');
    await fs.writeFile(file, content);
    const { readLinesReverse } = await import('../utils/jsonlLog');
    const out: string[] = [];
    for await (const line of readLinesReverse(file, chunkSize)) out.push(line);
    return out;
  }

  it('yields lines newest first across chunk boundaries, including multi-byte text split by a chunk', async () => {
    const lines = ['first', 'zweite \u00e9\u00e8 \u{1F600}', '', 'x'.repeat(50), 'last-no-newline'];
    for (const chunk of [1, 2, 3, 7, 64, 4096]) {
      expect(await collect(lines.join('\n'), chunk)).toEqual(['last-no-newline', 'x'.repeat(50), 'zweite \u00e9\u00e8 \u{1F600}', 'first']);
    }
    expect(await collect('a\nb\n\n', 2)).toEqual(['b', 'a']);
    expect(await collect('', 8)).toEqual([]);
  });

  it('stops reading as soon as the caller stops iterating', async () => {
    const file = path.join(dir, 'log');
    await fs.writeFile(file, Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n') + '\n');
    const { readLinesReverse } = await import('../utils/jsonlLog');
    const seen: string[] = [];
    for await (const line of readLinesReverse(file, 16)) {
      seen.push(line);
      if (seen.length === 3) break;
    }
    expect(seen).toEqual(['l999', 'l998', 'l997']);
  });

  it('throws ENOENT for a missing file', async () => {
    const { readLinesReverse } = await import('../utils/jsonlLog');
    await expect(readLinesReverse(path.join(dir, 'missing'))[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
