import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { loadConfig } from '../config';
import type { OverwatchConfig } from '../config/schema';
import { EMBEDDED_TEMPLATES } from '../generated/embeddedTemplates';
import { buildTraefikStaticYml, buildTraefikDynamicYml, shouldUseDynamicTraefik } from './traefikDynamicGenerator';
import { buildInfraComposeYml, buildOverwatchComposeYml } from './infraComposeGenerator';
import { COMPOSE_LONG_TIMEOUT_MS } from './composeTimeouts';
import { runDocker } from '../utils/runDocker';
import { renderEdgeNginx } from './edgeNginx';

// Quick docker queries (inspect, network create). `compose up` gets the long
// bound: its first run pulls the Traefik and database images.
const DOCKER_QUICK_TIMEOUT_MS = 60_000;

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
  /**
   * The Overwatch image in the existing overwatch/docker-compose.yml and in
   * the rendered one. Absent when that file does not exist yet. They differ
   * only when the existing file's image could not be read.
   */
  overwatchImage?: { current: string | null; rendered: string | null };
}

const OVERWATCH_COMPOSE = 'overwatch/docker-compose.yml';

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

/** The Docker network shared by Traefik, the database, Overwatch and tenants. */
export function sharedNetworkName(config: OverwatchConfig): string {
  return config.networking?.external_network || `${config.project.prefix}-network`;
}

