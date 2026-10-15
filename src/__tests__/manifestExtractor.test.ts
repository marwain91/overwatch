import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
// an actual daemon. The module runs docker through runDocker, which calls
// execFile(cmd, args, opts, cb).
type DockerReply = { stdout?: string; stderr?: string; fail?: boolean | string; timeout?: boolean };
interface DockerCall { args: string[]; opts: any }

function mockExecFile(handler: (args: string[]) => DockerReply, calls: DockerCall[] = []) {
  vi.doMock('child_process', () => ({
    execFile: (_cmd: string, args: string[], opts: any, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      calls.push({ args, opts });
      const result = handler(args);
      if (result.timeout) {
        cb(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '', '');
      } else if (result.fail) {
        const stderr = typeof result.fail === 'string' ? result.fail : 'docker failed';
        cb(Object.assign(new Error('Command failed'), { code: 1 }), '', stderr);
      } else {
        cb(null, result.stdout ?? '', result.stderr ?? '');
      }
      return { on() {} };
    },
  }));
}

describe('extractFileFromImage — docker interactions', () => {
  beforeEach(() => {
    vi.resetModules();
  });

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

describe('extractFileFromImage — timeouts, env and cleanup', () => {
  const SAVED_ENV = { ...process.env };
  const local = (args: string[]) => args[0] === 'image' && args[1] === 'inspect';
  const missing = 'Error response from daemon: No such image: ghcr.io/x/y:1';

  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = 'jwt-secret';
    process.env.MYSQL_ROOT_PASSWORD = 'root-pw';
  });
  afterEach(() => {
    vi.doUnmock('child_process');
    vi.doUnmock('../adapters/registry');
    vi.restoreAllMocks();
    for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
    Object.assign(process.env, SAVED_ENV);
  });

  it('runs every docker call with a timeout and the curated env', async () => {
    const fsSync = await import('fs');
    const calls: DockerCall[] = [];
    mockExecFile((args) => {
      if (local(args)) return { fail: missing };
      if (args[0] === 'cp') { fsSync.writeFileSync(args[2], '{}'); return {}; }
      return {};
    }, calls);
    const { extractFileFromImage } = await import('../services/manifestExtractor');
    const { COMPOSE_LONG_TIMEOUT_MS } = await import('../services/composeTimeouts');
    await extractFileFromImage('ghcr.io/x/y:1', '/overwatch/app.json');

    expect(calls.map(c => c.args[0])).toEqual(['image', 'pull', 'create', 'cp', 'rm']);
    for (const { opts } of calls) {
      expect(opts.timeout).toBeGreaterThan(0);
      expect(opts.env).not.toHaveProperty('JWT_SECRET');
      expect(opts.env).not.toHaveProperty('MYSQL_ROOT_PASSWORD');
    }
    // A pull can legitimately take long; the bound only stops a stalled registry.
    expect(calls.find(c => c.args[0] === 'pull')!.opts.timeout).toBe(COMPOSE_LONG_TIMEOUT_MS);
    expect(calls.find(c => c.args[0] === 'create')!.opts.timeout).toBeLessThan(COMPOSE_LONG_TIMEOUT_MS);
  });

  it('ends docker options before the image reference', async () => {
    const fsSync = await import('fs');
    const calls: DockerCall[] = [];
    mockExecFile((args) => {
      if (local(args)) return { fail: missing };
      if (args[0] === 'cp') { fsSync.writeFileSync(args[2], '{}'); return {}; }
      return {};
    }, calls);
    const { extractFileFromImage } = await import('../services/manifestExtractor');
    await extractFileFromImage('ghcr.io/x/y:1', '/overwatch/app.json');
    for (const verb of ['image', 'pull', 'create']) {
      const args = calls.find(c => c.args[0] === verb)!.args;
      expect(args.slice(-2)).toEqual(['--', 'ghcr.io/x/y:1']);
    }
  });

  it('removes the temporary container even when docker create times out', async () => {
    const calls: DockerCall[] = [];
    mockExecFile((args) => {
      if (local(args)) return { stdout: '[{}]' };
      if (args[0] === 'create') return { timeout: true };
      return {};
    }, calls);
    const { extractFileFromImage } = await import('../services/manifestExtractor');
    await expect(extractFileFromImage('ghcr.io/x/y:1', '/overwatch/app.json')).rejects.toThrow(/timed out/);
    const create = calls.find(c => c.args[0] === 'create')!.args;
    const name = create[create.indexOf('--name') + 1];
    expect(name).toMatch(/^ow-manifest-/);
    expect(calls.find(c => c.args[0] === 'rm')!.args).toEqual(['rm', '-f', name]);
  });

  it('removes the temporary container when docker cp fails', async () => {
    const calls: DockerCall[] = [];
    mockExecFile((args) => {
      if (local(args)) return { stdout: '[{}]' };
      if (args[0] === 'cp') return { fail: 'permission denied' };
      return {};
    }, calls);
    const { extractFileFromImage } = await import('../services/manifestExtractor');
    await expect(extractFileFromImage('ghcr.io/x/y:1', '/overwatch/app.json')).rejects.toThrow(/permission denied/);
    const create = calls.find(c => c.args[0] === 'create')!.args;
    expect(calls.find(c => c.args[0] === 'rm')!.args).toEqual(['rm', '-f', create[create.indexOf('--name') + 1]]);
  });

  it('does not start an hour-long pull when the docker daemon is unreachable', async () => {
    const calls: DockerCall[] = [];
    mockExecFile((args) => {
      if (local(args)) return { fail: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' };
      return {};
    }, calls);
    const { extractFileFromImage } = await import('../services/manifestExtractor');
    await expect(extractFileFromImage('ghcr.io/x/y:1', '/overwatch/app.json')).rejects.toThrow(/Cannot connect/);
    expect(calls.map(c => c.args[0])).toEqual(['image']);
  });

  it('readManifestFromAppImage pulls inside the app registry login', async () => {
    const fsSync = await import('fs');
    const order: string[] = [];
    const withRegistryLogin = vi.fn(async (_app: unknown, fn: () => Promise<unknown>) => {
      order.push('login');
      const result = await fn();
      order.push('release');
      return result;
    });
    vi.doMock('../adapters/registry', () => ({ withRegistryLogin }));
    mockExecFile((args) => {
      order.push(args[0]);
      if (local(args)) return { fail: missing };
      if (args[0] === 'cp') { fsSync.writeFileSync(args[2], '{"id":"acme"}'); return {}; }
      return {};
    });
    const { readManifestFromAppImage } = await import('../services/manifestExtractor');
    const app = buildApp();
    await expect(readManifestFromAppImage(app, 'v1')).resolves.toEqual({ id: 'acme' });
    expect(withRegistryLogin).toHaveBeenCalledWith(app, expect.any(Function));
    expect(order.slice(0, 4)).toEqual(['image', 'login', 'pull', 'release']);
  });

  it('readManifestFromAppImage does not log in for an image that is already local', async () => {
    const fsSync = await import('fs');
    const withRegistryLogin = vi.fn();
    vi.doMock('../adapters/registry', () => ({ withRegistryLogin }));
    mockExecFile((args) => {
      if (local(args)) return { stdout: '[{}]' };
      if (args[0] === 'cp') { fsSync.writeFileSync(args[2], '{"id":"acme"}'); return {}; }
      return {};
    });
    const { readManifestFromAppImage } = await import('../services/manifestExtractor');
    await readManifestFromAppImage(buildApp(), 'v1');
    expect(withRegistryLogin).not.toHaveBeenCalled();
  });
});
