import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { execSync } from 'child_process';
import { VERSION } from '../version';
import { findConfigPath } from '../config/loader';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

export function findDeployDir(): string {
  // Check DEPLOY_DIR env first
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

  // Derive from config file location: config is at {deploy}/overwatch/overwatch.yaml
  try {
    const configPath = findConfigPath();
    const overwatchDir = path.dirname(configPath);
    const deployDir = path.dirname(overwatchDir);
    if (fs.existsSync(path.join(deployDir, 'infrastructure'))) {
      return deployDir;
    }
  } catch {
    // findConfigPath threw — no config found anywhere
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

export async function runRecreate(): Promise<void> {
  const base = findDeployDir();
  const ow = path.join(base, 'overwatch');

  console.log(`${GREEN}Recreating Overwatch containers...${NC}`);
  compose(ow, 'up -d --force-recreate');

  console.log(`\n${GREEN}Containers recreated.${NC}`);
}

// ─── Status Display ──────────────────────────────────────────────────────────

interface ContainerInfo {
  name: string;
  state: string;
  uptime: string;
  health: string;
}

function execQuiet(cmd: string): string {
  try {
    return execSync(cmd, { stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function parseContainers(prefix: string): ContainerInfo[] {
  const output = execQuiet(
    `docker ps -a --filter "name=${prefix}-" --format "{{.Names}}\t{{.State}}\t{{.Status}}"`,
  );
  if (!output) return [];

  return output.split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t');
    const name = parts[0] || '';
    const state = parts[1] || 'unknown';
    const rawStatus = parts[2] || '';

    // Extract uptime (e.g. "Up 3 days" from "Up 3 days (healthy)")
    const uptime = rawStatus.replace(/\s*\(.*\)\s*$/, '');

    // Extract health from parenthesized portion
    const healthMatch = rawStatus.match(/\((\w+)\)\s*$/);
    const health = healthMatch ? healthMatch[1] : '';

    return { name, state, uptime, health };
  });
}

function statusIcon(state: string, health: string): string {
  if (state !== 'running') return `${RED}✗${NC}`;
  if (health === 'unhealthy') return `${YELLOW}!${NC}`;
  return `${GREEN}✓${NC}`;
}

function stateLabel(state: string, health: string): string {
  if (state !== 'running') return `${RED}${state}${NC}`;
  if (health === 'unhealthy') return `${YELLOW}unhealthy${NC}`;
  if (health === 'healthy') return `${GREEN}running${NC}`;
  return `${GREEN}running${NC}`;
}

function healthLabel(health: string): string {
  if (health === 'healthy') return `${GREEN}healthy${NC}`;
  if (health === 'unhealthy') return `${RED}unhealthy${NC}`;
  if (health === 'starting') return `${YELLOW}starting${NC}`;
  return `${DIM}-${NC}`;
}

function pad(str: string, len: number): string {
  // Strip ANSI codes for length calculation
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  return str + ' '.repeat(Math.max(0, len - visible.length));
}

function header(title: string): void {
  const bar = '━'.repeat(Math.max(0, 52 - title.length));
  console.log(`${CYAN}━━━ ${title} ${bar}${NC}`);
}

function loadProjectConfig(): { prefix: string; serviceNames: string[]; initContainerNames: string[] } | null {
  try {
    const configPath = findConfigPath();
    const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as any;
    const prefix = raw?.project?.prefix;
    const services = (raw?.services || []) as Array<{ name: string; is_init_container?: boolean }>;
    const serviceNames = services
      .filter(s => !s.is_init_container)
      .map(s => s.name);
    const initContainerNames = services
      .filter(s => s.is_init_container)
      .map(s => s.name);
    return prefix ? { prefix, serviceNames, initContainerNames } : null;
  } catch {
    return null;
  }
}

function extractTenantId(containerName: string, prefix: string, serviceNames: string[], initContainerNames: string[]): { tenantId: string; isInit: boolean } | null {
  const withoutPrefix = containerName.slice(prefix.length + 1); // strip "prefix-"
  for (const svc of serviceNames) {
    // Match "-service" or "-service-N" (replica) at the end
    const pattern = new RegExp(`-${svc}(?:-\\d+)?$`);
    if (pattern.test(withoutPrefix)) {
      return { tenantId: withoutPrefix.replace(pattern, ''), isInit: false };
    }
  }
  for (const svc of initContainerNames) {
    const pattern = new RegExp(`-${svc}(?:-\\d+)?$`);
    if (pattern.test(withoutPrefix)) {
      return { tenantId: withoutPrefix.replace(pattern, ''), isInit: true };
    }
  }
  return null;
}

export async function runStatus(): Promise<void> {
  const base = findDeployDir();
  const config = loadProjectConfig();

  if (!config) {
    // Fallback to raw compose output if config is unavailable
    console.log(`${GREEN}Infrastructure:${NC}`);
    compose(path.join(base, 'infrastructure'), 'ps');
    console.log(`\n${GREEN}Overwatch:${NC}`);
    compose(path.join(base, 'overwatch'), 'ps');
    return;
  }

  const { prefix, serviceNames, initContainerNames } = config;
  const allContainers = parseContainers(prefix);

  if (allContainers.length === 0) {
    console.log('');
    console.log(`  ${BOLD}Overwatch${NC} ${DIM}v${VERSION}${NC}`);
    console.log('');
    console.log(`  ${YELLOW}!${NC} No containers found matching prefix "${prefix}".`);
    console.log(`  ${DIM}Run "overwatch start" to start services.${NC}`);
    console.log('');
    return;
  }

  // Categorize containers
  const overwatchName = `${prefix}-overwatch`;
  const infraContainers: ContainerInfo[] = [];
  const overwatchContainers: ContainerInfo[] = [];
  const tenantContainerMap = new Map<string, ContainerInfo[]>();

  for (const c of allContainers) {
    if (c.name === overwatchName) {
      overwatchContainers.push(c);
      continue;
    }

    const result = extractTenantId(c.name, prefix, serviceNames, initContainerNames);
    if (result) {
      if (result.isInit) continue; // Skip init containers (migrators) from display
      const list = tenantContainerMap.get(result.tenantId) || [];
      list.push(c);
      tenantContainerMap.set(result.tenantId, list);
    } else {
      infraContainers.push(c);
    }
  }

  // Display
  console.log('');
  console.log(`  ${BOLD}Overwatch${NC} ${DIM}v${VERSION}${NC}`);
  console.log('');

  // Infrastructure
  if (infraContainers.length > 0) {
    header('Infrastructure');
    console.log('');
    for (const c of infraContainers) {
      const shortName = c.name.startsWith(`${prefix}-`) ? c.name.slice(prefix.length + 1) : c.name;
      const icon = statusIcon(c.state, c.health);
      console.log(`  ${icon} ${pad(shortName, 22)} ${pad(stateLabel(c.state, c.health), 24)} ${pad(c.uptime, 18)} ${healthLabel(c.health)}`);
    }
    console.log('');
  }

  // Overwatch
  header('Overwatch');
  console.log('');
  if (overwatchContainers.length > 0) {
    for (const c of overwatchContainers) {
      const icon = statusIcon(c.state, c.health);
      console.log(`  ${icon} ${pad('overwatch', 22)} ${pad(stateLabel(c.state, c.health), 24)} ${pad(c.uptime, 18)} ${healthLabel(c.health)}`);
    }
  } else {
    console.log(`  ${RED}✗${NC} ${pad('overwatch', 22)} ${RED}not found${NC}`);
  }
  console.log('');

  // Tenants
  const tenantIds = [...tenantContainerMap.keys()].sort();

  header(`Tenants (${tenantIds.length})`);
  console.log('');

  if (tenantIds.length === 0) {
    console.log(`  ${DIM}No tenants deployed${NC}`);
    console.log('');
    return;
  }

  const totalServices = serviceNames.length;
  let healthyTenants = 0;
  let totalContainers = 0;

  for (const tenantId of tenantIds) {
    const containers = tenantContainerMap.get(tenantId)!;
    totalContainers += containers.length;
    const running = containers.filter(c => c.state === 'running');
    const runningCount = running.length;
    const allUp = runningCount >= totalServices;

    if (allUp) healthyTenants++;

    const icon = allUp ? `${GREEN}✓${NC}` : `${RED}✗${NC}`;
    const countStr = `${runningCount}/${totalServices} services`;

    if (allUp) {
      console.log(`  ${icon} ${pad(tenantId, 22)} ${pad(countStr, 18)} ${GREEN}all running${NC}`);
    } else {
      // Find which services are down
      const runningServices = new Set<string>();
      for (const c of running) {
        for (const svc of serviceNames) {
          if (c.name.endsWith(`-${svc}`) || new RegExp(`-${svc}-\\d+$`).test(c.name)) {
            runningServices.add(svc);
          }
        }
      }
      const downServices = serviceNames.filter(s => !runningServices.has(s));
      const downLabel = downServices.length <= 2
        ? downServices.join(', ') + ' down'
        : `${downServices.length} services down`;
      console.log(`  ${icon} ${pad(tenantId, 22)} ${pad(countStr, 18)} ${RED}${downLabel}${NC}`);
    }
  }

  // Summary
  console.log('');
  const unhealthyTenants = tenantIds.length - healthyTenants;
  let summary = `  ${tenantIds.length} tenant${tenantIds.length !== 1 ? 's' : ''}, ${totalContainers} container${totalContainers !== 1 ? 's' : ''}`;
  if (unhealthyTenants === 0) {
    summary += ` — ${GREEN}all healthy${NC}`;
  } else {
    summary += ` — ${GREEN}${healthyTenants} healthy${NC}, ${RED}${unhealthyTenants} unhealthy${NC}`;
  }
  console.log(summary);
  console.log('');
}
