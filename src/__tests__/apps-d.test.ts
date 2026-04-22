import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;
let dataDir: string;

function validStatic(id: string) {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    domain_template: `*.${id}.example`,
    registry: { type: 'ghcr', url: 'ghcr.io', repository: `ns/${id}`, auth: { type: 'token' } },
    services: [{ name: 'web', image_suffix: 'web', ports: { internal: 80 } }],
    default_image_tag: 'latest',
  };
}

async function setup() {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-apps-d-'));
  dataDir = path.join(tmpRoot, 'data');
  await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
  vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
  vi.doMock('../config/loader', () => ({ getAppsDir: () => path.join(tmpRoot, 'apps') }));
  vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
}

beforeEach(async () => {
  await setup();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe('readApps — apps.d/ + apps.runtime.json', () => {
  it('merges a single static file with its runtime entry', async () => {
    await fs.writeFile(path.join(dataDir, 'apps.d', 'kwoutr.json'), JSON.stringify(validStatic('kwoutr')));
    await fs.writeFile(path.join(dataDir, 'apps.runtime.json'), JSON.stringify({
      kwoutr: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-02T00:00:00Z' },
    }));

    const { listApps } = await import('../services/app');
    const apps = await listApps();

    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe('kwoutr');
    expect(apps[0].createdAt).toBe('2026-01-01T00:00:00Z');
    expect(apps[0].updatedAt).toBe('2026-02-02T00:00:00Z');
  });

  it('returns multiple apps sorted by id', async () => {
    for (const id of ['goalmaster', 'kwoutr', 'finalio']) {
      await fs.writeFile(path.join(dataDir, 'apps.d', `${id}.json`), JSON.stringify(validStatic(id)));
    }
    await fs.writeFile(path.join(dataDir, 'apps.runtime.json'), JSON.stringify({
      goalmaster: { createdAt: 'a', updatedAt: 'a' },
      kwoutr: { createdAt: 'a', updatedAt: 'a' },
      finalio: { createdAt: 'a', updatedAt: 'a' },
    }));

    const { listApps } = await import('../services/app');
    const apps = await listApps();

    expect(apps.map(a => a.id)).toEqual(['finalio', 'goalmaster', 'kwoutr']);
  });

  it('synthesises a runtime entry when a static file has no runtime record, and persists it', async () => {
    await fs.writeFile(path.join(dataDir, 'apps.d', 'kwoutr.json'), JSON.stringify(validStatic('kwoutr')));
    // No apps.runtime.json on disk — readApps must create one.

    const { listApps } = await import('../services/app');
    const apps = await listApps();

    expect(apps).toHaveLength(1);
    expect(apps[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(apps[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const runtimeRaw = await fs.readFile(path.join(dataDir, 'apps.runtime.json'), 'utf-8');
    const runtime = JSON.parse(runtimeRaw);
    expect(runtime.kwoutr).toBeDefined();
    expect(runtime.kwoutr.createdAt).toBe(apps[0].createdAt);
  });

  it('returns empty array when apps.d/ exists but is empty', async () => {
    const { listApps } = await import('../services/app');
    const apps = await listApps();
    expect(apps).toEqual([]);
  });

  it('throws when a static file is malformed', async () => {
    await fs.writeFile(path.join(dataDir, 'apps.d', 'broken.json'), '{not valid');
    const { listApps } = await import('../services/app');
    await expect(listApps()).rejects.toThrow(/broken\.json/);
  });

  it('throws when a static file fails schema validation', async () => {
    await fs.writeFile(path.join(dataDir, 'apps.d', 'bad.json'), JSON.stringify({ id: 'bad' }));
    const { listApps } = await import('../services/app');
    await expect(listApps()).rejects.toThrow(/bad\.json/);
  });
});
