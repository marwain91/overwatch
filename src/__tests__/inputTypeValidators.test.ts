import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { isValidSlug, isValidSnapshotId, isValidContainerId, isValidEmail } from '../utils/validators';
import { readRegularFile } from '../utils/regularFile';

describe('request-input validators reject non-strings', () => {
  // RegExp.test stringifies its argument: ["abc"] becomes "abc".
  it.each([
    ['isValidSlug', isValidSlug, 'abc'],
    ['isValidSnapshotId', isValidSnapshotId, 'abcdef12'],
    ['isValidContainerId', isValidContainerId, 'abcdef123456'],
    ['isValidEmail', isValidEmail, 'a@example.com'],
  ] as const)('%s', (_name, validate, good) => {
    expect(validate(good)).toBe(true);
    expect(validate([good])).toBe(false);
    expect(validate({ toString: () => good })).toBe(false);
    expect(validate(undefined)).toBe(false);
    expect(validate(null)).toBe(false);
    expect(validate(123456789012)).toBe(false);
  });
});

describe('readRegularFile', () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });

  it('reads a regular file and refuses a symlink to one', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-regular-file-'));
    const real = path.join(dir, 'real.env');
    const link = path.join(dir, 'link.env');
    await fs.writeFile(real, 'A=1\n', { mode: 0o600 });
    await fs.symlink(real, link);

    const read = await readRegularFile(real);
    expect(read?.data.toString()).toBe('A=1\n');
    expect(read?.mode).toBe(0o600);
    expect(await readRegularFile(link)).toBeNull();
    expect(await readRegularFile(dir)).toBeNull();
    await expect(readRegularFile(path.join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