export function resolveDeployVars(deployDir: string): InfraDeployVars {
  const config = loadConfig();
  return {
    PROJECT_PREFIX: config.project.prefix,
    NETWORK_NAME: sharedNetworkName(config),
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

function readTemplate(source: string): string {
  const content = EMBEDDED_TEMPLATES[source];
  if (content === undefined) {
    throw new Error(`Template '${source}' is not embedded. Rebuild with 'npm run build'.`);
  }
  return content;
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

async function ensureNetwork(name: string): Promise<'created' | 'exists'> {
  // `docker network inspect` exits non-zero when the network is absent.
  try {
    await runDocker('docker', ['network', 'inspect', name], { timeoutMs: DOCKER_QUICK_TIMEOUT_MS });
    return 'exists';
  } catch {
    // Not present — create it. Plain bridge network, no special driver opts.
    await runDocker('docker', ['network', 'create', '--driver', 'bridge', name], { timeoutMs: DOCKER_QUICK_TIMEOUT_MS });
    return 'created';
  }
}

// runDocker passes only an env allowlist, so operator secrets in this process
// never reach compose; the stack's ${VAR}s come from infrastructure/.env, which
// compose reads from the compose file's directory.
async function runCompose(composeFile: string): Promise<void> {
  await runDocker('docker', [
    'compose',
    '--file', composeFile,
    'up', '-d', '--remove-orphans',
  ], { cwd: path.dirname(composeFile), timeoutMs: COMPOSE_LONG_TIMEOUT_MS });
}

/**
 * Render every infra/overwatch file for `config`, keyed by its path relative
 * to the deploy dir. The single place that decides generator vs static
 * template; `deployInfra` and `overwatch init` both write its output.
 */
export function renderInfraFiles(
  config: OverwatchConfig,
  vars: InfraDeployVars,
): Array<{ dest: string; content: string }> {
  const useDynamic = shouldUseDynamicTraefik(config);
  const files: Array<{ dest: string; content: string }> = [];

  for (const tpl of TEMPLATE_FILES) {
    let rendered: string;

    // When the user has the new traefik.cert_resolvers schema, drive the four
    // Traefik-related templates from the generators. Other templates (mariadb
    // scaffolding, etc.) keep using the embedded statics.
    if (useDynamic && tpl.source === 'infrastructure/traefik/traefik.yml') {
      rendered = renderTemplate(buildTraefikStaticYml(config.traefik!), vars);
    } else if (useDynamic && tpl.source === 'infrastructure/traefik/dynamic.yml') {
      rendered = renderTemplate(buildTraefikDynamicYml(config.traefik!), vars);
    } else if (useDynamic && tpl.source === 'infrastructure/traefik/dynamic/dashboard.yml') {
      // Dashboard is folded into dynamic.yml when generated. Skip the separate file.
      continue;
    } else if (useDynamic && tpl.source === 'infrastructure/docker-compose.yml') {
      rendered = renderTemplate(buildInfraComposeYml(config), vars);
    } else if (useDynamic && tpl.source === 'overwatch/docker-compose.yml') {
      rendered = renderTemplate(buildOverwatchComposeYml(config), vars);
    } else {
      const raw = readTemplate(tpl.source);
      rendered = renderTemplate(raw, vars);
    }
    files.push({ dest: tpl.dest, content: rendered });
  }
  if (config.edge?.enabled) files.push({dest:'infrastructure/nginx/overwatch-edge.conf',content:renderEdgeNginx(config.edge)});
  return files;
}

// ─── Database downgrade guard ─────────────────────────────────────────────────

export class DbDowngradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbDowngradeError';
  }
}

/** `mariadb:10.11` -> [10, 11]; `postgres:16` -> [16, 0]; `latest`/digests -> null. */
export function parseImageVersion(image: string): [number, number] | null {
  const colon = image.lastIndexOf(':');
  if (image.includes('@') || colon <= image.lastIndexOf('/')) return null;
  const m = /^(\d+)(?:\.(\d+))?/.exec(image.slice(colon + 1));
  if (!m) return null;
  return [Number(m[1]), m[2] === undefined ? 0 : Number(m[2])];
}

/** True when `next` is a strictly lower major.minor than `running`. Unparseable -> false. */
export function isDbDowngrade(runningImage: string, nextImage: string): boolean {
  const a = parseImageVersion(runningImage);
  const b = parseImageVersion(nextImage);
  if (!a || !b) return false;
  return b[0] < a[0] || (b[0] === a[0] && b[1] < a[1]);
}

async function inspectRunningImage(container: string): Promise<string | null> {
  try {
    const { stdout } = await runDocker('docker', ['inspect', '--format', '{{.Config.Image}}', container], { timeoutMs: DOCKER_QUICK_TIMEOUT_MS });
    const image = String(stdout).trim();
    return image || null;
  } catch {
    // Absent container, docker missing, etc. — nothing to protect.
    return null;
  }
}

/**
 * A database data volume cannot be opened by an older server major.minor
 * than wrote it. Refuse before touching anything when the rendered infra
 * compose would pin a lower version than the container that is running.
 */
async function assertNoDbDowngrade(infraCompose: string): Promise<void> {
  const doc = yaml.load(infraCompose) as { services?: Record<string, { image?: string; container_name?: string }> } | undefined;
  for (const name of ['mariadb', 'postgres']) {
    const svc = doc?.services?.[name];
    if (!svc?.image || !svc.container_name) continue;
    const running = await inspectRunningImage(svc.container_name);
    if (running && isDbDowngrade(running, svc.image)) {
      throw new DbDowngradeError(
        `Refusing to deploy ${svc.image}: ${svc.container_name} is running ${running}, and an older ` +
        `server cannot open a data volume written by a newer one. Pin the newer version in the ` +
        `infrastructure compose, or pass --allow-db-downgrade if you have restored the data from a backup.`,
      );
    }
  }
}

/** The overwatch service's `image:` in a compose file; null when absent or unreadable. */
function readOverwatchImage(compose: string): string | null {
  try {
    const doc = yaml.load(compose) as { services?: { overwatch?: { image?: unknown } } } | null | undefined;
    const image = doc?.services?.overwatch?.image;
    return typeof image === 'string' && image.trim() !== '' ? image : null;
  } catch {
    return null;
  }
}

/**
 * Index of the `image:` line that belongs to the overwatch service itself
 * (top-level `services:` → `overwatch:` → `image:`), or -1. Walks the blocks
 * by indentation, so the `image:` of any other service is never chosen.
 */
function overwatchImageLine(lines: string[]): number {
  let inServices = false;
  let inOverwatch = false;
  let serviceIndent = -1; // service names under `services:`
  let keyIndent = -1;     // the overwatch service's own keys
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (text === '' || text.startsWith('#')) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    if (indent === 0) {
      if (inServices) return -1;
      inServices = /^services:[ \t]*(#.*)?$/.test(text);
      continue;
    }
    if (!inServices) continue;
    if (serviceIndent === -1) serviceIndent = indent;
    if (indent <= serviceIndent) {
      if (inOverwatch) return -1;
      inOverwatch = indent === serviceIndent && /^overwatch:[ \t]*(#.*)?$/.test(text);
      continue;
    }
    if (!inOverwatch) continue;
    if (keyIndent === -1) keyIndent = indent;
    if (indent === keyIndent && text.startsWith('image:')) return i;
  }
  return -1;
}

/**
 * Put `image` on the overwatch service of a rendered compose file, keeping
 * the rest of the rendered text (comments, key order, other services) as it
 * is. Leaves the file alone when it already has that image. Returns the input
 * unchanged if the overwatch `image:` line cannot be found or the result does
 * not read back as `image`; the deploy then reports the image change instead
 * of hiding it.
 */
export function withOverwatchImage(compose: string, image: string): string {
  if (readOverwatchImage(compose) === image) return compose;
  const lines = compose.split('\n');
  const at = overwatchImageLine(lines);
  if (at === -1) return compose;
  const lead = /^[ \t]*image:[ \t]*/.exec(lines[at])![0];
  lines[at] = lead + yaml.dump(image, { lineWidth: -1 }).trimEnd();
  const out = lines.join('\n');
  return readOverwatchImage(out) === image ? out : compose;
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
  allowDbDowngrade?: boolean;
}): Promise<InfraDeployResult> {
  const { deployDir, dryRun = false, allowDbDowngrade = false } = options;
  const vars = resolveDeployVars(deployDir);
  const changes: InfraFileChange[] = [];

  const config = loadConfig();
  const useDynamic = shouldUseDynamicTraefik(config);
  const files = renderInfraFiles(config, vars);

  if (!dryRun && !allowDbDowngrade) {
    const infra = files.find(f => f.dest === 'infrastructure/docker-compose.yml');
    if (infra) await assertNoDbDowngrade(infra.content);
  }

  let overwatchImage: InfraDeployResult['overwatchImage'];
  for (const file of files) {
    const destPath = path.join(deployDir, file.dest);
    const existing = await readDestIfExists(destPath);
    let rendered = file.content;
    if (file.dest === OVERWATCH_COMPOSE && existing !== null) {
      // `overwatch update --tag` pins the image in this file, its only home.
      // Re-rendering must not swap the pin for `:latest`: the next
      // `docker compose up` would silently move Overwatch to another version.
      const current = readOverwatchImage(existing);
      if (current) rendered = withOverwatchImage(rendered, current);
      overwatchImage = { current, rendered: readOverwatchImage(rendered) };
    }
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

  // When generated dynamic.yml contains the dashboard, remove the legacy file
  // so Traefik doesn't load conflicting routers from both sources.
  if (useDynamic && !dryRun) {
    const legacyDashboard = path.join(deployDir, 'infrastructure/traefik/dynamic/dashboard.yml');
    try {
      await fs.unlink(legacyDashboard);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  let composeRestarted = false;
  if (!dryRun) {
    // Network is declared `external: true` in the templates so compose doesn't
    // try to manage its labels — that sidesteps the "incorrect label" conflict
    // you hit when a pre-existing network was created under a different compose
    // key. Instead we explicitly ensure the network exists before compose runs.
    await ensureNetwork(vars.NETWORK_NAME);
    const composeFile = path.join(deployDir, 'infrastructure', 'docker-compose.yml');
    await runCompose(composeFile);
    composeRestarted = true;
  }

  return { changes, composeRestarted, dryRun, ...(overwatchImage ? { overwatchImage } : {}) };
}
