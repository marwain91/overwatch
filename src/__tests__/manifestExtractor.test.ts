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

  it('refuses a manifest above 1 MiB (warns, returns null, removes the temp file)', async () => {
    const fsSync = await import('fs');
    let tmp = '';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExecFile((args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { stdout: '[{}]' };
      if (args[0] === 'create') return { stdout: 'cid-789\n' };
      if (args[0] === 'cp') { tmp = args[2]; fsSync.writeFileSync(tmp, 'x'.repeat(1024 * 1024 + 1)); return { stdout: '' }; }
      return { stdout: '' };
    });
    const { extractFileFromImage } = await import('../services/manifestExtractor');
    await expect(extractFileFromImage('ghcr.io/x/y:1', '/overwatch/app.json')).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(fsSync.existsSync(tmp)).toBe(false);
    warn.mockRestore();
  });

  it('reads a manifest at the limit', async () => {
    const fsSync = await import('fs');
    mockExecFile((args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { stdout: '[{}]' };
      if (args[0] === 'create') return { stdout: 'cid-790\n' };
      if (args[0] === 'cp') { fsSync.writeFileSync(args[2], '{"id":"x"}'); return { stdout: '' }; }
      return { stdout: '' };
    });
    const { extractFileFromImage } = await import('../services/manifestExtractor');
    await expect(extractFileFromImage('ghcr.io/x/y:1', '/overwatch/app.json')).resolves.toBe('{"id":"x"}');
  });

  it('never follows a manifest that docker cp delivered as a symlink', async () => {
    const fsSync = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const outside = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ow-outside-'));
    const secret = path.join(outside, 'admin-users.json');
    fsSync.writeFileSync(secret, '{"secret":"host-file"}');
    let dest = '';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExecFile((args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { stdout: '[{}]' };
      if (args[0] === 'create') return { stdout: 'cid-791\n' };
      if (args[0] === 'cp') { dest = args[2]; fsSync.symlinkSync(secret, dest); return { stdout: '' }; }
      return { stdout: '' };
    });
    const { extractFileFromImage } = await import('../services/manifestExtractor');
    await expect(extractFileFromImage('ghcr.io/x/y:1', '/overwatch/app.json')).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(fsSync.readFileSync(secret, 'utf-8')).toBe('{"secret":"host-file"}');
    expect(fsSync.existsSync(path.dirname(dest))).toBe(false);
    warn.mockRestore();
    fsSync.rmSync(outside, { recursive: true, force: true });
  });

  it('ignores a manifest path that is not a regular file', async () => {
    const fsSync = await import('fs');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExecFile((args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { stdout: '[{}]' };
      if (args[0] === 'create') return { stdout: 'cid-792\n' };
      if (args[0] === 'cp') { fsSync.mkdirSync(args[2]); return { stdout: '' }; }
      return { stdout: '' };
    });
    const { extractFileFromImage } = await import('../services/manifestExtractor');
    await expect(extractFileFromImage('ghcr.io/x/y:1', '/overwatch/app.json')).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not block on a manifest that docker cp delivered as a FIFO', async () => {
    const realCp = await vi.importActual<typeof import('child_process')>('child_process');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExecFile((args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { stdout: '[{}]' };
      if (args[0] === 'create') return { stdout: 'cid-795\n' };
      if (args[0] === 'cp') { realCp.execFileSync('mkfifo', [args[2]]); return { stdout: '' }; }
      return { stdout: '' };
    });
    const { extractFileFromImage } = await import('../services/manifestExtractor');
    await expect(extractFileFromImage('ghcr.io/x/y:1', '/overwatch/app.json')).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('copies into a private temp directory that is removed afterwards', async () => {
    const fsSync = await import('fs');
    const os = await import('os');
    const path = await import('path');
    let dest = '';
    let dirMode = 0;
    mockExecFile((args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { stdout: '[{}]' };
      if (args[0] === 'create') return { stdout: 'cid-793\n' };
      if (args[0] === 'cp') {
        dest = args[2];
        dirMode = fsSync.statSync(path.dirname(dest)).mode & 0o777;
        fsSync.writeFileSync(dest, '{"id":"x"}');
        return { stdout: '' };
      }
      return { stdout: '' };
    });
    const { extractFileFromImage } = await import('../services/manifestExtractor');
    await extractFileFromImage('ghcr.io/x/y:1', '/overwatch/app.json');
    expect(path.dirname(dest)).not.toBe(os.tmpdir());
    expect(dirMode).toBe(0o700);
    expect(fsSync.existsSync(path.dirname(dest))).toBe(false);
  });

  it('does not echo manifest content in the invalid-JSON error', async () => {
    const fsSync = await import('fs');
    mockExecFile((args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { stdout: '[{}]' };
      if (args[0] === 'create') return { stdout: 'cid-794\n' };
      if (args[0] === 'cp') { fsSync.writeFileSync(args[2], 'SECRETVALUE not json'); return { stdout: '' }; }
      return { stdout: '' };
    });
    const { readManifestFromAppImage } = await import('../services/manifestExtractor');
    const err = await readManifestFromAppImage(buildApp(), 'v1').catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not valid JSON/);
    expect((err as Error).message).not.toContain('SECRETVALUE');
  });
});
