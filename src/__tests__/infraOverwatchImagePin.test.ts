import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

// Network create, `compose up` and the DB downgrade inspect all succeed with no output.
const runDockerMock = vi.fn();
vi.mock('../utils/runDocker', async (orig) => ({
  ...(await orig<typeof import('../utils/runDocker')>()),
  runDocker: (...a: unknown[]) => runDockerMock(...a),
}));

const PINNED = 'ghcr.io/marwain91/overwatch:1.9.3';
const LATEST = 'ghcr.io/marwain91/overwatch:latest';

let tmpRoot: string;
let deployDir: string;
let composePath: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-pin-'));
  deployDir = path.join(tmpRoot, 'deploy');
  composePath = path.join(deployDir, 'overwatch', 'docker-compose.yml');
  await fs.mkdir(path.dirname(composePath), { recursive: true });
  runDockerMock.mockReset();
  runDockerMock.mockResolvedValue({ stdout: '', stderr: '' });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
  delete process.env.OVERWATCH_CONFIG;
});

// `generated` adds traefik.cert_resolvers, which switches the overwatch compose
// from the embedded static template to buildOverwatchComposeYml.
async function seedConfig(renderer: 'template' | 'generated'): Promise<void> {
  const configPath = path.join(deployDir, 'overwatch', 'overwatch.yaml');
  await fs.writeFile(configPath, `
project:
  name: "Acme"
  prefix: "acme"
  db_prefix: ""
database:
  type: "mariadb"
  host: "acme-mariadb"
  port: 3306
  root_user: "root"
  root_password_env: "MYSQL_ROOT_PASSWORD"
  container_name: "acme-mariadb"
networking:
  external_network: "acme-network"
  apps_path: "${path.join(deployDir, 'apps')}"
data_dir: "${path.join(deployDir, 'overwatch', 'data')}"
${renderer === 'generated' ? `traefik:
  cert_resolvers:
    - name: letsencrypt
      challenge: http
      acme_email: ops@example.com
` : ''}`);
  process.env.OVERWATCH_CONFIG = configPath;
  const loader = await import('../config/loader');
  loader.clearConfigCache();
}

// An older render that `overwatch update --tag` has since pinned.
function pinnedCompose(image: string): string {
  return [
    'services:',
    '  overwatch:',
    `    image: ${JSON.stringify(image)}`,
    '    container_name: acme-overwatch',
    '    environment:',
    '      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET}',
    '',
  ].join('\n');
}

async function writtenImage(): Promise<unknown> {
  const doc = yaml.load(await fs.readFile(composePath, 'utf-8')) as any;
  return doc.services.overwatch.image;
}

describe.each(['template', 'generated'] as const)('infra deploy keeps the pinned Overwatch image (%s compose)', (renderer) => {
  it.each([
    ['a version tag', PINNED],
    ['a digest', `ghcr.io/marwain91/overwatch@sha256:${'a'.repeat(64)}`],
    ['a compose variable', 'ghcr.io/marwain91/overwatch:${OVERWATCH_TAG:-1.9.3}'],
  ])('keeps %s while updating the rest of the file', async (_label, image) => {
    await seedConfig(renderer);
    await fs.writeFile(composePath, pinnedCompose(image));
    const { deployInfra } = await import('../services/infraTemplates');

    const result = await deployInfra({ deployDir });

    expect(await writtenImage()).toBe(image);
    expect(result.overwatchImage).toEqual({ current: image, rendered: image });
    // The template's other changes still land.
    const written = await fs.readFile(composePath, 'utf-8');
    expect(written).not.toContain('GOOGLE_CLIENT_SECRET');
    expect(written).toContain('OVERWATCH_TRUST_PROXY');
    expect(result.changes.find(c => c.path === composePath)?.status).toBe('updated');
  });

  it('reports the pinned file unchanged on the next deploy', async () => {
    await seedConfig(renderer);
    await fs.writeFile(composePath, pinnedCompose(PINNED));
    const { deployInfra } = await import('../services/infraTemplates');
    await deployInfra({ deployDir });

    const again = await deployInfra({ deployDir, dryRun: true });
    expect(again.changes.find(c => c.path === composePath)?.status).toBe('unchanged');
  });
});

