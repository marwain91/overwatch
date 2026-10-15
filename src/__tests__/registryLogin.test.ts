import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppDefinition } from '../models/app';

const runDockerMock = vi.fn();
vi.mock('../utils/runDocker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/runDocker')>()),
  runDocker: (...a: unknown[]) => runDockerMock(...a),
}));

const SAVED_ENV = { ...process.env };

function app(id: string, registry: Partial<AppDefinition['registry']> = {}): AppDefinition {
  return {
    id,
    name: id,
    domain_template: `*.${id}.test`,
    registry: {
      type: 'ghcr',
      url: 'ghcr.io',
      repository: `org/${id}`,
      auth: { type: 'token', token_env: 'TOKEN_A' },
      ...registry,
    },
    services: [],
    default_image_tag: 'latest',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as AppDefinition;
}

const withToken = (env: string) => ({ auth: { type: 'token' as const, token_env: env } });

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Lets queued promise callbacks run.
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

const logins = () => runDockerMock.mock.calls.filter(c => c[1][0] === 'login');
const loginSecrets = () => logins().map(c => c[2].input);

async function load() {
  const registry = await import('../adapters/registry');
  const login = await import('../adapters/registry/login');
  const { DockerCommandError } = await import('../utils/runDocker');
  return { ...registry, ...login, DockerCommandError };
}

beforeEach(() => {
  vi.resetModules();
  runDockerMock.mockReset();
  runDockerMock.mockResolvedValue({ stdout: 'Login Succeeded', stderr: '' });
  process.env.TOKEN_A = 'token-a';
  process.env.TOKEN_B = 'token-b';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
  Object.assign(process.env, SAVED_ENV);
});

describe('apps without registry credentials', () => {
  it('pull exactly as before: no login, no waiting', async () => {
    const { ensureRegistryLogin, withRegistryLogin } = await load();
    await ensureRegistryLogin(app('a', { auth: { type: 'token' } }));
    await ensureRegistryLogin(app('b', withToken('UNSET_TOKEN_ENV')));
    await expect(withRegistryLogin(app('c', { auth: { type: 'token' } }), async () => 'pulled')).resolves.toBe('pulled');
    expect(runDockerMock).not.toHaveBeenCalled();
  });
});

describe('ensureRegistryLogin', () => {
  it('logs in with the app credentials, then reuses the login for the same host and credential', async () => {
    const { ensureRegistryLogin } = await load();
    await ensureRegistryLogin(app('a'));
    await ensureRegistryLogin(app('a'));
    await ensureRegistryLogin(app('a2'));
    expect(logins()).toHaveLength(1);
    expect(logins()[0][1]).toEqual(['login', '--username=x-access-token', '--password-stdin', '--', 'ghcr.io']);
    expect(loginSecrets()).toEqual(['token-a']);
  });

  it('logs in again once the cached login is older than the TTL (ECR tokens expire after 12 h)', async () => {
    vi.useFakeTimers();
    const { ensureRegistryLogin, REGISTRY_LOGIN_TTL_MS } = await load();
    expect(REGISTRY_LOGIN_TTL_MS).toBeLessThan(12 * 60 * 60 * 1000);
    await ensureRegistryLogin(app('a'));
    await vi.advanceTimersByTimeAsync(REGISTRY_LOGIN_TTL_MS - 1000);
    await ensureRegistryLogin(app('a'));
    expect(logins()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    await ensureRegistryLogin(app('a'));
    expect(logins()).toHaveLength(2);
  });

  it('logs in again when the app credential changes, without a restart', async () => {
    vi.useFakeTimers();
    const { ensureRegistryLogin, clearAdapterCache, REGISTRY_LOGIN_HOLD_MS } = await load();
    await ensureRegistryLogin(app('a'));
    await vi.advanceTimersByTimeAsync(REGISTRY_LOGIN_HOLD_MS);
    // An app edit (rotated token_env) clears the adapter cache.
    clearAdapterCache('a');
    await ensureRegistryLogin(app('a', withToken('TOKEN_B')));
    expect(loginSecrets()).toEqual(['token-a', 'token-b']);
  });

  it('logs in for an app created after boot', async () => {
    const { loginToAllRegistries, ensureRegistryLogin } = await load();
    await loginToAllRegistries([]);
    await ensureRegistryLogin(app('new-app'));
    expect(logins()).toHaveLength(1);
  });

  it('keeps the host for its credential until the pull has had time to start', async () => {
    vi.useFakeTimers();
    const { ensureRegistryLogin, REGISTRY_LOGIN_HOLD_MS } = await load();
    await ensureRegistryLogin(app('a'));
    let bDone = false;
    const b = ensureRegistryLogin(app('b', withToken('TOKEN_B'))).then(() => { bDone = true; });
    await vi.advanceTimersByTimeAsync(REGISTRY_LOGIN_HOLD_MS - 1);
    expect(bDone).toBe(false);
    expect(loginSecrets()).toEqual(['token-a']);
    await vi.advanceTimersByTimeAsync(1);
    await b;
    expect(loginSecrets()).toEqual(['token-a', 'token-b']);
  });

  it('does not hold up another pull with the same credential', async () => {
    vi.useFakeTimers();
    const { ensureRegistryLogin } = await load();
    await ensureRegistryLogin(app('a'));
    await ensureRegistryLogin(app('a2'));
    expect(logins()).toHaveLength(1);
  });

  it('warns and still pulls when the registry rejects the login, and retries on the next pull', async () => {
    // Before per-pull logins a failed boot login only warned; pulls then ran with
    // whatever docker had (host-mounted credentials, anonymous for public images).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ensureRegistryLogin, DockerCommandError } = await load();
    runDockerMock.mockRejectedValueOnce(new DockerCommandError('docker login --username=x-access-token --password-stdin -- ghcr.io failed', 'unknown', {
      stderr: 'Error response from daemon: Get "https://ghcr.io/v2/": denied: denied\n', stdout: '', exitCode: 1, command: 'docker', args: [],
    }));
    await expect(ensureRegistryLogin(app('a'))).resolves.toBeUndefined();
    const message = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(message).toMatch(/Registry login to ghcr\.io failed for app 'a': Error response from daemon: .*denied/);
    expect(message).toMatch(/existing docker credentials/);
    expect(message).not.toContain('token-a');
    await ensureRegistryLogin(app('a'));
    expect(logins()).toHaveLength(2);
  });

  it('does not let a timed-out login stop the pull', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ensureRegistryLogin } = await load();
    runDockerMock.mockRejectedValueOnce(new Error('docker login… timed out after 60000ms'));
    await expect(ensureRegistryLogin(app('a'))).resolves.toBeUndefined();
  });

  it('skips the login, without failing the pull, when the app registry config cannot be used', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.JWT_SECRET = 'jwt-secret';
    const { ensureRegistryLogin, withRegistryLogin } = await load();
    // An invalid tag_pattern only ever broke tag listing.
    await expect(ensureRegistryLogin(app('a', { tag_pattern: '[' }))).resolves.toBeUndefined();
    // A reserved secret is never handed to a registry.
    await expect(withRegistryLogin(app('b', withToken('JWT_SECRET')), async () => 'pulled')).resolves.toBe('pulled');
    expect(runDockerMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/app 'b'.*reserved/));
  });

  it('does not make a fresh login wait for another registry login in progress', async () => {
    const { ensureRegistryLogin } = await load();
    await ensureRegistryLogin(app('a'));
    const slowLogin = deferred<{ stdout: string; stderr: string }>();
    runDockerMock.mockReturnValueOnce(slowLogin.promise);
    const gitlab = ensureRegistryLogin(app('g', { type: 'gitlab', url: 'registry.gitlab.com', ...withToken('TOKEN_B') }));
    await flush();
    await expect(ensureRegistryLogin(app('a'))).resolves.toBeUndefined();
    slowLogin.resolve({ stdout: '', stderr: '' });
    await gitlab;
    expect(loginSecrets()).toEqual(['token-a', 'token-b']);
  });

  it('keeps pulling with the existing docker credentials when the login cannot be stored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ensureRegistryLogin, DockerCommandError } = await load();
    runDockerMock.mockRejectedValue(new DockerCommandError('docker login failed', 'unknown', {
      stderr: 'error saving credentials: open /root/.docker/config.json1: read-only file system\n', stdout: '', exitCode: 1, command: 'docker', args: [],
    }));
    await expect(ensureRegistryLogin(app('a'))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/app 'a'.*read-only file system/s));
    await ensureRegistryLogin(app('a'));
    expect(logins()).toHaveLength(2);
  });
});

