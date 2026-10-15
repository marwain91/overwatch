import { isLegacyFormat, runPendingMigrations } from '../services/migration';
import { CURRENT_SCHEMA_VERSIONS, readSchemaVersions } from '../services/schemaVersions';
import { GREEN, YELLOW, RED, BOLD, DIM, NC } from './config/utils';

function usage(): void {
  console.log('');
  console.log(`  ${BOLD}Overwatch Migrate${NC}`);
  console.log('');
  console.log('  Usage: overwatch migrate <subcommand>');
  console.log('');
  console.log('  Subcommands:');
  console.log('    status   Show current schema versions and pending migrations');
  console.log('    up       Run any pending migrations (legacy-format detection + schema bump)');
  console.log('');
}

export async function runMigrate(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    usage();
    return;
  }

  if (sub === 'status') {
    const stored = await readSchemaVersions();
    console.log('');
    console.log(`  ${BOLD}Schema versions${NC}`);
    console.log('');
    for (const key of Object.keys(CURRENT_SCHEMA_VERSIONS) as Array<keyof typeof CURRENT_SCHEMA_VERSIONS>) {
      const current = stored[key];
      const target = CURRENT_SCHEMA_VERSIONS[key];
      const marker = current === undefined ? `${DIM}not initialised${NC}` : current === target ? `${GREEN}ok${NC}` : `${YELLOW}pending (→ v${target})${NC}`;
      console.log(`    ${key.padEnd(20)} v${current ?? '-'}   ${marker}`);
    }
    console.log('');
    if (isLegacyFormat()) {
      console.log(`  ${YELLOW}!${NC} Legacy (pre-v2) overwatch.yaml format detected.`);
      console.log(`    Run ${BOLD}overwatch migrate up${NC} to migrate.`);
      console.log('');
    }
    return;
  }

  if (sub === 'up') {
    // Same runner as the server's OVERWATCH_AUTO_MIGRATE=1 path. It records the
    // new schema versions only once every step succeeded.
    const { legacy, pending, initialised } = await runPendingMigrations(msg => console.log(`${DIM}[migrate]${NC} ${msg}`));
    if (initialised) {
      console.log(`${DIM}[migrate]${NC} initialised schema-versions.json at current versions`);
    }

    if (!legacy && pending.length === 0 && !initialised) {
      console.log(`${GREEN}✓${NC} No migrations required.`);
    } else {
      console.log('');
      console.log(`${GREEN}✓${NC} Migration complete.`);
    }
    return;
  }

  console.error(`${RED}Unknown migrate subcommand:${NC} ${sub}`);
  usage();
  process.exit(1);
}
