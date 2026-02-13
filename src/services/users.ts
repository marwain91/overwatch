import * as fs from 'fs/promises';
import * as path from 'path';
import { getDataDir } from '../config';
import { withFileLock } from './fileLock';

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
}

async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(getDataDir(), { recursive: true });
  } catch (error) {
    // Directory might already exist
  }
}

async function readAdminUsers(): Promise<AdminUser[]> {
  try {
    const data = await fs.readFile(getAdminUsersFile(), 'utf-8');
    return JSON.parse(data);
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
}

async function saveAdminUsers(users: AdminUser[]): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(getAdminUsersFile(), JSON.stringify(users, null, 2));
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  return readAdminUsers();
}

export async function isAdminEmail(email: string): Promise<boolean> {
  const users = await readAdminUsers();
  return users.some(u => u.email.toLowerCase() === email.toLowerCase());
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
