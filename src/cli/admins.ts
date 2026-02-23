import { listAdminUsers, addAdminUser, removeAdminUser } from '../services/users';
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
    case 'remove':
      return runRemove(args.slice(1));
    default:
      console.error(`Unknown admins subcommand: ${subcommand}`);
      console.error('Run "overwatch admins --help" for usage.');
      process.exit(1);
  }
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
    console.log(`  ${BOLD}${user.email}${NC}  ${DIM}added ${date} by ${user.addedBy}${NC}`);
  }

  console.log('');
  info(`${users.length} admin(s) total`);
  console.log('');
}

async function runAdd(args: string[]): Promise<void> {
  const email = args.find(a => !a.startsWith('--'));

  if (!email) {
    throw new Error('Email is required. Usage: overwatch admins add <email>');
  }

  const user = await addAdminUser(email, 'cli');
  success(`Added admin: ${user.email}`);
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
  console.log(`  ${BOLD}overwatch admins${NC} — Manage admin users`);
  console.log('');
  console.log('  Usage: overwatch admins <subcommand> [options]');
  console.log('');
  console.log('  Subcommands:');
  console.log(`    list                        List all admin users (default)`);
  console.log(`    add ${DIM}<email>${NC}                 Add an admin user`);
  console.log(`    remove ${DIM}<email>${NC}              Remove an admin user`);
  console.log('');
  console.log('  Examples:');
  console.log(`    ${DIM}overwatch admins${NC}                         List all admins`);
  console.log(`    ${DIM}overwatch admins add user@example.com${NC}    Add a new admin`);
  console.log(`    ${DIM}overwatch admins remove user@example.com${NC} Remove an admin`);
  console.log('');
}
