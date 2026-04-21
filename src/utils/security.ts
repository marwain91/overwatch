import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

/** Verify that a resolved path stays within an expected parent directory */
export async function assertWithinDir(childPath: string, parentDir: string): Promise<void> {
  const realChild = await fs.realpath(childPath);
  const realParent = await fs.realpath(parentDir);
  if (!realChild.startsWith(realParent + '/') && realChild !== realParent) {
    throw new Error(`Path ${childPath} resolves outside of expected directory`);
  }
}

/**
 * Write a file containing secrets with 0600 (owner-only) permissions.
 * Atomic: writes to tmp then renames. The chmod before rename eliminates the
 * window where the final file exists at 0644 (umask) before being tightened.
 */
export async function writeSecretFile(filePath: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  try {
    await fs.writeFile(tmp, content, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Validate that a database/user name contains only safe characters */
export function assertSafeIdentifier(name: string, maxLength: number = 63): void {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe database identifier: ${name}`);
  }
  if (name.length > maxLength) {
    throw new Error(`Database identifier too long: ${name}`);
  }
}
