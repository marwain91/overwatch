import { describe, it, expect, afterEach, vi } from 'vitest';
import * as util from 'util';
import { generateComposeFile } from '../services/composeGenerator';
import { extractComposeErrorMessage } from '../utils/composeErrors';

/**
 * Init containers exist to gate the services that depend on them. Short-form
 * `depends_on` only orders startup — it never waits for completion and never
 * inspects the exit code — so a dead migrator used to let the backend start
 * anyway and report healthy against an un-migrated schema.
 */

function baseConfig() {
  return {
    project: { name: 'Test', prefix: 'test', db_prefix: 'test' },
    database: {
      type: 'mariadb',
      host: 'db',
      port: 3306,
      root_user: 'root',
      root_password_env: 'MYSQL_ROOT_PASSWORD',
      container_name: 'db',
    },
    networking: {
      external_network: 'test-network',
      internal_network_template: '${prefix}-${tenantId}-internal',
      apps_path: '/app/apps',
    },
    traefik: { log_level: 'INFO', tls_termination: 'upstream', upstream_entrypoint: 'web' },
  } as any;
}

function appWithServices(services: any[]) {
  return {
    id: 'product',
    name: 'Product',
    domain_template: '*.example.test',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/product', auth: { type: 'token' } },
    services,
    default_image_tag: 'latest',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as any;
}

function render(services: any[]): string {
  return generateComposeFile({
    app: appWithServices(services),
    tenantId: 'daktela',
    domain: 'daktela.example.test',
    config: baseConfig(),
  });
}

/** Extract the `depends_on:` block of one service from generated compose YAML. */
function dependsOnBlock(yml: string, serviceName: string): string {
  const lines = yml.split('\n');
  const start = lines.findIndex(l => l === `  ${serviceName}:`);
  expect(start, `service '${serviceName}' not found in generated compose`).toBeGreaterThan(-1);
  const dependsIdx = lines.findIndex((l, i) => i > start && l === '    depends_on:');
  if (dependsIdx === -1) return '';
  const block: string[] = [];
  for (let i = dependsIdx + 1; i < lines.length; i++) {
    // Stop at the next key at service-property depth (4 spaces) or the next service.
    if (!/^ {6}/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block.join('\n');
}

describe('composeGenerator depends_on gating', () => {
  it('waits for successful completion when depending on an init container', () => {
    const yml = render([
      { name: 'backend', image_suffix: 'backend', required: true, depends_on: ['migrator'] },
      { name: 'migrator', image_suffix: 'backend', is_init_container: true },
    ]);

    expect(dependsOnBlock(yml, 'backend')).toBe(
      '      migrator:\n        condition: service_completed_successfully',
    );
  });

  it('keeps start-order semantics when depending on a normal service', () => {
    const yml = render([
      { name: 'backend', image_suffix: 'backend', required: true },
      { name: 'frontend', image_suffix: 'frontend', required: true, depends_on: ['backend'] },
    ]);

    expect(dependsOnBlock(yml, 'frontend')).toBe(
      '      backend:\n        condition: service_started',
    );
  });

  it('renders one consistent long-form block for mixed dependencies', () => {
    const yml = render([
      { name: 'backend', image_suffix: 'backend', required: true },
      { name: 'migrator', image_suffix: 'backend', is_init_container: true },
      { name: 'worker', image_suffix: 'worker', depends_on: ['migrator', 'backend'] },
    ]);

    // Short-form and long-form cannot be mixed inside one depends_on block.
    expect(dependsOnBlock(yml, 'worker')).toBe(
      [
        '      migrator:',
        '        condition: service_completed_successfully',
        '      backend:',
        '        condition: service_started',
      ].join('\n'),
    );
    expect(yml).not.toMatch(/^ {6}- (migrator|backend)$/m);
  });

  it('fails loudly rather than emitting a dangling dependency', () => {
    const generate = () =>
      render([
        { name: 'backend', image_suffix: 'backend', required: true, depends_on: ['migratr'] },
        { name: 'migrator', image_suffix: 'backend', is_init_container: true },
      ]);

    // The message must name the offending service and the typo'd dependency,
    // and list what was actually available — a dangling depends_on is a
    // deploy-time outage otherwise.
    expect(generate).toThrow(/depends_on 'migratr'/);
    expect(generate).toThrow(/not a known service/);
    expect(generate).toThrow(/Known services: backend, migrator/);
  });

  it('omits depends_on entirely for services that declare none', () => {
    const yml = render([{ name: 'backend', image_suffix: 'backend', required: true }]);
    expect(yml).not.toContain('depends_on');
  });
});

describe('extractComposeErrorMessage', () => {
  // Verbatim stderr from `docker compose up -d` (Compose v5.0.1) when an init
  // container gated by service_completed_successfully exits 127.
  const GATED_FAILURE_STDERR = [
    'time="2026-08-06T17:57:38+02:00" level=warning msg="No services to build"',
    ' Network product_default  Creating',
    ' Network product_default  Created',
    ' Container product-daktela-migrator  Creating',
    ' Container product-daktela-migrator  Created',
    ' Container product-daktela-backend  Creating',
    ' Container product-daktela-backend  Created',
    ' Container product-daktela-migrator  Starting',
    ' Container product-daktela-migrator  Started',
    ' Container product-daktela-migrator  Waiting',
    ' Container product-daktela-migrator  Error service "migrator" didn\'t complete successfully: exit 127',
    'service "migrator" didn\'t complete successfully: exit 127',
    '',
  ].join('\n');

  it('reports the failed init container, not compose progress noise', () => {
    const detail = extractComposeErrorMessage({ stderr: GATED_FAILURE_STDERR });

    expect(detail).toBe('service "migrator" didn\'t complete successfully: exit 127');
  });

  it('reports a dependency that failed to start', () => {
    const stderr = [
      ' Container product-daktela-migrator  Starting',
      'dependency failed to start: container product-daktela-migrator exited (1)',
      '',
    ].join('\n');

    expect(extractComposeErrorMessage({ stderr })).toBe(
      'dependency failed to start: container product-daktela-migrator exited (1)',
    );
  });

  it('still surfaces classic pull errors', () => {
    const stderr = [
      ' backend Pulling',
      ' backend Error',
      'Error response from daemon: manifest for ghcr.io/acme/product/backend:1.5.99 not found',
      '',
    ].join('\n');

    expect(extractComposeErrorMessage({ stderr })).toBe(
      'Error response from daemon: manifest for ghcr.io/acme/product/backend:1.5.99 not found',
    );
  });

  it('falls back to the error message when stderr carries nothing useful', () => {
    expect(extractComposeErrorMessage({ stderr: '', message: 'spawn docker ENOENT' })).toBe(
      'spawn docker ENOENT',
    );
  });
});

/**
 * A gated failure tells the operator "service 'migrator' didn't complete
 * successfully: exit 127" — true but not actionable. The reason lives in the
 * init container's logs, and the rollback recreates containers, so the
 * evidence must be collected before it is destroyed.
 */
describe('init container diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('child_process');
  });

  /** Mock `docker` so `promisify(execFile)` resolves like the real thing. */
  function mockDocker(handler: (args: string[]) => { stdout?: string; fail?: boolean }) {
    const execFile: any = vi.fn((_cmd: string, args: string[], _opts: any, cb: any) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      const { stdout = '', fail = false } = handler(args);
      if (fail) {
        const err: any = new Error('No such object');
        err.code = 1;
        callback(err, '', 'Error: No such object');
      } else {
        callback(null, stdout, '');
      }
    });
    execFile[util.promisify.custom] = (cmd: string, args: string[], opts: any) =>
      new Promise((resolve, reject) => {
        execFile(cmd, args, opts, (err: any, stdout: string, stderr: string) => {
          if (err) reject(err); else resolve({ stdout, stderr });
        });
      });
    vi.doMock('child_process', () => ({ execFile, default: { execFile } }));
    return execFile;
  }

  const app = {
    id: 'product',
    services: [
      { name: 'backend', required: true, is_init_container: false },
      { name: 'migrator', required: false, is_init_container: true },
    ],
  } as any;

  it('reports the failed init container exit code and its logs', async () => {
    mockDocker(args => {
      if (args[0] === 'inspect') return { stdout: 'exited 127\n' };
      if (args[0] === 'logs') return { stdout: 'sh: drizzle-kit: not found\n' };
      return {};
    });

    const { describeFailedInitContainers } = await import('../services/initContainerDiagnostics');
    const report = await describeFailedInitContainers(app, 'daktela');

    expect(report).toContain("init container 'migrator' (product-daktela-migrator) exited 127");
    expect(report).toContain('sh: drizzle-kit: not found');
  });

  it('stays silent when init containers completed successfully', async () => {
    mockDocker(args => (args[0] === 'inspect' ? { stdout: 'exited 0\n' } : {}));

    const { describeFailedInitContainers } = await import('../services/initContainerDiagnostics');

    expect(await describeFailedInitContainers(app, 'daktela')).toBe('');
  });

  it('never inspects non-init services', async () => {
    const execFile = mockDocker(args => (args[0] === 'inspect' ? { stdout: 'exited 0\n' } : {}));

    const { describeFailedInitContainers } = await import('../services/initContainerDiagnostics');
    await describeFailedInitContainers(app, 'daktela');

    const inspected = execFile.mock.calls.map((c: any[]) => (c[1] as string[]).join(' '));
    expect(inspected.some((a: string) => a.includes('product-daktela-migrator'))).toBe(true);
    expect(inspected.some((a: string) => a.includes('product-daktela-backend'))).toBe(false);
  });

  it('degrades to empty output rather than masking the original failure', async () => {
    mockDocker(() => ({ fail: true }));

    const { describeFailedInitContainers } = await import('../services/initContainerDiagnostics');

    await expect(describeFailedInitContainers(app, 'daktela')).resolves.toBe('');
  });
});