describe('withOverwatchImage — touches only the overwatch service', () => {
  // A rendered compose whose first `image:` line belongs to another service.
  function twoServices(sidecarImage: string, overwatchImage: string): string {
    return [
      '# Rendered by overwatch infra deploy.',
      'services:',
      '  sidecar:',
      `    image: ${sidecarImage}`,
      '  overwatch:',
      '    container_name: acme-overwatch',
      `    image: ${overwatchImage}`,
      '    labels:',
      '      - "image: not-a-key"',
      '',
    ].join('\n');
  }

  it('puts the pin on overwatch and leaves the first service image alone', async () => {
    const { withOverwatchImage } = await import('../services/infraTemplates');
    expect(withOverwatchImage(twoServices('busybox:1.36', LATEST), PINNED))
      .toBe(twoServices('busybox:1.36', PINNED));
  });

  it('does not rewrite another service running the same image', async () => {
    const { withOverwatchImage } = await import('../services/infraTemplates');
    expect(withOverwatchImage(twoServices(LATEST, LATEST), PINNED))
      .toBe(twoServices(LATEST, PINNED));
  });

  it('leaves the file alone when overwatch already has the image', async () => {
    const { withOverwatchImage } = await import('../services/infraTemplates');
    const compose = twoServices('busybox:1.36', PINNED);
    expect(withOverwatchImage(compose, PINNED)).toBe(compose);
  });

  it('does not take the next service image when overwatch has none', async () => {
    const { withOverwatchImage } = await import('../services/infraTemplates');
    const compose = 'services:\n  overwatch:\n    container_name: acme-overwatch\n  sidecar:\n    image: busybox:1.36\n';
    expect(withOverwatchImage(compose, PINNED)).toBe(compose);
  });
});

describe('infra deploy — Overwatch image reporting', () => {
  it('uses :latest for a new install and reports no image change', async () => {
    await seedConfig('template');
    await fs.rm(composePath, { force: true });
    const { deployInfra } = await import('../services/infraTemplates');

    const result = await deployInfra({ deployDir, dryRun: true });

    expect(result.overwatchImage).toBeUndefined();
    expect(result.changes.find(c => c.path === composePath)?.status).toBe('created');
  });

  it('dry-run reports the change when the existing image cannot be read, and writes nothing', async () => {
    await seedConfig('template');
    const existing = 'services:\n  admin:\n    image: ghcr.io/marwain91/overwatch:1.9.3\n';
    await fs.writeFile(composePath, existing);
    const { deployInfra } = await import('../services/infraTemplates');

    const result = await deployInfra({ deployDir, dryRun: true });

    expect(result.overwatchImage).toEqual({ current: null, rendered: LATEST });
    expect(await fs.readFile(composePath, 'utf-8')).toBe(existing);
  });
});

describe('overwatch infra deploy — image line in the CLI output', () => {
  afterEach(() => {
    delete process.env.DEPLOY_DIR;
    vi.doUnmock('../services/infraTemplates');
    vi.restoreAllMocks();
  });

  async function runWith(overwatchImage: { current: string | null; rendered: string | null }): Promise<string> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.doMock('../services/infraTemplates', () => ({
      deployInfra: vi.fn(async () => ({ changes: [], composeRestarted: false, dryRun: true, overwatchImage })),
    }));
    process.env.DEPLOY_DIR = deployDir;
    const { runInfra } = await import('../cli/infra');
    await runInfra(['deploy', '--dry-run']);
    return log.mock.calls.map(c => String(c[0])).join('\n');
  }

  it('names both images when the image would change', async () => {
    const out = await runWith({ current: null, rendered: LATEST });
    expect(out).toMatch(/Overwatch image would change/);
    expect(out).toContain(LATEST);
  });

  it('confirms a kept pin', async () => {
    const out = await runWith({ current: PINNED, rendered: PINNED });
    expect(out).toContain(`Overwatch image kept: ${PINNED}`);
    expect(out).not.toMatch(/Overwatch image would change/);
  });
});
