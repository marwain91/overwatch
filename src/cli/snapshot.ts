import { createSnapshot, listSnapshots, restoreSnapshot, pruneOldSnapshots } from '../services/configSnapshots';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const NC = '\x1b[0m';

function usage(): void {
  console.log('');
  console.log(`  ${BOLD}Overwatch Snapshot${NC}`);
  console.log('');
  console.log('  Usage: overwatch snapshot <subcommand>');
  console.log('');
  console.log('  Subcommands:');
  console.log('    create [label]    Snapshot apps.d/, apps.runtime.json, env-vars.json, and related state');
  console.log('    list              List existing snapshots');
  console.log('    restore <name>    Restore the named snapshot (pre-restore snapshot is made first)');
  console.log('    prune [--keep N]  Prune old snapshots, keeping the N most recent (default 30)');
  console.log('');
}

export async function runSnapshot(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    usage();
    return;
  }

  if (sub === 'create') {
    const info = await createSnapshot(args[1]);
    console.log(`${GREEN}✓${NC} Snapshot ${BOLD}${info.name}${NC}`);
    console.log(`  ${DIM}${info.files.length} file(s), ${info.totalBytes} bytes${NC}`);
    return;
  }

  if (sub === 'list') {
    const snaps = await listSnapshots();
    if (snaps.length === 0) {
      console.log(`${DIM}(no snapshots)${NC}`);
      return;
    }
    for (const s of snaps) {
      console.log(`  ${s.name}   ${DIM}${s.files.length} file(s), ${s.totalBytes} B${NC}`);
    }
    return;
  }

  if (sub === 'restore') {
    const name = args[1];
    if (!name) {
      console.error(`${RED}snapshot restore requires a snapshot name${NC}`);
      process.exit(1);
    }
    await restoreSnapshot(name);
    console.log(`${GREEN}✓${NC} Restored from ${BOLD}${name}${NC}`);
    console.log(`  ${YELLOW}!${NC} Restart Overwatch to pick up the restored state.`);
    return;
  }

  if (sub === 'prune') {
    const keepIdx = args.indexOf('--keep');
    const keep = keepIdx !== -1 && args[keepIdx + 1] ? Number(args[keepIdx + 1]) : 30;
    const pruned = await pruneOldSnapshots(keep);
    console.log(`${GREEN}✓${NC} Pruned ${pruned} snapshot(s), kept ${keep} most recent.`);
    return;
  }

  console.error(`${RED}Unknown snapshot subcommand:${NC} ${sub}`);
  usage();
  process.exit(1);
}
