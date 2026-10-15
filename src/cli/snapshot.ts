import { createSnapshot, listSnapshots, restoreSnapshot, pruneOldSnapshots } from '../services/configSnapshots';
import { GREEN, YELLOW, RED, BOLD, DIM, NC } from './config/utils';

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
  console.log('    prune [--keep N]  Prune old snapshots, keeping the N most recent (default 30, at least 1)');
  console.log('                      plus up to min(N, 10) boot snapshots; pre-restore snapshots are kept');
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
    const preRestore = await restoreSnapshot(name);
    console.log(`${GREEN}✓${NC} Restored from ${BOLD}${name}${NC}`);
    console.log(`  ${DIM}Previous state saved as ${preRestore.name}${NC}`);
    console.log(`  ${YELLOW}!${NC} Restart Overwatch to pick up the restored state.`);
    return;
  }

  if (sub === 'prune') {
    const keepIdx = args.indexOf('--keep');
    const keepArg = keepIdx === -1 ? '30' : args[keepIdx + 1];
    // `--keep 0` used to delete every snapshot but the pre-restore ones.
    if (!keepArg || !/^\d+$/.test(keepArg) || Number(keepArg) < 1) {
      console.error(`${RED}--keep must be a whole number of at least 1${NC} (got ${keepArg ?? 'nothing'})`);
      process.exit(1);
    }
    const keep = Number(keepArg);
    const pruned = await pruneOldSnapshots(keep);
    console.log(`${GREEN}✓${NC} Pruned ${pruned} snapshot(s), kept ${keep} most recent.`);
    return;
  }

  console.error(`${RED}Unknown snapshot subcommand:${NC} ${sub}`);
  usage();
  process.exit(1);
}
