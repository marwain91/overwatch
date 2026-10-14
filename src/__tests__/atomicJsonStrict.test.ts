import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { writeJsonAtomic, readJsonStrict } from '../utils/atomicJson';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-atomic-json-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe('R1 writeJsonAtomic — atomic rename', () => {
  it('writes the final file at the requested mode', async () => {
    const target = path.join(tmpRoot, 'apps.json');
    await writeJsonAtomic(target, [{ id: 'a' }, { id: 'b' }], { mode: 0o600 });
    const stat = await fs.stat(target);
    expect(stat.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(parsed).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('does not leave behind tmp files after a successful write', async () => {
    const target = path.join(tmpRoot, 'apps.json');
    await writeJsonAtomic(target, { ok: 1 });
    const siblings = await fs.readdir(tmpRoot);
    expect(siblings).toEqual(['apps.json']);
  });

  it('readJsonStrict throws a useful error on malformed JSON', async () => {
    const target = path.join(tmpRoot, 'corrupt.json');
    await fs.writeFile(target, '{not valid');
    await expect(readJsonStrict(target)).rejects.toThrow(/not valid JSON/);
  });
});


