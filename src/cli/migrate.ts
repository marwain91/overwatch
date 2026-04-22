import { isLegacyFormat, runMigration } from '../services/migration';
import { CURRENT_SCHEMA_VERSIONS, readSchemaVersions, writeSchemaVersions, findPendingMigrations } from '../services/schemaVersions';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const NC = '\x1b[0m';

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
    let ranSomething = false;
    if (isLegacyFormat()) {
      console.log(`${BOLD}Running legacy → multi-app migration...${NC}`);
      await runMigration();
      ranSomething = true;
    }

    const stored = await readSchemaVersions();
    const pending = findPendingMigrations(stored);
    if (pending.length > 0) {
      for (const { store, from, to } of pending) {
        if (store === 'apps' && from < 3 && to >= 3) {
          console.log(`${DIM}[migrate]${NC} apps: v${from} → v${to} running...`);
          const { runAppsV3Migration } = await import('../services/migration');
          await runAppsV3Migration();
        } else {
          console.log(`${DIM}[migrate]${NC} ${store}: v${from} → v${to} (no transform required)`);
        }
      }
      await writeSchemaVersions(CURRENT_SCHEMA_VERSIONS);
      ranSomething = true;
    }

    // Initialise the marker if missing so future boots know the schema baseline.
    if (Object.keys(stored).length === 0) {
      await writeSchemaVersions(CURRENT_SCHEMA_VERSIONS);
      console.log(`${DIM}[migrate]${NC} initialised schema-versions.json at current versions`);
      ranSomething = true;
    }

    if (!ranSomething) {
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
