import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadConfig } from '../config';

const execFileAsync = promisify(execFile);

/**
 * Install-time template substitution. Only these keys are replaced when
 * rendering templates; every other `${FOO}` passes through untouched so
 * Docker Compose can resolve it from the operator's runtime `.env`.
 */
export interface InfraDeployVars {
  PROJECT_PREFIX: string;
  NETWORK_NAME: string;
  APPS_PATH_ON_HOST: string;
}

export interface InfraFileChange {
  path: string;
  status: 'created' | 'updated' | 'unchanged';
}

export interface InfraDeployResult {
  changes: InfraFileChange[];
  composeRestarted: boolean;
  dryRun: boolean;
}

/**
 * The canonical list of template → destination mappings. Kept as a static
 * array rather than an fs.readdir so `overwatch infra deploy` behavior is
 * deterministic regardless of what happens to be in the templates dir at
 * runtime (pkg'd binary vs dev tree).
 */
const TEMPLATE_FILES: Array<{ source: string; dest: string }> = [
  { source: 'infrastructure/docker-compose.yml', dest: 'infrastructure/docker-compose.yml' },
  { source: 'infrastructure/traefik/traefik.yml', dest: 'infrastructure/traefik/traefik.yml' },
  { source: 'infrastructure/traefik/dynamic.yml', dest: 'infrastructure/traefik/dynamic.yml' },
  { source: 'infrastructure/traefik/dynamic/dashboard.yml', dest: 'infrastructure/traefik/dynamic/dashboard.yml' },
  { source: 'infrastructure/mariadb/init/.gitkeep', dest: 'infrastructure/mariadb/init/.gitkeep' },
  { source: 'overwatch/docker-compose.yml', dest: 'overwatch/docker-compose.yml' },
];

/**
 * Resolve the embedded templates directory. Works under both `npx tsx`
 * (from src/) and the pkg'd binary (snapshot filesystem).
 */
function templatesRoot(): string {
  return path.resolve(__dirname, '..', '..', 'templates');
}

export function resolveDeployVars(deployDir: string): InfraDeployVars {
  const config = loadConfig();
  const projectPrefix = config.project.prefix;
  const networkName = config.networking?.external_network || `${projectPrefix}-network`;
  return {
    PROJECT_PREFIX: projectPrefix,
    NETWORK_NAME: networkName,
    APPS_PATH_ON_HOST: path.join(deployDir, 'apps'),
  };
}

/**
 * Substitute only the install-time vars listed in `vars`. Any `${OTHER}`
 * passes through unchanged so Docker Compose can resolve it at `up` time.
 */
export function renderTemplate(content: string, vars: InfraDeployVars): string {
  const lookup = vars as unknown as Record<string, string>;
  return content.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(lookup, key)) {
      return lookup[key];
    }
    return match;
  });
}

async function readTemplate(source: string): Promise<string> {
  return fs.readFile(path.join(templatesRoot(), source), 'utf-8');
}

async function readDestIfExists(destPath: string): Promise<string | null> {
  try {
    return await fs.readFile(destPath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeAtomic(destPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content, { mode: 0o644 });
  await fs.rename(tmp, destPath);
}

async function runCompose(composeFile: string): Promise<void> {
  await execFileAsync('docker', [
    'compose',
    '--file', composeFile,
    'up', '-d', '--remove-orphans',
  ], { maxBuffer: 10 * 1024 * 1024 });
}

/**
 * Render every template, compare to the existing file on disk, and either
 * write (actual run) or report (dry-run). Runs `docker compose up -d` on
 * the infrastructure compose afterwards unless dryRun.
 *
 * Does NOT touch data/, apps/, tenant state, or the Overwatch container —
 * those stay the operator's responsibility. The Overwatch container is
 * only restarted via a separate `docker compose up -d` in the overwatch/
 * directory, which the operator runs manually (avoids self-restart loop
 * when deploy is invoked from inside the Overwatch container).
 */
export async function deployInfra(options: {
  deployDir: string;
  dryRun?: boolean;
}): Promise<InfraDeployResult> {
  const { deployDir, dryRun = false } = options;
  const vars = resolveDeployVars(deployDir);
  const changes: InfraFileChange[] = [];

  for (const tpl of TEMPLATE_FILES) {
    const raw = await readTemplate(tpl.source);
    const rendered = renderTemplate(raw, vars);
    const destPath = path.join(deployDir, tpl.dest);
    const existing = await readDestIfExists(destPath);
    let status: InfraFileChange['status'];
    if (existing === null) {
      status = 'created';
    } else if (existing === rendered) {
      status = 'unchanged';
    } else {
      status = 'updated';
    }
    if (status !== 'unchanged' && !dryRun) {
      await writeAtomic(destPath, rendered);
    }
    changes.push({ path: destPath, status });
  }

  let composeRestarted = false;
  if (!dryRun) {
    const composeFile = path.join(deployDir, 'infrastructure', 'docker-compose.yml');
    await runCompose(composeFile);
    composeRestarted = true;
  }

  return { changes, composeRestarted, dryRun };
}
