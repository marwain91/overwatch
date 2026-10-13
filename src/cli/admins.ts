import { listAdminUsers, addAdminUser, removeAdminUser, setAdminUserRole, normaliseRole, AdminRole } from '../services/users';
import { header, success, info, BOLD, DIM, NC } from './config/utils';

export async function runAdmins(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === '--help' || subcommand === '-h') {
    showHelp();
    return;
  }

  switch (subcommand) {
    case 'list':
    case undefined:
      return runList();
    case 'add':
      return runAdd(args.slice(1));
    case 'role':
      return runRole(args.slice(1));
    case 'remove':
      return runRemove(args.slice(1));
    default:
      console.error(`Unknown admins subcommand: ${subcommand}`);
      console.error('Run "overwatch admins --help" for usage.');
      process.exit(1);
  }
}

const ROLES: AdminRole[] = ['viewer', 'editor', 'admin'];

function parseRole(value: string | undefined): AdminRole {
  if (!value || !ROLES.includes(value as AdminRole)) {
    throw new Error(`Invalid role "${value ?? ''}". Must be one of: ${ROLES.join(', ')}`);
  }
  return value as AdminRole;
}

async function runList(): Promise<void> {
  const users = await listAdminUsers();

  header('Admin Users');

  if (users.length === 0) {
    info('No admin users configured.');
    console.log('');
    return;
  }

  for (const user of users) {
    const date = new Date(user.addedAt).toLocaleDateString();
    console.log(`  ${BOLD}${user.email}${NC}  ${DIM}${normaliseRole(user.role)}, added ${date} by ${user.addedBy}${NC}`);
  }

  console.log('');
  info(`${users.length} admin(s) total`);
  console.log('');
}

async function runAdd(args: string[]): Promise<void> {
  let role: AdminRole | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--role') {
      role = parseRole(args[++i]);
    } else if (args[i].startsWith('--role=')) {
      role = parseRole(args[i].slice('--role='.length));
    } else if (!args[i].startsWith('--')) {
      positional.push(args[i]);
    }
  }
  const email = positional[0];

  if (!email) {
    throw new Error('Email is required. Usage: overwatch admins add <email> [--role viewer|editor|admin]');
  }

  const user = await addAdminUser(email, 'cli', role);
  success(`Added user: ${user.email} (${normaliseRole(user.role)})`);
}

async function runRole(args: string[]): Promise<void> {
  const [email, role] = args.filter(a => !a.startsWith('--'));

  if (!email || !role) {
    throw new Error('Usage: overwatch admins role <email> <viewer|editor|admin>');
  }

  const user = await setAdminUserRole(email, parseRole(role), 'cli');
  success(`Set role of ${user.email} to ${normaliseRole(user.role)}`);
}

async function runRemove(args: string[]): Promise<void> {
  const email = args.find(a => !a.startsWith('--'));

  if (!email) {
    throw new Error('Email is required. Usage: overwatch admins remove <email>');
  }

  await removeAdminUser(email, 'cli');
  success(`Removed admin: ${email.toLowerCase().trim()}`);
}

function showHelp(): void {
  console.log('');
  console.log(`  ${BOLD}overwatch admins${NC} — Manage users and their roles`);
  console.log('');
  console.log('  Usage: overwatch admins <subcommand> [options]');
  console.log('');
  console.log('  Subcommands:');
  console.log(`    list                        List all users and roles (default)`);
  console.log(`    add ${DIM}<email>${NC}                 Add a user`);
  console.log(`    remove ${DIM}<email>${NC}              Remove an admin user`);
  console.log('');
  console.log('  Examples:');
  console.log(`    ${DIM}overwatch admins${NC}                         List all admins`);
  console.log(`    ${DIM}overwatch admins add user@example.com${NC}    Add a new viewer`);
  console.log(`    ${DIM}overwatch admins add user@example.com --role editor${NC}  Add an editor`);
  console.log(`    ${DIM}overwatch admins role user@example.com admin${NC}         Promote to admin`);
  console.log(`    ${DIM}overwatch admins remove user@example.com${NC} Remove an admin`);
  console.log('');
}
