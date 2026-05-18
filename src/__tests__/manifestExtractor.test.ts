import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppDefinition } from '../models/app';

function buildApp(overrides: Partial<AppDefinition> = {}): AppDefinition {
  return {
    id: 'acme',
    name: 'Acme',
    domain_template: '*.acme.io',
    registry: {
      type: 'ghcr',
      url: 'ghcr.io',
      repository: 'marwain91/acme',
      auth: { type: 'token', token_env: 'GHCR_TOKEN' },
    },
    services: [
      { name: 'backend', required: true, is_init_container: false, image_suffix: 'backend' },
      { name: 'frontend', required: true, is_init_container: false, image_suffix: 'frontend' },
    ] as any,
    default_image_tag: 'latest',
    createdAt: 'x',
    updatedAt: 'x',
    ...overrides,
  } as AppDefinition;
}

describe('resolveManifestImageRef', () => {
  it('defaults to the service with image_suffix=backend', async () => {
    const { resolveManifestImageRef } = await import('../services/manifestExtractor');
    const app = buildApp();
    expect(resolveManifestImageRef(app, 'v1.2.3')).toBe('ghcr.io/marwain91/acme/backend:v1.2.3');
  });

  it('honours an explicit manifest.image_suffix override', async () => {
    const { resolveManifestImageRef } = await import('../services/manifestExtractor');
    const app = buildApp({
      manifest: { image_suffix: 'frontend', path: '/overwatch/app.json' },
    });
    expect(resolveManifestImageRef(app, 'v4')).toBe('ghcr.io/marwain91/acme/frontend:v4');
  });

  it('returns null when no matching service exists', async () => {
    const { resolveManifestImageRef } = await import('../services/manifestExtractor');
    const app = buildApp({
      manifest: { image_suffix: 'does-not-exist', path: '/overwatch/app.json' },
    });
    expect(resolveManifestImageRef(app, 'v1')).toBeNull();
  });
});

describe('resolveManifestPathInImage', () => {
  it('defaults to /overwatch/app.json when no manifest config', async () => {
    const { resolveManifestPathInImage } = await import('../services/manifestExtractor');
    const app = buildApp();
    expect(resolveManifestPathInImage(app)).toBe('/overwatch/app.json');
  });

  it('honours an explicit manifest.path override', async () => {
    const { resolveManifestPathInImage } = await import('../services/manifestExtractor');
    const app = buildApp({
      manifest: { image_suffix: 'backend', path: '/etc/overwatch/manifest.json' },
    });
    expect(resolveManifestPathInImage(app)).toBe('/etc/overwatch/manifest.json');
  });
});

// Mock the docker CLI calls so we can exercise extractFileFromImage without
// an actual daemon. The module uses promisify(execFile) internally, so we
// vi.mock the entire child_process + util pair.
describe('extractFileFromImage — docker interactions', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function mockExecFile(handler: (args: string[]) => { stdout?: string; stderr?: string; fail?: boolean | string }) {
    vi.doMock('child_process', () => ({
      execFile: (
        _cmd: string,
        args: string[],
        _optsOrCb: any,
        maybeCb?: (err: Error | null, out: { stdout: string; stderr: string }) => void,
      ) => {
        const cb = typeof _optsOrCb === 'function' ? _optsOrCb : maybeCb!;
        const result = handler(args);
        if (result.fail) {
          const err: any = new Error(typeof result.fail === 'string' ? result.fail : 'docker failed');
          err.stderr = typeof result.fail === 'string' ? result.fail : '';
          cb(err, { stdout: '', stderr: err.stderr });
          return;
        }
        cb(null, { stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
      },
    }));
  }

  it('returns null when docker cp reports "No such file or directory"', async () => {
    mockExecFile((args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { stdout: '[{}]' };
      if (args[0] === 'create') return { stdout: 'cid-123\n' };
      if (args[0] === 'cp') return { fail: 'Error: No such file or directory' };
      if (args[0] === 'rm') return { stdout: '' };
      return { stdout: '' };
    });
    const { extractFileFromImage } = await import('../services/manifestExtractor');
    const result = await extractFileFromImage('ghcr.io/x/y:1', '/overwatch/app.json');
    expect(result).toBeNull();
  });

  it('rethrows non-"file not found" docker-cp errors', async () => {
    mockExecFile((args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { stdout: '[{}]' };
      if (args[0] === 'create') return { stdout: 'cid-456\n' };
      if (args[0] === 'cp') return { fail: 'permission denied' };
      return { stdout: '' };
    });
    const { extractFileFromImage } = await import('../services/manifestExtractor');
    await expect(extractFileFromImage('ghcr.io/x/y:1', '/overwatch/app.json'))
      .rejects.toThrow(/permission denied/);
  });
});
