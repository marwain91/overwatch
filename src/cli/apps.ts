import * as fs from 'fs/promises';
import * as os from 'os';
import * as readline from 'readline';
import { applyApp, restoreApp, purgeApp } from '../services/app';
import { writeAuditEntry, flushAuditLog } from '../services/auditLog';
import { GREEN, YELLOW, RED, BOLD, NC } from './config/utils';

function usage(): void {
  console.log('');
  console.log(`  ${BOLD}Overwatch Apps${NC}`);
  console.log('');
  console.log('  Usage: overwatch apps <subcommand> [args]');
  console.log('');
  console.log('  Subcommands:');
  console.log('    apply <file|->   Upsert an app definition from a JSON file (or stdin with "-")');
  console.log('    restore <id>     Restore a soft-deleted app from the trash');
  console.log('    purge <id>       Permanently remove a trashed app (asks to retype the id; --yes skips)');
  console.log('');
}

async function readInput(arg: string): Promise<string> {
  if (arg === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf-8');
  }
  return fs.readFile(arg, 'utf-8');
}

function currentOsUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}

async function runApply(args: string[]): Promise<void> {
  const fileArg = args[0];
  if (!fileArg || fileArg === '--help' || fileArg === '-h') {
    usage();
    process.exit(fileArg ? 0 : 2);
  }

  let raw: string;
  try {
    raw = await readInput(fileArg);
  } catch (err: any) {
    console.error(`${RED}I/O error:${NC} ${err?.message || err}`);
    process.exit(3);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    console.error(`${RED}Invalid JSON:${NC} ${err?.message || err}`);
    process.exit(2);
  }

  const actor = `cli:${currentOsUser()}`;
  try {
    // applyApp runs the same write checks as the REST API (service names,
    // health-check durations, raw-label ownership, masked credentials).
    const { result, app, changedKeys } = await applyApp(parsed, actor);
    writeAuditEntry({
      user: actor,
      action: `apps.apply ${app.id}`,
      method: 'CLI',
      path: '/cli/apps/apply',
      body: { appId: app.id, result, changedKeys },
      status: 0,
      ip: 'local',
    });
    await flushAuditLog();
    const detail = result === 'updated' && changedKeys.length > 0 ? ` (changed: ${changedKeys.join(', ')})` : '';
    const colour = result === 'noop' ? YELLOW : GREEN;
    console.log(`${colour}apps.apply${NC} ${app.id} ${BOLD}${result}${NC}${detail}`);
  } catch (err: any) {
    console.error(`${RED}apps.apply failed:${NC} ${err?.message || err}`);
    process.exit(2);
  }
}

async function auditCli(action: string, appId: string): Promise<void> {
  writeAuditEntry({
    user: `cli:${currentOsUser()}`,
    action: `${action} ${appId}`,
    method: 'CLI',
    path: `/cli/${action.replace('.', '/')}`,
    body: { appId },
    status: 0,
    ip: 'local',
  });
  await flushAuditLog();
}

// The mutation already happened; a failed audit write must not report it as failed.
async function auditCliBestEffort(action: string, appId: string): Promise<void> {
  try {
    await auditCli(action, appId);
  } catch (err: any) {
    console.error(`${YELLOW}Warning:${NC} ${action} succeeded but the audit entry could not be written: ${err?.message || err}`);
  }
}

function askTypedId(appId: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`Permanently purge '${appId}'? This cannot be undone. Retype the app id to confirm: `, answer => {
      rl.close();
      resolve(answer.trim() === appId);
    });
  });
}

async function runRestore(args: string[]): Promise<void> {
  const appId = args.find(a => !a.startsWith('-'));
  if (!appId) {
    usage();
    process.exit(2);
  }
  try {
    await restoreApp(appId);
  } catch (err: any) {
    console.error(`${RED}apps.restore failed:${NC} ${err?.message || err}`);
    process.exit(2);
  }
  await auditCliBestEffort('apps.restore', appId);
  console.log(`${GREEN}apps.restore${NC} ${appId} ${BOLD}restored${NC}`);
}

async function runPurge(args: string[]): Promise<void> {
  const appId = args.find(a => !a.startsWith('-'));
  if (!appId) {
    usage();
    process.exit(2);
  }
  if (!args.includes('--yes')) {
    if (!process.stdin.isTTY) {
      console.error(`${RED}Refusing to purge without confirmation.${NC} Pass --yes to confirm non-interactively.`);
      process.exit(2);
    }
    if (!(await askTypedId(appId))) {
      console.error(`${YELLOW}Aborted:${NC} id did not match, nothing purged.`);
      process.exit(1);
    }
  }
  try {
    await purgeApp(appId);
  } catch (err: any) {
    console.error(`${RED}apps.purge failed:${NC} ${err?.message || err}`);
    process.exit(2);
  }
  await auditCliBestEffort('apps.purge', appId);
  console.log(`${GREEN}apps.purge${NC} ${appId} ${BOLD}purged${NC}`);
}

export async function runApps(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === '--help' || sub === '-h') {
    usage();
    return;
  }

  if (sub === 'apply') {
    await runApply(rest);
    return;
  }

  if (sub === 'restore') {
    await runRestore(rest);
    return;
  }

  if (sub === 'purge') {
    await runPurge(rest);
    return;
  }

  console.error(`${RED}Unknown apps subcommand:${NC} ${sub}`);
  usage();
  process.exit(1);
}
