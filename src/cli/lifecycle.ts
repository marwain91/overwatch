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

  // Derive from config file location
  try {
    const configPath = findConfigPath();
    const overwatchDir = path.dirname(configPath);
    const deployDir = path.dirname(overwatchDir);
    if (fs.existsSync(path.join(deployDir, 'infrastructure'))) {
      return deployDir;
    }
  } catch {
    // findConfigPath threw
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

function parseContainers(filterNames: string[]): ContainerInfo[] {
  const unique = [...new Set(filterNames)];
  const filters = unique.map(n => `--filter "name=${n}-"`).join(' ');
  const output = execQuiet(
    `docker ps -a ${filters} --format "{{.Names}}\t{{.State}}\t{{.Status}}"`,
  );
  if (!output) return [];

  return output.split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t');
    const name = parts[0] || '';
    const state = parts[1] || 'unknown';
    const rawStatus = parts[2] || '';

    const uptime = rawStatus.replace(/\s*\(.*\)\s*$/, '');
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
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  return str + ' '.repeat(Math.max(0, len - visible.length));
}

function header(title: string): void {
  const bar = '━'.repeat(Math.max(0, 52 - title.length));
  console.log(`${CYAN}━━━ ${title} ${bar}${NC}`);
}

function loadProjectConfig(): { prefix: string } | null {
  try {
    const configPath = findConfigPath();
    const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as any;
    const prefix = raw?.project?.prefix;
    return prefix ? { prefix } : null;
  } catch {
    return null;
  }
}

/**
 * Load app definitions from apps.json to get service names per app.
 */
function loadAppDefinitions(base: string): Array<{ id: string; name: string; serviceNames: string[]; initContainerNames: string[] }> {
  const appsJsonPath = path.join(base, 'overwatch', 'data', 'apps.json');
  try {
    const content = fs.readFileSync(appsJsonPath, 'utf-8');
    const apps = JSON.parse(content);
    if (!Array.isArray(apps)) return [];
    return apps.map((app: any) => ({
      id: app.id,
      name: app.name || app.id,
      serviceNames: (app.services || [])
        .filter((s: any) => !s.is_init_container)
        .map((s: any) => s.name),
      initContainerNames: (app.services || [])
        .filter((s: any) => s.is_init_container)
        .map((s: any) => s.name),
    }));
  } catch {
    return [];
  }
}

export async function runStatus(): Promise<void> {
  const base = findDeployDir();
  const config = loadProjectConfig();

  if (!config) {
    console.log(`${GREEN}Infrastructure:${NC}`);
    compose(path.join(base, 'infrastructure'), 'ps');
    console.log(`\n${GREEN}Overwatch:${NC}`);
    compose(path.join(base, 'overwatch'), 'ps');
    return;
  }

  const { prefix } = config;
  const apps = loadAppDefinitions(base);
  const allContainers = parseContainers([prefix, ...apps.map(a => a.id)]);

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
  // Map: appId -> tenantId -> containers
  const appTenantMap = new Map<string, Map<string, ContainerInfo[]>>();

  for (const c of allContainers) {
    if (c.name === overwatchName) {
      overwatchContainers.push(c);
      continue;
    }

    // Try to match against known apps
    let matched = false;
    for (const app of apps) {
      // Pattern: {appId}-{tenantId}-{service}
      const appPrefix = `${app.id}-`;
      if (c.name.startsWith(appPrefix)) {
        const rest = c.name.slice(appPrefix.length);
        // Find service name at the end
        const allServices = [...app.serviceNames, ...app.initContainerNames];
        let tenantId = '';
        let serviceName = '';
        let isInit = false;

        for (const svc of allServices) {
          const pattern = new RegExp(`^(.+)-${svc}(?:-\\d+)?$`);
          const match = rest.match(pattern);
          if (match) {
            tenantId = match[1];
            serviceName = svc;
            isInit = app.initContainerNames.includes(svc);
            break;
          }
        }

        if (tenantId) {
          if (isInit) {
            // Skip init containers (migrators etc.) — they're expected to be exited
            matched = true;
            break;
          }
          if (!appTenantMap.has(app.id)) {
            appTenantMap.set(app.id, new Map());
          }
          const tenantMap = appTenantMap.get(app.id)!;
          if (!tenantMap.has(tenantId)) {
            tenantMap.set(tenantId, []);
          }
          tenantMap.get(tenantId)!.push(c);
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
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

  // Apps
  let totalTenants = 0;
  let totalContainers = 0;
  let healthyTenants = 0;

  if (apps.length === 0 && appTenantMap.size === 0) {
    header('Apps');
    console.log('');
    console.log(`  ${DIM}No apps configured. Create your first app via the web GUI.${NC}`);
    console.log('');
    return;
  }

  for (const app of apps) {
    const tenantMap = appTenantMap.get(app.id);
    const tenantIds = tenantMap ? [...tenantMap.keys()].sort() : [];
    const totalServices = app.serviceNames.length;

    header(`${app.name || app.id} (${tenantIds.length} tenant${tenantIds.length !== 1 ? 's' : ''})`);
    console.log('');

    if (tenantIds.length === 0) {
      console.log(`  ${DIM}No tenants deployed${NC}`);
      console.log('');
      continue;
    }

    for (const tenantId of tenantIds) {
      const containers = tenantMap!.get(tenantId)!;
      totalTenants++;
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
        const runningServices = new Set<string>();
        for (const c of running) {
          for (const svc of app.serviceNames) {
            if (c.name.endsWith(`-${svc}`) || new RegExp(`-${svc}-\\d+$`).test(c.name)) {
              runningServices.add(svc);
            }
          }
        }
        const downServices = app.serviceNames.filter(s => !runningServices.has(s));
        const downLabel = downServices.length <= 2
          ? downServices.join(', ') + ' down'
          : `${downServices.length} services down`;
        console.log(`  ${icon} ${pad(tenantId, 22)} ${pad(countStr, 18)} ${RED}${downLabel}${NC}`);
      }
    }
    console.log('');
  }

  // Summary
  if (totalTenants > 0) {
    const unhealthyTenants = totalTenants - healthyTenants;
    let summary = `  ${totalTenants} tenant${totalTenants !== 1 ? 's' : ''} across ${apps.length} app${apps.length !== 1 ? 's' : ''}, ${totalContainers} container${totalContainers !== 1 ? 's' : ''}`;
    if (unhealthyTenants === 0) {
      summary += ` — ${GREEN}all healthy${NC}`;
    } else {
      summary += ` — ${GREEN}${healthyTenants} healthy${NC}, ${RED}${unhealthyTenants} unhealthy${NC}`;
    }
    console.log(summary);
    console.log('');
  }
}
