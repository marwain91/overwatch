import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Registry formats are enforced on write and right before use, not on load:
// a definition stored before they existed must not stop Overwatch from starting.

const runDockerMock = vi.fn();
vi.mock('../utils/runDocker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/runDocker')>()),
  runDocker: (...a: unknown[]) => runDockerMock(...a),
}));

const SAVED_ENV = { ...process.env };
let tmpRoot: string;
let dataDir: string;

const VALID = { type: 'gitlab', url: 'registry.acme.com:5050', api_url: 'https://gitlab.acme.com', repository: 'acme/app', auth: { type: 'token', token_env: 'REG_TOKEN' } };
const LEGACY = { ...VALID, url: '--config=/tmp/x', repository: 'acme app', api_url: 'https://user:pw@gitlab.acme.com' };

function def(id: string, registry: Record<string, unknown>) {
  return {
    id,
    name: id,
    domain_template: `*.${id}.example`,
    registry,
    services: [{ name: 'backend', image_suffix: 'backend', ports: { internal: 80 } }],
    default_image_tag: 'latest',
  };
}

async function store(id: string, registry: Record<string, unknown>) {
  await fs.writeFile(path.join(dataDir, 'apps.d', `${id}.json`), JSON.stringify(def(id, registry)));
}

beforeEach(async () => {
  vi.resetModules();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-registry-legacy-'));
  dataDir = path.join(tmpRoot, 'data');
  await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
  vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
  vi.doMock('../config/loader', () => ({ getAppsDir: () => path.join(tmpRoot, 'apps') }));
  vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
  runDockerMock.mockReset();
  runDockerMock.mockResolvedValue({ stdout: '', stderr: '' });
  process.env.REG_TOKEN = 'reg-token';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  for (const m of ['../config', '../config/loader', '../services/fileLock']) vi.doUnmock(m);
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
  Object.assign(process.env, SAVED_ENV);
});

describe('a stored definition with registry values that predate the formats', () => {
  it('still loads, the app list works, and each bad field is warned about once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store('legacy', LEGACY);
    await store('good', VALID);
    const { listApps, getApp } = await import('../services/app');

    expect((await listApps()).map(a => a.id)).toEqual(['good', 'legacy']);
    expect((await getApp('legacy'))!.registry.url).toBe('--config=/tmp/x');
    await fs.utimes(path.join(dataDir, 'apps.d', 'legacy.json'), new Date(), new Date(Date.now() + 5000));
    await listApps();

    const warnings = warn.mock.calls.map(c => String(c[0])).filter(m => m.includes("App 'legacy'"));
    expect(warnings).toHaveLength(3);
    for (const field of ['url', 'repository', 'api_url']) {
      expect(warnings.some(w => w.includes(`registry.${field}:`))).toBe(true);
    }
    expect(warn.mock.calls.map(c => String(c[0])).some(m => m.includes("App 'good'"))).toBe(false);
  });

  it('refuses a pull, login or tag listing for that app with a clear error and no docker or API call', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await store('legacy', LEGACY);
    const { getApp } = await import('../services/app');
    const app = (await getApp('legacy'))!;
    const registry = await import('../adapters/registry');
    const { readManifestFromAppImage } = await import('../services/manifestExtractor');
    const pull = vi.fn();

    const refused = /Refusing to pull for app 'legacy', its registry settings are invalid: registry\.url: .*registry\.repository: /;
    await expect(registry.ensureRegistryLogin(app)).rejects.toThrow(refused);
    await expect(registry.withRegistryLogin(app, pull)).rejects.toThrow(refused);
    await expect(registry.loginToRegistryForApp(app)).rejects.toThrow(refused);
    await expect(readManifestFromAppImage(app, 'v1')).rejects.toThrow(refused);
    await expect(registry.getImageTagsForApp(app)).rejects.toThrow(/Refusing to list tags for app 'legacy'.*registry\.api_url: /);

    expect(pull).not.toHaveBeenCalled();
    expect(runDockerMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps pulling when only api_url, which pulls never use, is invalid', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store('tags-only', { ...VALID, api_url: 'https://user:pw@gitlab.acme.com' });
    const { getApp } = await import('../services/app');
    const app = (await getApp('tags-only'))!;
    const registry = await import('../adapters/registry');
    await expect(registry.withRegistryLogin(app, async () => 'pulled')).resolves.toBe('pulled');
    expect(runDockerMock.mock.calls[0][1]).toEqual(['login', '--username=oauth2', '--password-stdin', '--', 'registry.acme.com:5050']);
    await expect(registry.getImageTagsForApp(app)).rejects.toThrow(/registry\.api_url/);
  });
});

describe('writes of registry values', () => {
  it('are refused with a 400 when a new value has the wrong format', async () => {
    const { createApp, updateApp, applyApp } = await import('../services/app');
    const { ValidationError } = await import('../utils/httpErrors');

    await expect(createApp(def('fresh', LEGACY) as any)).rejects.toBeInstanceOf(ValidationError);
    await expect(createApp(def('fresh', LEGACY) as any)).rejects.toThrow(/Invalid app definition: registry\.url: .*registry\.repository: .*registry\.api_url: /);
    await expect(applyApp(def('applied', { ...VALID, url: '-H' }), 'test')).rejects.toThrow(/registry\.url: /);

    await store('good', VALID);
    await expect(updateApp({ id: 'good', registry: { ...VALID, repository: '--help' } } as any)).rejects.toThrow(/registry\.repository: /);
    expect(JSON.parse(await fs.readFile(path.join(dataDir, 'apps.d', 'good.json'), 'utf-8')).registry.repository).toBe('acme/app');
  });

  it('let an edit through that leaves a stored legacy value unchanged', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store('legacy', LEGACY);
    const { updateApp, applyApp } = await import('../services/app');

    await expect(updateApp({ id: 'legacy', name: 'Renamed' } as any)).resolves.toMatchObject({ name: 'Renamed' });
    // The UI sends the whole registry block back; the manifest sync re-applies it too.
    await expect(updateApp({ id: 'legacy', registry: LEGACY } as any)).resolves.toBeTruthy();
    await expect(applyApp({ ...def('legacy', LEGACY), name: 'Applied' }, 'test')).resolves.toMatchObject({ result: 'updated' });
    // Changing one field checks that field.
    await expect(updateApp({ id: 'legacy', registry: { ...LEGACY, url: '-H' } } as any)).rejects.toThrow(/registry\.url: /);
  });
});
