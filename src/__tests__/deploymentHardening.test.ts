import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-deployment-hardening-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('dockerode');
  vi.doUnmock('child_process');
  vi.doUnmock('../config');
  vi.doUnmock('../config/loader');
  vi.doUnmock('../adapters/database');
  vi.doUnmock('../services/app');
  vi.doUnmock('../services/envVars');
  vi.doUnmock('../services/docker');
  vi.doUnmock('../services/manifestExtractor');
  vi.doUnmock('../services/tenantAppDef');
  vi.doUnmock('../services/tenantTraefik');
  vi.doUnmock('../middleware/requireRole');
});

describe('deployment and image build hardening', () => {
  it('builds the server from source in the Dockerfile instead of copying checked-in dist', async () => {
    const dockerfile = await fs.readFile(path.join(process.cwd(), 'Dockerfile'), 'utf-8');
    expect(dockerfile).toMatch(/^FROM node:24-alpine@sha256:[0-9a-f]{64} AS server-build$/m);
    expect(dockerfile).toContain('RUN npm run build');
    expect(dockerfile).toContain('COPY --from=server-build /app/dist ./dist');
    expect(dockerfile).not.toMatch(/^COPY dist\/ .*dist/m);
  });

  it('pins every base image by digest, keeping the tag that Dependabot tracks', async () => {
    const dockerfile = await fs.readFile(path.join(process.cwd(), 'Dockerfile'), 'utf-8');
    const froms = dockerfile.split('\n').filter(l => /^FROM\s/i.test(l));
    expect(froms.length).toBeGreaterThan(0);
    for (const line of froms) expect(line).toMatch(/^FROM [a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}( AS [\w-]+)?$/);
    // One base image for every stage, so a digest bump moves them together.
    expect(new Set(froms.map(l => l.split(' ')[1])).size).toBe(1);
  });

  it('keeps generated and runtime-heavy paths out of Docker build context', async () => {
    const dockerignore = await fs.readFile(path.join(process.cwd(), '.dockerignore'), 'utf-8');
    expect(dockerignore).toMatch(/^node_modules\/?$/m);
    expect(dockerignore).toMatch(/^dist\/?$/m);
    expect(dockerignore).toMatch(/^data\/?$/m);
    expect(dockerignore).toMatch(/^tenants\/?$/m);
    expect(dockerignore).toMatch(/^\.git\/?$/m);
  });

  it('uses directory mounts for runtime state and does not publish the admin port publicly', async () => {
    const compose = await fs.readFile(path.join(process.cwd(), 'docker-compose.yml'), 'utf-8');
    expect(compose).toContain('./data:/app/data');
    expect(compose).toContain('./apps:/app/apps');
    expect(compose).not.toMatch(/\.\/data\/audit\.log:\/app\/data\/audit\.log/);
    expect(compose).not.toMatch(/\.\/data\/notification-channels\.json:\/app\/data\/notification-channels\.json/);
    expect(compose).not.toMatch(/-\s+"?3002:3002"?/);
  });

  it('defaults proxy trust to one hop and supports explicit operator overrides', async () => {
    const { resolveTrustProxySetting } = await import('../utils/proxyTrust');
    expect(resolveTrustProxySetting({})).toBe(1);
    expect(resolveTrustProxySetting({ OVERWATCH_TRUST_PROXY: '0' })).toBe(false);
    expect(resolveTrustProxySetting({ OVERWATCH_TRUST_PROXY: 'false' })).toBe(false);
    expect(resolveTrustProxySetting({ OVERWATCH_TRUST_PROXY: '1' })).toBe(1);
    expect(resolveTrustProxySetting({ OVERWATCH_TRUST_PROXY: '172.18.0.0/16' })).toBe('172.18.0.0/16');
    expect(resolveTrustProxySetting({ OVERWATCH_TRUST_PROXY: 'loopback, linklocal, uniquelocal' }))
      .toBe('loopback, linklocal, uniquelocal');
  });

  it('wires Express trust proxy through the proxy trust resolver', async () => {
    const index = await fs.readFile(path.join(process.cwd(), 'src/index.ts'), 'utf-8');
    expect(index).toContain('resolveTrustProxySetting');
    expect(index).not.toContain("app.set('trust proxy', 1)");
  });

  it('repairs stray bind-mount directories where files are expected', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    // Simulate Docker auto-creating bind targets as empty directories.
    await fs.mkdir(path.join(dataDir, 'audit.log'));
    await fs.mkdir(path.join(dataDir, 'notification-channels.json'));
    // And one with content that must NOT be removed silently.
    const stranded = path.join(dataDir, 'tenant-env-overrides.json');
    await fs.mkdir(stranded);
    await fs.writeFile(path.join(stranded, 'something'), 'do not delete me');

    const { repairBindMountedDataFiles } = await import('../services/startupMaintenance');
    const result = await repairBindMountedDataFiles(dataDir);

    expect(result.repaired).toBe(2);
    expect(result.stranded).toEqual([stranded]);
    await expect(fs.stat(path.join(dataDir, 'audit.log'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(dataDir, 'notification-channels.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Stranded dir is left intact for operator inspection.
    await expect(fs.readFile(path.join(stranded, 'something'), 'utf-8')).resolves.toBe('do not delete me');
  });
});
