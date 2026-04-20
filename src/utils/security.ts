import * as fs from 'fs/promises';

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
 * mode: in writeFile only applies on create, so we chmod to also tighten existing files.
 */
export async function writeSecretFile(filePath: string, content: string | Buffer): Promise<void> {
  await fs.writeFile(filePath, content, { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
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
