import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { renderTemplate, resolveDeployVars } from '../services/infraTemplates';

let tmpRoot: string;
let deployDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-infra-'));
  deployDir = path.join(tmpRoot, 'deploy');
  await fs.mkdir(deployDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
  delete process.env.OVERWATCH_CONFIG;
});

describe('renderTemplate', () => {
  const vars = {
    PROJECT_PREFIX: 'kwoutr',
    NETWORK_NAME: 'kwoutr-network',
    APPS_PATH_ON_HOST: '/opt/kwoutr/deploy/apps',
  };

  it('substitutes known keys', () => {
    expect(renderTemplate('container_name: ${PROJECT_PREFIX}-traefik', vars))
      .toBe('container_name: kwoutr-traefik');
  });

  it('passes unknown ${FOO} through untouched (left to docker compose)', () => {
    expect(renderTemplate('BASE_DOMAIN=${BASE_DOMAIN}', vars))
      .toBe('BASE_DOMAIN=${BASE_DOMAIN}');
  });

  it('substitutes many keys in one pass', () => {
    const input = [
      'name: ${PROJECT_PREFIX}',
      'network: ${NETWORK_NAME}',
      'apps_mount: ${APPS_PATH_ON_HOST}:/app/apps',
      'pass: ${MYSQL_ROOT_PASSWORD}',
    ].join('\n');
    const output = renderTemplate(input, vars);
    expect(output).toContain('name: kwoutr');
    expect(output).toContain('network: kwoutr-network');
    expect(output).toContain('apps_mount: /opt/kwoutr/deploy/apps:/app/apps');
    expect(output).toContain('pass: ${MYSQL_ROOT_PASSWORD}');
  });

  it('does not touch lowercase or mixed-case placeholders', () => {
    expect(renderTemplate('${base_domain} ${BaseDomain}', vars))
      .toBe('${base_domain} ${BaseDomain}');
  });
});

describe('deployInfra', () => {
  async function seedConfig(prefix = 'kwoutr'): Promise<void> {
    const configPath = path.join(deployDir, 'overwatch', 'overwatch.yaml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `
project:
  name: "${prefix[0].toUpperCase() + prefix.slice(1)}"
  prefix: "${prefix}"
  db_prefix: ""
database:
  type: "mariadb"
  host: "${prefix}-mariadb"
  port: 3306
  root_user: "root"
  root_password_env: "MYSQL_ROOT_PASSWORD"
  container_name: "${prefix}-mariadb"
networking:
  external_network: "${prefix}-network"
  apps_path: "${path.join(deployDir, 'apps')}"
data_dir: "${path.join(deployDir, 'overwatch', 'data')}"
`);
    process.env.OVERWATCH_CONFIG = configPath;
    const loader = await import('../config/loader');
    loader.clearConfigCache();
  }

  it('resolveDeployVars reads project.prefix and networking.external_network', async () => {
    await seedConfig('daktela');
    const vars = resolveDeployVars(deployDir);
    expect(vars.PROJECT_PREFIX).toBe('daktela');
    expect(vars.NETWORK_NAME).toBe('daktela-network');
    expect(vars.APPS_PATH_ON_HOST).toBe(path.join(deployDir, 'apps'));
  });

  it('dry-run reports "created" for every template and writes nothing', async () => {
    await seedConfig();
    const { deployInfra } = await import('../services/infraTemplates');
    const result = await deployInfra({ deployDir, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.composeRestarted).toBe(false);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes.every(c => c.status === 'created')).toBe(true);
    await expect(fs.access(path.join(deployDir, 'infrastructure'))).rejects.toThrow();
  });

  it('reports "unchanged" when destination already has identical rendered content', async () => {
    await seedConfig();
    const vars = resolveDeployVars(deployDir);

    // Pre-seed ONE destination with the exact rendered content of the corresponding template,
    // to prove that deployInfra detects equality rather than always rewriting.
    const templatesRoot = path.resolve(__dirname, '..', '..', 'templates');
    const sourceRel = 'infrastructure/traefik/dynamic.yml';
    const raw = await fs.readFile(path.join(templatesRoot, sourceRel), 'utf-8');
    const rendered = renderTemplate(raw, vars);
    const destPath = path.join(deployDir, sourceRel);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, rendered);

    const { deployInfra } = await import('../services/infraTemplates');
    const result = await deployInfra({ deployDir, dryRun: true });

    const destChange = result.changes.find(c => c.path === destPath);
    expect(destChange?.status).toBe('unchanged');
  });

  it('reports "updated" when destination differs from rendered template', async () => {
    await seedConfig();
    const destPath = path.join(deployDir, 'infrastructure', 'traefik', 'dynamic.yml');
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, '# stale content that does not match the template\n');

    const { deployInfra } = await import('../services/infraTemplates');
    const result = await deployInfra({ deployDir, dryRun: true });
    const destChange = result.changes.find(c => c.path === destPath);
    expect(destChange?.status).toBe('updated');
  });
});
