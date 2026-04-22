import * as fs from 'fs/promises';
import * as os from 'os';
import { applyApp } from '../services/app';
import { writeAuditEntry, flushAuditLog } from '../middleware/audit';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const NC = '\x1b[0m';

function usage(): void {
  console.log('');
  console.log(`  ${BOLD}Overwatch Apps${NC}`);
  console.log('');
  console.log('  Usage: overwatch apps <subcommand> [args]');
  console.log('');
  console.log('  Subcommands:');
  console.log('    apply <file|->   Upsert an app definition from a JSON file (or stdin with "-")');
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

  console.error(`${RED}Unknown apps subcommand:${NC} ${sub}`);
  usage();
  process.exit(1);
}
