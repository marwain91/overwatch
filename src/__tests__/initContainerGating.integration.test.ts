import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { generateComposeFile } from '../services/composeGenerator';

/**
 * End-to-end proof that the generated compose file gates dependents on init
 * container success. The unit tests assert the YAML we emit; this asserts what
 * Docker Compose actually DOES with it — the bug being fixed was precisely a
 * gap between "the file looks right" and "the file gates anything".
 *
 * Skipped when Docker isn't reachable (e.g. a sandboxed dev container).
 */
const dockerAvailable = spawnSync('docker', ['compose', 'version'], { stdio: 'pipe' }).status === 0;

const NETWORK = `ow-itest-net-${process.pid}`;
const TENANT = 'itest';

function docker(args: string[], cwd?: string) {
  const r = spawnSync('docker', args, { stdio: 'pipe', encoding: 'utf-8', cwd, timeout: 180_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function config() {
  return {
    project: { name: 'itest', prefix: 'owitest', db_prefix: 'owitest' },
    database: {
      type: 'mariadb', host: 'db', port: 3306,
      root_user: 'root', root_password_env: 'MYSQL_ROOT_PASSWORD', container_name: 'db',
    },
    networking: { external_network: NETWORK, internal_network_template: '${prefix}-${tenantId}-internal', apps_path: '/tmp' },
    traefik: { log_level: 'INFO', tls_termination: 'upstream', upstream_entrypoint: 'web' },
  } as any;
}

/** App whose migrator exits with `migratorExit`; backend just sleeps. */
function app(appId: string, migratorExit: number) {
  return {
    id: appId,
    name: appId,
    domain_template: '*.example.test',
    // Renders as `docker.io/library/busybox:${IMAGE_TAG:-latest}`.
    registry: { type: 'dockerhub', url: 'docker.io', repository: 'library', auth: { type: 'token' } },
    services: [
      {
        name: 'backend', image_suffix: 'busybox', required: true,
        command: ['sh', '-c', 'sleep 300'],
        depends_on: ['migrator'],
      },
      {
        name: 'migrator', image_suffix: 'busybox', is_init_container: true,
        command: ['sh', '-c', `echo "sh: drizzle-kit: not found" >&2; exit ${migratorExit}`],
      },
    ],
    default_image_tag: 'latest',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as any;
}

async function writeStack(dir: string, appId: string, migratorExit: number): Promise<string> {
  const yml = generateComposeFile({ app: app(appId, migratorExit), tenantId: TENANT, domain: 'itest.example.test', config: config() });
  const composePath = path.join(dir, 'docker-compose.yml');
  await fs.writeFile(composePath, yml);
  await fs.writeFile(path.join(dir, '.env'), 'IMAGE_TAG=latest\n');
  await fs.writeFile(path.join(dir, 'shared.env'), '');
  return composePath;
}

function containerState(name: string): string {
  const r = docker(['inspect', '-f', '{{.State.Status}}', name]);
  return r.status === 0 ? r.stdout.trim() : 'absent';
}

describe.skipIf(!dockerAvailable)('init container gating against real Docker Compose', () => {
  let tmpDir: string;
  const projects: string[] = [];
  let composePath = '';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-init-gating-'));
    docker(['network', 'create', NETWORK]);
    docker(['pull', 'busybox:latest']);
  }, 180_000);

  afterEach(() => {
    for (const project of projects.splice(0)) {
      docker(['compose', '-p', project, '--project-directory', tmpDir, '-f', composePath, 'down', '-v', '--remove-orphans']);
    }
  }, 120_000);

  afterAll(async () => {
    docker(['network', 'rm', NETWORK]);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }, 120_000);

  it('aborts the deploy and leaves dependents unstarted when the init container fails', async () => {
    const appId = 'owfail';
    const project = `${appId}-${TENANT}`;
    composePath = await writeStack(tmpDir, appId, 127);
    projects.push(project);

    const up = docker(['compose', '-p', project, '--project-directory', tmpDir, '-f', composePath, 'up', '-d']);

    // A failed migration must be a failed deploy.
    expect(up.status).not.toBe(0);
    expect(`${up.stderr}${up.stdout}`).toMatch(/didn't complete successfully: exit 127/);

    // The whole point: the backend must NOT be serving against an un-migrated DB.
    expect(containerState(`${appId}-${TENANT}-backend`)).not.toBe('running');
    expect(containerState(`${appId}-${TENANT}-migrator`)).toBe('exited');
  }, 180_000);

  it('starts dependents normally when the init container succeeds', async () => {
    const appId = 'owpass';
    const project = `${appId}-${TENANT}`;
    composePath = await writeStack(tmpDir, appId, 0);
    projects.push(project);

    const up = docker(['compose', '-p', project, '--project-directory', tmpDir, '-f', composePath, 'up', '-d']);

    expect(up.status).toBe(0);
    expect(containerState(`${appId}-${TENANT}-backend`)).toBe('running');
  }, 180_000);
});
