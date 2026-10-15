import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { getDataDir } from '../config';
import { withFileLock } from './fileLock';
import { writeJsonAtomic } from '../utils/atomicJson';
import { ConflictError, NotFoundError, ValidationError } from '../utils/httpErrors';

export type AdminRole = 'viewer' | 'editor' | 'admin';

const AdminUserSchema = z.object({
  email: z.string().email(),
  addedAt: z.string(),
  addedBy: z.string(),
  // Role is optional for backward compatibility with existing admin-users.json
  // files. Undefined is treated as 'admin' (pre-RBAC behavior — first install
  // wins and every configured admin was unrestricted).
  role: z.enum(['viewer', 'editor', 'admin']).optional(),
});
const AdminUsersFileSchema = z.array(AdminUserSchema);

export function normaliseRole(role: AdminRole | undefined): AdminRole {
  return role ?? 'admin';
}

/**
 * Role hierarchy: admin > editor > viewer.
 * `can(actualRole, minRequired)` returns true if the user's role is at least
 * as privileged as the minimum required for the action.
 */
export function can(actual: AdminRole | undefined, min: AdminRole): boolean {
  const rank: Record<AdminRole, number> = { viewer: 1, editor: 2, admin: 3 };
  return rank[normaliseRole(actual)] >= rank[min];
}

function getAdminUsersFile(): string {
  return path.join(getDataDir(), 'admin-users.json');
}

const ADMIN_USERS_LOCK = 'admin-users';

// Initial allowed emails from environment (seed data)
const INITIAL_ALLOWED_EMAILS = [...new Set((process.env.ALLOWED_ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(e => e.length > 0))];
// Every read validates the whole file, so a seeded email the schema rejects
// would lock every user out.
const SEED_EMAILS = INITIAL_ALLOWED_EMAILS.filter(e => AdminUserSchema.shape.email.safeParse(e).success);

export interface AdminUser {
  email: string;
  addedAt: string;
  addedBy: string;
  role?: AdminRole;
}

async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(getDataDir(), { recursive: true });
  } catch (error) {
    // Directory might already exist
  }
}

/** The stored list, or null when the file does not exist. */
async function readAdminUsersFile(): Promise<AdminUser[] | null> {
  let data: string;
  try {
    data = await fs.readFile(getAdminUsersFile(), 'utf-8');
  } catch (error: any) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch (err: any) {
    throw new Error(`admin-users.json is not valid JSON (${err.message}). Refusing to auto-reset.`);
  }
  const parsed = AdminUsersFileSchema.safeParse(raw);
  if (!parsed.success) {
    const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`admin-users.json failed validation: ${errors}`);
  }
  return parsed.data;
}

// `overwatch init` writes [], and the last-admin guards keep the API and CLI
// from producing an empty list, so empty (or missing) means nobody is set up yet.
function needsSeed(users: AdminUser[] | null): boolean {
  return SEED_EMAILS.length > 0 && (users === null || users.length === 0);
}

/** Seed from ALLOWED_ADMIN_EMAILS if still needed. The caller holds the lock. */
async function seedAdminUsers(): Promise<AdminUser[]> {
  // Re-read: another request or process may have written it while this one waited.
  const users = await readAdminUsersFile();
  if (!needsSeed(users)) return users ?? [];
  const skipped = INITIAL_ALLOWED_EMAILS.filter(e => !SEED_EMAILS.includes(e));
  if (skipped.length > 0) console.warn(`[users] ALLOWED_ADMIN_EMAILS: skipping invalid email(s): ${skipped.join(', ')}`);
  const addedAt = new Date().toISOString();
  const seeded: AdminUser[] = SEED_EMAILS.map(email => ({ email, addedAt, addedBy: 'system' }));
  await saveAdminUsers(seeded);
  console.log(`[users] Seeded ${seeded.length} admin user(s) from ALLOWED_ADMIN_EMAILS`);
  return seeded;
}

/** Read from disk, seeding if needed; pass `locked` when the caller holds the lock (it is not re-entrant). */
async function readAdminUsers(opts: { locked?: boolean } = {}): Promise<AdminUser[]> {
  const users = await readAdminUsersFile();
  if (!needsSeed(users)) return users ?? [];
  return opts.locked ? seedAdminUsers() : withFileLock(ADMIN_USERS_LOCK, seedAdminUsers);
}

