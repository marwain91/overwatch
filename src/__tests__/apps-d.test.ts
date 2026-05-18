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
    await fs.writeFile(path.join(dataDir, 'apps.d', 'acme.json'), JSON.stringify(validStatic('acme')));
    await fs.writeFile(path.join(dataDir, 'apps.runtime.json'), JSON.stringify({
      acme: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-02T00:00:00Z' },
    }));

    const { listApps } = await import('../services/app');
    const apps = await listApps();

    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe('acme');
    expect(apps[0].createdAt).toBe('2026-01-01T00:00:00Z');
    expect(apps[0].updatedAt).toBe('2026-02-02T00:00:00Z');
  });

  it('returns multiple apps sorted by id', async () => {
    for (const id of ['widgets', 'acme', 'gadgets']) {
      await fs.writeFile(path.join(dataDir, 'apps.d', `${id}.json`), JSON.stringify(validStatic(id)));
    }
    const iso = new Date(0).toISOString();
    await fs.writeFile(path.join(dataDir, 'apps.runtime.json'), JSON.stringify({
      widgets: { createdAt: iso, updatedAt: iso },
      acme: { createdAt: iso, updatedAt: iso },
      gadgets: { createdAt: iso, updatedAt: iso },
    }));

    const { listApps } = await import('../services/app');
    const apps = await listApps();

    expect(apps.map(a => a.id)).toEqual(['acme', 'gadgets', 'widgets']);
  });

  it('synthesises a runtime entry when a static file has no runtime record, and persists it', async () => {
    await fs.writeFile(path.join(dataDir, 'apps.d', 'acme.json'), JSON.stringify(validStatic('acme')));
    // No apps.runtime.json on disk — readApps must create one.

    const { listApps } = await import('../services/app');
    const apps = await listApps();

    expect(apps).toHaveLength(1);
    expect(apps[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(apps[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const runtimeRaw = await fs.readFile(path.join(dataDir, 'apps.runtime.json'), 'utf-8');
    const runtime = JSON.parse(runtimeRaw);
    expect(runtime.acme).toBeDefined();
    expect(runtime.acme.createdAt).toBe(apps[0].createdAt);
    expect(runtime.acme.updatedAt).toBe(apps[0].updatedAt);
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

describe('applyApp — CLI upsert semantics', () => {
  it('creates a new app when none exists with that id', async () => {
    const { applyApp } = await import('../services/app');
    const result = await applyApp(validStatic('acme'), 'cli:test');

    expect(result.result).toBe('created');
    expect(result.app.id).toBe('acme');
    expect(result.app.createdAt).toBe(result.app.updatedAt);

    const files = await fs.readdir(path.join(dataDir, 'apps.d'));
    expect(files).toEqual(['acme.json']);
  });

  it('updates an existing app and preserves createdAt', async () => {
    const { applyApp } = await import('../services/app');
    const first = await applyApp(validStatic('acme'), 'cli:test');
    // Force a time gap so updatedAt would differ if bumped.
    await new Promise(r => setTimeout(r, 5));

    const modified = { ...validStatic('acme'), domain_template: '*.acme.io' };
    const second = await applyApp(modified, 'cli:test');

    expect(second.result).toBe('updated');
    expect(second.app.createdAt).toBe(first.app.createdAt);
    expect(second.app.updatedAt).not.toBe(first.app.updatedAt);
    expect(second.changedKeys).toContain('domain_template');
  });

  it('is a no-op when applying an unchanged file', async () => {
    const { applyApp } = await import('../services/app');
    const first = await applyApp(validStatic('acme'), 'cli:test');
    await new Promise(r => setTimeout(r, 5));
    const second = await applyApp(validStatic('acme'), 'cli:test');

    expect(second.result).toBe('noop');
    expect(second.app.updatedAt).toBe(first.app.updatedAt);
    expect(second.changedKeys).toEqual([]);
  });

  it('rejects when the id is in the trash', async () => {
    await fs.writeFile(path.join(dataDir, 'apps.trashed.json'), JSON.stringify([{
      app: { ...validStatic('acme'), createdAt: 'x', updatedAt: 'x' },
      deletedAt: 'x', deletedBy: 'x', tenantCount: 0,
    }]));
    const { applyApp } = await import('../services/app');
    await expect(applyApp(validStatic('acme'), 'cli:test')).rejects.toThrow(/in trash/);
  });

  it('rejects input that fails static schema validation', async () => {
    const { applyApp } = await import('../services/app');
    await expect(applyApp({ id: 'acme' }, 'cli:test')).rejects.toThrow(/validation/);
  });

  it('rejects input that includes createdAt/updatedAt (static-only shape)', async () => {
    const { applyApp } = await import('../services/app');
    const withRuntime = { ...validStatic('acme'), createdAt: 'x', updatedAt: 'x' };
    // Either the schema strips these silently OR rejects them. The test asserts
    // the runtime store is unaffected — the input must not be able to forge createdAt.
    const result = await applyApp(withRuntime, 'cli:test');
    expect(result.app.createdAt).not.toBe('x');
    expect(result.app.updatedAt).not.toBe('x');
  });
});

describe('runAppsV3Migration', () => {
  it('splits a legacy apps.json with 3 apps into apps.d/ + apps.runtime.json', async () => {
    const legacy = [
      { ...validStatic('acme'), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
      { ...validStatic('widgets'), createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-02T00:00:00Z' },
      { ...validStatic('gadgets'), createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-02T00:00:00Z' },
    ];
    await fs.writeFile(path.join(dataDir, 'apps.json'), JSON.stringify(legacy));

    const { runAppsV3Migration } = await import('../services/migration');
    await runAppsV3Migration();

    const files = (await fs.readdir(path.join(dataDir, 'apps.d'))).sort();
    expect(files).toEqual(['acme.json', 'gadgets.json', 'widgets.json']);

    const runtime = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.runtime.json'), 'utf-8'));
    expect(runtime.acme.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(runtime.widgets.updatedAt).toBe('2026-02-02T00:00:00Z');

    // Legacy file renamed to backup.
    await expect(fs.access(path.join(dataDir, 'apps.json'))).rejects.toThrow();
    await expect(fs.access(path.join(dataDir, 'apps.json.pre-apps.d'))).resolves.toBeUndefined();
  });

  it('is idempotent — running a second time is a no-op', async () => {
    const legacy = [{ ...validStatic('acme'), createdAt: 'x', updatedAt: 'x' }];
    await fs.writeFile(path.join(dataDir, 'apps.json'), JSON.stringify(legacy));
    const { runAppsV3Migration } = await import('../services/migration');
    await runAppsV3Migration();
    // Second invocation should detect populated apps.d/ and exit.
    await expect(runAppsV3Migration()).resolves.toBeUndefined();
  });

  it('handles fresh install (no legacy apps.json)', async () => {
    const { runAppsV3Migration } = await import('../services/migration');
    await runAppsV3Migration();
    const runtime = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.runtime.json'), 'utf-8'));
    expect(runtime).toEqual({});
  });
});
