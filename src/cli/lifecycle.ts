import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const NC = '\x1b[0m';

function findDeployDir(): string {
  // Check DEPLOY_DIR env, then try cwd, then common paths
  if (process.env.DEPLOY_DIR) return process.env.DEPLOY_DIR;

  const cwd = process.cwd();
  // If cwd has infrastructure/ and overwatch/ subdirs, use it
  if (fs.existsSync(path.join(cwd, 'infrastructure')) && fs.existsSync(path.join(cwd, 'overwatch'))) {
    return cwd;
  }
  // If cwd IS the overwatch/ dir, go up one level
  if (fs.existsSync(path.join(cwd, 'overwatch.yaml')) && fs.existsSync(path.join(cwd, '..', 'infrastructure'))) {
    return path.dirname(cwd);
  }

  throw new Error(
    'Cannot find deploy directory. Run from the deploy root (containing infrastructure/ and overwatch/), or set DEPLOY_DIR.',
  );
}

function compose(dir: string, args: string): void {
  execSync(`docker compose ${args}`, { stdio: 'inherit', cwd: dir });
}

export async function runStart(): Promise<void> {
  const base = findDeployDir();
  const infra = path.join(base, 'infrastructure');
  const ow = path.join(base, 'overwatch');

  console.log(`${GREEN}Starting infrastructure...${NC}`);
  compose(infra, 'up -d');

  console.log(`${GREEN}Starting Overwatch...${NC}`);
  compose(ow, 'up -d');

  console.log(`\n${GREEN}All services started.${NC}`);
}

export async function runStop(): Promise<void> {
  const base = findDeployDir();
  const ow = path.join(base, 'overwatch');
  const infra = path.join(base, 'infrastructure');

  console.log(`${GREEN}Stopping Overwatch...${NC}`);
  compose(ow, 'down');

  console.log(`${GREEN}Stopping infrastructure...${NC}`);
  compose(infra, 'down');

  console.log(`\n${GREEN}All services stopped.${NC}`);
}

export async function runRestart(): Promise<void> {
  const base = findDeployDir();
  const infra = path.join(base, 'infrastructure');
  const ow = path.join(base, 'overwatch');

  console.log(`${GREEN}Restarting infrastructure...${NC}`);
  compose(infra, 'restart');

  console.log(`${GREEN}Restarting Overwatch...${NC}`);
  compose(ow, 'restart');

  console.log(`\n${GREEN}All services restarted.${NC}`);
}

export async function runStatus(): Promise<void> {
  const base = findDeployDir();
  const infra = path.join(base, 'infrastructure');
  const ow = path.join(base, 'overwatch');

  console.log(`${GREEN}Infrastructure:${NC}`);
  compose(infra, 'ps');

  console.log(`\n${GREEN}Overwatch:${NC}`);
  compose(ow, 'ps');
}
