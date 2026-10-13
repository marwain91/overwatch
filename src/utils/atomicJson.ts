import * as fs from 'fs/promises';
import { openSync, closeSync, fsyncSync } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Write JSON atomically: serialise, write to a uniquely-named tmp file in the same
 * directory, fsync, rename over the target. Rename is atomic on POSIX, so a crash
 * mid-operation leaves either the old file or the new file — never a truncation.
 *
 * mode controls the final file permission (default 0o644). Secret files should use
 * writeSecretFile() from utils/security.ts instead.
 */
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  opts: { mode?: number; spaces?: number } = {}
): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, opts.spaces ?? 2), { mode: opts.mode ?? 0o644 });
}

/**
 * Write a file atomically (tmp file in the same directory, fsync, rename).
 * Not for files that are bind-mounted individually into containers: the rename
 * swaps the inode and the container keeps seeing the old one.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  opts: { mode?: number } = {}
): Promise<void> {
  // Without an explicit mode an existing target keeps its own; new files get 0644.
  const mode = opts.mode ?? (await fs.stat(filePath).then(st => st.mode & 0o777, () => 0o644));
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  );
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(tmp, content, { mode });
    // fsync the file so the contents hit disk before the rename commits the name.
    const fd = openSync(tmp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Read JSON. Throws a clear, actionable error on malformed JSON rather than silently
 * returning a default — malformed state should never auto-heal to an empty file.
 */
export async function readJsonStrict<T = unknown>(filePath: string): Promise<T> {
  const data = await fs.readFile(filePath, 'utf-8');
  try {
    return JSON.parse(data) as T;
  } catch (err: any) {
    throw new Error(
      `${path.basename(filePath)} is not valid JSON (${err.message}). ` +
      `File path: ${filePath}. Refusing to auto-reset.`
    );
  }
}
