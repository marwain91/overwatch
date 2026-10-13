import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { findConfigPath, clearConfigCache, getDataDir } from './loader';
import { OverwatchConfigSchema } from './schema';
import { withFileLock } from '../services/fileLock';
import { ValidationError } from '../utils/httpErrors';

const LOCK_KEY = 'overwatch-config';

export function dumpOverwatchYaml(raw: Record<string, any>): string {
  return yaml.dump(raw, { lineWidth: 120, noRefs: true });
}

function assertValid(raw: Record<string, any>): void {
  const parse = OverwatchConfigSchema.safeParse(raw);
  if (!parse.success) {
    const errors = parse.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new ValidationError(`Resulting overwatch.yaml would be invalid: ${errors}`);
  }
}

/**
 * Caller must hold the config lock.
 *
 * overwatch.yaml is bind-mounted into the container as a *single file*, and
 * its parent dir is not writable by the runtime user, so write-temp-then-rename
 * fails (and would swap the inode, stranding the container's view). Instead:
 *   1. write + fsync a complete scratch file in the data dir,
 *   2. copyFile scratch -> target (opens the target O_TRUNC, keeping the inode),
 *   3. fsync the target, delete the scratch file.
 * Validation happens before any byte of the target is touched.
 */
async function writeUnlocked(raw: Record<string, any>): Promise<void> {
  assertValid(raw);
  const configPath = findConfigPath();
  const content = dumpOverwatchYaml(raw);

  const scratchDir = path.join(getDataDir(), '.config-tmp');
  await fs.mkdir(scratchDir, { recursive: true });
  const scratch = path.join(scratchDir, `overwatch.yaml.${process.pid}.${Date.now()}`);

  try {
    const sfh = await fs.open(scratch, 'w', 0o644);
    try {
      await sfh.writeFile(content);
      await sfh.sync();
    } finally {
      await sfh.close();
    }

    await fs.copyFile(scratch, configPath);

    // Best-effort: some bind-mount setups disallow opening RW-for-fsync; the
    // copyFile bytes are already written.
    try {
      const tfh = await fs.open(configPath, 'r+');
      try { await tfh.sync(); } finally { await tfh.close(); }
    } catch {
      /* non-fatal */
    }
  } finally {
    await fs.unlink(scratch).catch(() => {});
  }

  clearConfigCache();
}

/** Validate, then persist `raw` as overwatch.yaml under the config lock. */
export async function writeOverwatchConfig(raw: Record<string, any>): Promise<void> {
  return withFileLock(LOCK_KEY, () => writeUnlocked(raw));
}

/**
 * Read-modify-write overwatch.yaml atomically with respect to other writers:
 * the file is read inside the lock, so concurrent updates never lose changes.
 * `mutate` may edit the object in place or return a replacement.
 */
export async function updateOverwatchConfig<T = void>(
  mutate: (raw: Record<string, any>) => T | Promise<T>,
): Promise<T> {
  return withFileLock(LOCK_KEY, async () => {
    const content = await fs.readFile(findConfigPath(), 'utf-8');
    const raw = (yaml.load(content) as Record<string, any>) ?? {};
    const result = await mutate(raw);
    await writeUnlocked(raw);
    return result;
  });
}
