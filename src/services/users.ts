import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { getDataDir } from '../config';
import { withFileLock } from './fileLock';
import { writeJsonAtomic } from '../utils/atomicJson';

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

// Initial allowed emails from environment (seed data)
const INITIAL_ALLOWED_EMAILS = (process.env.ALLOWED_ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(e => e.length > 0);

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

async function readAdminUsers(): Promise<AdminUser[]> {
  let data: string;
  try {
    data = await fs.readFile(getAdminUsersFile(), 'utf-8');
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // File doesn't exist, initialize with env var emails
      const initialUsers: AdminUser[] = INITIAL_ALLOWED_EMAILS.map(email => ({
        email,
        addedAt: new Date().toISOString(),
        addedBy: 'system',
      }));
      await saveAdminUsers(initialUsers);
      return initialUsers;
    }
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

async function saveAdminUsers(users: AdminUser[]): Promise<void> {
  await ensureDataDir();
  await writeJsonAtomic(getAdminUsersFile(), users, { mode: 0o644 });
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  return readAdminUsers();
}

export async function isAdminEmail(email: string): Promise<boolean> {
  const users = await readAdminUsers();
  return users.some(u => u.email.toLowerCase() === email.toLowerCase());
}

/** Look up the current role for an email. Returns undefined if email isn't an admin. */
export async function getUserRole(email: string): Promise<AdminRole | undefined> {
  const users = await readAdminUsers();
  const u = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  return u ? normaliseRole(u.role) : undefined;
}

export async function addAdminUser(email: string, addedBy: string): Promise<AdminUser> {
  return withFileLock('admin-users', async () => {
    const users = await readAdminUsers();
    const normalizedEmail = email.toLowerCase().trim();

    // Check if already exists
    if (users.some(u => u.email.toLowerCase() === normalizedEmail)) {
      throw new Error('Admin user already exists');
    }

    const newUser: AdminUser = {
      email: normalizedEmail,
      addedAt: new Date().toISOString(),
      addedBy,
    };

    users.push(newUser);
    await saveAdminUsers(users);

    return newUser;
  });
}

export async function removeAdminUser(email: string, removedBy: string): Promise<void> {
  return withFileLock('admin-users', async () => {
    const users = await readAdminUsers();
    const normalizedEmail = email.toLowerCase().trim();

    // Can't remove yourself
    if (normalizedEmail === removedBy.toLowerCase()) {
      throw new Error('Cannot remove yourself from admin users');
    }

    // Must have at least one admin
    if (users.length <= 1) {
      throw new Error('Cannot remove the last admin user');
    }

    const index = users.findIndex(u => u.email.toLowerCase() === normalizedEmail);
    if (index === -1) {
      throw new Error('Admin user not found');
    }

    users.splice(index, 1);
    await saveAdminUsers(users);
  });
}
