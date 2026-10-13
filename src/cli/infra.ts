import * as path from 'path';
import { findConfigPath } from '../config/loader';
import { deployInfra, InfraFileChange } from '../services/infraTemplates';
import { GREEN, YELLOW, RED, BOLD, DIM, NC } from './config/utils';

function usage(): void {
  console.log('');
  console.log(`  ${BOLD}Overwatch Infra${NC}`);
  console.log('');
  console.log('  Usage: overwatch infra <subcommand>');
  console.log('');
  console.log('  Subcommands:');
  console.log('    deploy [--dry-run] [--allow-db-downgrade]');
  console.log('                         Render the infra templates, write to the');
  console.log('                         deploy directory, and run `docker compose up -d`');
  console.log('                         on the infrastructure stack (Traefik + database).');
  console.log('                         Refuses to replace a running database with an older');
  console.log('                         version unless --allow-db-downgrade is given.');
  console.log('');
}

/**
 * Locate the operator's deploy root. By convention this is the directory
 * that contains overwatch/, infrastructure/, and apps/ — i.e. the parent
 * of the dir containing overwatch.yaml.
 */
function resolveDeployDir(): string {
  // DEPLOY_DIR is the documented override shared with the other commands
  // (findDeployDir can't be reused: it requires infrastructure/ to exist,
  // which this command creates). OVERWATCH_DEPLOY_DIR is kept for back-compat.
  const fromEnv = process.env.DEPLOY_DIR || process.env.OVERWATCH_DEPLOY_DIR;
  if (fromEnv) {
    return fromEnv;
  }
  const configPath = findConfigPath();
  // overwatch.yaml lives at <deployDir>/overwatch/overwatch.yaml
  return path.resolve(path.dirname(configPath), '..');
}

function formatChange(c: InfraFileChange): string {
  const badge =
    c.status === 'created' ? `${GREEN}created${NC}` :
    c.status === 'updated' ? `${YELLOW}updated${NC}` :
    `${DIM}unchanged${NC}`;
  return `  ${badge}  ${c.path}`;
}

async function runDeploy(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const allowDbDowngrade = args.includes('--allow-db-downgrade');
  const deployDir = resolveDeployDir();
  console.log(`${BOLD}overwatch infra deploy${NC}${dryRun ? ` ${DIM}(dry-run)${NC}` : ''}`);
  console.log(`  deploy dir: ${deployDir}`);
  console.log('');

  const result = await deployInfra({ deployDir, dryRun, allowDbDowngrade });
  for (const change of result.changes) {
    console.log(formatChange(change));
  }

  const createdOrUpdated = result.changes.filter(c => c.status !== 'unchanged').length;
  console.log('');
  if (dryRun) {
    console.log(`${YELLOW}Dry run — no files written, no compose run.${NC}`);
    console.log(`  ${createdOrUpdated} file(s) would change. Re-run without --dry-run to apply.`);
    return;
  }

  if (result.composeRestarted) {
    console.log(`${GREEN}✓${NC} Infrastructure compose reconciled (${createdOrUpdated} file(s) changed).`);
    console.log(`  ${DIM}Overwatch container not touched — restart manually if overwatch/docker-compose.yml changed.${NC}`);
  }
}

export async function runInfra(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === '--help' || sub === '-h') {
    usage();
    return;
  }
  if (sub === 'deploy') {
    try {
      await runDeploy(rest);
    } catch (err: any) {
      console.error(`${RED}infra deploy failed:${NC} ${err?.message || err}`);
      process.exit(3);
    }
    return;
  }
  console.error(`${RED}Unknown infra subcommand:${NC} ${sub}`);
  usage();
  process.exit(1);
}