// Every authenticated request, WebSocket auth and MCP call resolves its caller
// here. The CLI writes the file from another process, so the cache is checked
// against the file's metadata on every call rather than trusted, and in-process
// writes drop it (an atomic rename can reuse an inode).
let usersCache: { signature: string; users: AdminUser[] } | null = null;
let usersCacheGeneration = 0;

/** Inode, size, mtime and ctime (ns) of the file; null when it is absent. */
async function fileSignature(file: string): Promise<string | null> {
  try {
    const st = await fs.stat(file, { bigint: true });
    return `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function readAdminUsersCached(): Promise<AdminUser[]> {
  const generation = usersCacheGeneration;
  // Taken before reading, so a write racing the read invalidates the entry next time.
  const signature = await fileSignature(getAdminUsersFile());
  if (signature && usersCache?.signature === signature) return structuredClone(usersCache.users);
  const users = await readAdminUsers();
  if (signature && generation === usersCacheGeneration) usersCache = { signature, users: structuredClone(users) };
  return users;
}

async function saveAdminUsers(users: AdminUser[]): Promise<void> {
  try {
    await ensureDataDir();
    await writeJsonAtomic(getAdminUsersFile(), users, { mode: 0o644 });
  } finally {
    usersCache = null;
    usersCacheGeneration++;
  }
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  return readAdminUsersCached();
}

export async function isAdminEmail(email: string): Promise<boolean> {
  const users = await readAdminUsersCached();
  return users.some(u => u.email.toLowerCase() === email.toLowerCase());
}

/** Look up the current role for an email. Returns undefined if email isn't an admin. */
export async function getUserRole(email: string): Promise<AdminRole | undefined> {
  const users = await readAdminUsersCached();
  const u = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  return u ? normaliseRole(u.role) : undefined;
}

function countAdmins(users: AdminUser[]): number {
  return users.filter(u => normaliseRole(u.role) === 'admin').length;
}

export async function addAdminUser(email: string, addedBy: string, role: AdminRole = 'viewer'): Promise<AdminUser> {
  return withFileLock(ADMIN_USERS_LOCK, async () => {
    const users = await readAdminUsers({ locked: true });
    const normalizedEmail = email.toLowerCase().trim();

    // Check if already exists
    if (users.some(u => u.email.toLowerCase() === normalizedEmail)) {
      throw new ConflictError('Admin user already exists');
    }

    const newUser: AdminUser = {
      email: normalizedEmail,
      addedAt: new Date().toISOString(),
      addedBy,
      role,
    };
    // Every read validates the whole file against this schema, so a record it
    // rejects would make every read throw and lock out every user.
    if (!AdminUserSchema.safeParse(newUser).success) {
      throw new ValidationError('Invalid email format');
    }

    users.push(newUser);
    await saveAdminUsers(users);

    return newUser;
  });
}

export async function removeAdminUser(email: string, removedBy: string): Promise<void> {
  return withFileLock(ADMIN_USERS_LOCK, async () => {
    const users = await readAdminUsers({ locked: true });
    const normalizedEmail = email.toLowerCase().trim();

    // Can't remove yourself
    if (normalizedEmail === removedBy.toLowerCase()) {
      throw new ConflictError('Cannot remove yourself from admin users');
    }

    const index = users.findIndex(u => u.email.toLowerCase() === normalizedEmail);
    if (index === -1) {
      throw new NotFoundError('Admin user not found');
    }

    // Must keep at least one admin (legacy role-less records count as admin)
    if (normaliseRole(users[index].role) === 'admin' && countAdmins(users) <= 1) {
      throw new ConflictError('Cannot remove the last admin user');
    }

    users.splice(index, 1);
    await saveAdminUsers(users);
  });
}

export async function setAdminUserRole(email: string, role: AdminRole, changedBy: string): Promise<AdminUser> {
  return withFileLock(ADMIN_USERS_LOCK, async () => {
    const users = await readAdminUsers({ locked: true });
    const normalizedEmail = email.toLowerCase().trim();

    const user = users.find(u => u.email.toLowerCase() === normalizedEmail);
    if (!user) {
      throw new NotFoundError('Admin user not found');
    }

    if (normaliseRole(user.role) === 'admin' && role !== 'admin' && countAdmins(users) <= 1) {
      throw new ConflictError('Cannot demote the last admin user');
    }

    user.role = role;
    await saveAdminUsers(users);
    console.log(`[users] ${changedBy} set role of ${normalizedEmail} to ${role}`);

    return user;
  });
}