describe('withRegistryLogin', () => {
  it('serializes login and pull per host when the credentials differ', async () => {
    const { withRegistryLogin } = await load();
    const pullA = deferred();
    const order: string[] = [];
    const a = withRegistryLogin(app('a'), async () => { order.push('pull a'); await pullA.promise; order.push('pull a done'); });
    await flush();
    const b = withRegistryLogin(app('b', withToken('TOKEN_B')), async () => { order.push('pull b'); });
    await flush();
    expect(loginSecrets()).toEqual(['token-a']);
    expect(order).toEqual(['pull a']);
    pullA.resolve();
    await Promise.all([a, b]);
    expect(loginSecrets()).toEqual(['token-a', 'token-b']);
    expect(order).toEqual(['pull a', 'pull a done', 'pull b']);
  });

  it('lets pulls with the same credential run together', async () => {
    const { withRegistryLogin } = await load();
    const pullA = deferred();
    const started: string[] = [];
    const a = withRegistryLogin(app('a'), async () => { started.push('a'); await pullA.promise; });
    const a2 = withRegistryLogin(app('a2'), async () => { started.push('a2'); });
    await a2;
    expect(started).toEqual(['a', 'a2']);
    pullA.resolve();
    await a;
    expect(logins()).toHaveLength(1);
  });

  it('does not make pulls from different hosts wait for each other', async () => {
    const { withRegistryLogin } = await load();
    const pullA = deferred();
    const a = withRegistryLogin(app('a'), () => pullA.promise);
    const gitlab = app('g', { type: 'gitlab', url: 'registry.gitlab.com', ...withToken('TOKEN_B') });
    await expect(withRegistryLogin(gitlab, async () => 'pulled')).resolves.toBe('pulled');
    pullA.resolve();
    await a;
  });

  it('never runs two docker logins at once (all registries share one config file)', async () => {
    const { withRegistryLogin } = await load();
    const firstLogin = deferred<{ stdout: string; stderr: string }>();
    runDockerMock.mockReturnValueOnce(firstLogin.promise);
    const a = withRegistryLogin(app('a'), async () => undefined);
    const gitlab = app('g', { type: 'gitlab', url: 'registry.gitlab.com', ...withToken('TOKEN_B') });
    const g = withRegistryLogin(gitlab, async () => undefined);
    await flush();
    expect(logins()).toHaveLength(1);
    firstLogin.resolve({ stdout: '', stderr: '' });
    await Promise.all([a, g]);
    expect(logins()).toHaveLength(2);
  });

  it('still pulls after a failed login', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { withRegistryLogin } = await load();
    runDockerMock.mockRejectedValueOnce(new Error('unauthorized'));
    await expect(withRegistryLogin(app('a'), async () => 'pulled')).resolves.toBe('pulled');
  });

  it('gives a waiting credential its turn before later arrivals with the held one', async () => {
    const { withRegistryLogin } = await load();
    const pullA = deferred();
    const order: string[] = [];
    const a = withRegistryLogin(app('a'), async () => { order.push('a'); await pullA.promise; });
    await flush();
    const b = withRegistryLogin(app('b', withToken('TOKEN_B')), async () => { order.push('b'); });
    await flush();
    const a2 = withRegistryLogin(app('a2'), async () => { order.push('a2'); });
    await flush();
    expect(order).toEqual(['a']);
    pullA.resolve();
    await Promise.all([a, b, a2]);
    expect(order).toEqual(['a', 'b', 'a2']);
    expect(loginSecrets()).toEqual(['token-a', 'token-b', 'token-a']);
  });

  it('uses Docker Hub as the host for dockerhub apps', async () => {
    const { withRegistryLogin } = await load();
    process.env.HUB_USER = 'bob';
    const hub = app('h', { type: 'dockerhub', url: 'docker.io', auth: { type: 'basic', username_env: 'HUB_USER', token_env: 'TOKEN_B' } });
    await withRegistryLogin(hub, async () => undefined);
    expect(logins()[0][1]).toEqual(['login', '--username=bob', '--password-stdin']);
  });
});

describe('boot login', () => {
  it('warms the cache so the first pull does not log in again', async () => {
    const { loginToAllRegistries, ensureRegistryLogin } = await load();
    await loginToAllRegistries([app('a'), app('none', { auth: { type: 'token' } })]);
    await ensureRegistryLogin(app('a'));
    expect(logins()).toHaveLength(1);
  });

  it('reports an unusable registry config at boot and carries on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { loginToAllRegistries } = await load();
    await loginToAllRegistries([app('bad', { tag_pattern: '[' }), app('a')]);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/app 'bad'/), expect.anything());
    expect(logins()).toHaveLength(1);
  });

  it('keeps booting when a login fails', async () => {
    const { loginToAllRegistries } = await load();
    runDockerMock.mockRejectedValueOnce(new Error('unauthorized'));
    await expect(loginToAllRegistries([app('a'), app('g', { type: 'gitlab', url: 'registry.gitlab.com', ...withToken('TOKEN_B') })])).resolves.toBeUndefined();
    expect(logins()).toHaveLength(2);
  });
});
