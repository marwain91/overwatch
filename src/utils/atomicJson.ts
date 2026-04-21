import * as fs from 'fs/promises';
import { existsSync, openSync, closeSync, fsyncSync } from 'fs';
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
  const mode = opts.mode ?? 0o644;
  const spaces = opts.spaces ?? 2;
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  );
  await fs.mkdir(dir, { recursive: true });
  const content = JSON.stringify(value, null, spaces);
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

/** Convenience: check if a path exists (sync; for boot-time checks). */
export function pathExistsSync(p: string): boolean {
  return existsSync(p);
}
