# apps.d/ storage + `overwatch apps apply` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `apps.json` file with per-app static files in `apps.d/<id>.json` plus a sidecar `apps.runtime.json`, and add an `overwatch apps apply <file>` CLI so deploy pipelines have a supported declarative write path.

**Architecture:** Per-app static config lives in `data/apps.d/<id>.json` (validated by a new static-only schema). Runtime state (`createdAt`/`updatedAt`) lives in `data/apps.runtime.json`. `readApps()` merges both at load time and returns the existing full `AppDefinition` shape; no consumer outside `services/app.ts` changes. A v3 schema migration runs under the existing pending-migration gate to split the legacy `apps.json` into the new layout. A new CLI dispatcher at `src/cli/apps.ts` exposes `apps apply <file|->` that calls a new `applyApp()` service function under the same `withFileLock('apps', …)` as the HTTP API.

**Tech Stack:** TypeScript, Node 22, Zod, Express, Vitest, pkg (yao-pkg).

**Spec:** `docs/superpowers/specs/2026-04-22-apps-d-cli-apply-design.md`

**File inventory:**

Create:
- `src/cli/apps.ts` — `apps apply` dispatcher
- `src/__tests__/apps-d.test.ts` — storage-layer tests
- `src/__tests__/cli-apps-apply.test.ts` — CLI end-to-end test

Modify:
- `src/models/app.ts` — add `AppDefinitionStaticSchema`, `AppRuntimeEntrySchema`, `AppRuntimeStoreSchema`, `ApplyResult` type
- `src/services/app.ts` — rewrite read/write paths, add `applyApp`
- `src/services/migration.ts` — add `runAppsV3Migration`
- `src/cli/migrate.ts` — call new migration in the v3+ loop
- `src/services/schemaVersions.ts` — bump `apps` to `3`
- `src/services/configSnapshots.ts` — capture `apps.d/` and `apps.runtime.json` instead of `apps.json`
- `src/middleware/audit.ts` — export `writeAuditEntry(entry)` helper
- `src/cli.ts` — add `case 'apps':`
- `src/cli/init.ts` — seed `apps.d/` + `apps.runtime.json` instead of `apps.json`
- `src/__tests__/sprint1.test.ts`, `src/__tests__/sprint3.test.ts`, `src/__tests__/sprint2.test.ts` — update fixtures that assume the old layout
- `package.json` — bump to `1.4.0`

---

## Task 1: Add static + runtime schemas to models/app.ts

**Files:**
- Modify: `src/models/app.ts` (append below existing `UpdateAppSchema`)
- Test: none (type-level change validated by Task 2 tests)

- [ ] **Step 1: Open `src/models/app.ts` and append the new schemas at the bottom of the file, before the `// TypeScript types` block.**

Append (directly after `UpdateAppSchema`, before the type exports):

```ts
// Static portion of an app definition — the shape persisted in data/apps.d/<id>.json.
// Everything in AppDefinitionSchema except the runtime timestamps.
export const AppDefinitionStaticSchema = AppDefinitionSchema.omit({
  createdAt: true,
  updatedAt: true,
});

// Runtime state for a single app — persisted as a value in data/apps.runtime.json.
export const AppRuntimeEntrySchema = z.object({
  createdAt: z.string(),
  updatedAt: z.string(),
});

// Runtime store: map of appId → runtime entry.
export const AppRuntimeStoreSchema = z.record(AppRuntimeEntrySchema);
```

- [ ] **Step 2: Extend the type exports (bottom of file) so callers can use the new types.**

Replace the `// TypeScript types` block with:

```ts
// TypeScript types
export type AppDefinition = z.infer<typeof AppDefinitionSchema>;
export type AppDefinitionStatic = z.infer<typeof AppDefinitionStaticSchema>;
export type AppRuntimeEntry = z.infer<typeof AppRuntimeEntrySchema>;
export type AppRuntimeStore = z.infer<typeof AppRuntimeStoreSchema>;
export type CreateAppInput = z.infer<typeof CreateAppSchema>;
export type UpdateAppInput = z.infer<typeof UpdateAppSchema>;
export type AppService = z.infer<typeof AppServiceSchema>;
export type AppRegistry = z.infer<typeof AppRegistrySchema>;
export type AppBackup = z.infer<typeof AppBackupSchema>;

export type ApplyResult = 'created' | 'updated' | 'noop';
```

- [ ] **Step 3: Type-check.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx tsc --noEmit`
Expected: PASS (no output, exit 0).

- [ ] **Step 4: Commit.**

```bash
git add src/models/app.ts
git commit -m "Add AppDefinitionStaticSchema, AppRuntimeEntrySchema for apps.d layout"
```

---

## Task 2: Write failing tests for the new apps.d/ read path

**Files:**
- Create: `src/__tests__/apps-d.test.ts`

- [ ] **Step 1: Create the test file with the read-path fixtures.**

Write `src/__tests__/apps-d.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test — expect it to fail because the service still uses the old layout.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx vitest run src/__tests__/apps-d.test.ts`
Expected: FAIL — tests report either "apps.json must be an array" (current error from readApps) or "ENOENT apps.d/kwoutr.json" depending on path.

- [ ] **Step 3: Commit the failing test.**

```bash
git add src/__tests__/apps-d.test.ts
git commit -m "Add failing tests for apps.d/ + apps.runtime.json read path"
```

---

## Task 3: Implement the new read path in services/app.ts

**Files:**
- Modify: `src/services/app.ts` (replace `readApps` + add runtime helpers; keep `saveApps` for now so other code still compiles)

- [ ] **Step 1: Open `src/services/app.ts` and replace the top of the file (imports + file-path helpers + `readApps` + `saveApps`) with the apps.d-aware version.**

Replace the block from line 1 through the end of `saveApps` (currently line 76) with:

```ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { getDataDir } from '../config';
import {
  AppDefinition,
  AppDefinitionSchema,
  AppDefinitionStaticSchema,
  AppRuntimeEntry,
  AppRuntimeStore,
  AppRuntimeStoreSchema,
  CreateAppInput,
  UpdateAppInput,
  ApplyResult,
} from '../models/app';
import { withFileLock } from './fileLock';
import { writeJsonAtomic, readJsonStrict } from '../utils/atomicJson';

const APPS_D_DIR = 'apps.d';
const RUNTIME_FILE = 'apps.runtime.json';
const TRASH_FILE = 'apps.trashed.json';

function getAppsDDir(): string {
  return path.join(getDataDir(), APPS_D_DIR);
}

function getStaticFile(id: string): string {
  return path.join(getAppsDDir(), `${id}.json`);
}

function getRuntimeFile(): string {
  return path.join(getDataDir(), RUNTIME_FILE);
}

function getTrashedAppsFile(): string {
  return path.join(getDataDir(), TRASH_FILE);
}

interface TrashedApp {
  app: AppDefinition;
  deletedAt: string;
  deletedBy: string;
  tenantCount: number;
}

async function readRuntimeStore(): Promise<AppRuntimeStore> {
  try {
    const raw = await readJsonStrict<unknown>(getRuntimeFile());
    const parsed = AppRuntimeStoreSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`apps.runtime.json failed validation: ${parsed.error.message}`);
    }
    return parsed.data;
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeRuntimeStore(store: AppRuntimeStore): Promise<void> {
  await writeJsonAtomic(getRuntimeFile(), store, { mode: 0o644 });
}

async function listStaticFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(getAppsDDir());
    return entries.filter(e => e.endsWith('.json')).sort();
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      await fs.mkdir(getAppsDDir(), { recursive: true });
      return [];
    }
    throw err;
  }
}

async function readApps(): Promise<AppDefinition[]> {
  const files = await listStaticFiles();
  const runtime = await readRuntimeStore();
  let runtimeDirty = false;
  const apps: AppDefinition[] = [];

  for (const filename of files) {
    const fullPath = path.join(getAppsDDir(), filename);
    let data: string;
    try {
      data = await fs.readFile(fullPath, 'utf-8');
    } catch (err: any) {
      throw new Error(`failed to read ${filename}: ${err?.message || err}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch (err: any) {
      throw new Error(`${filename} is not valid JSON (${err.message})`);
    }
    const parsed = AppDefinitionStaticSchema.safeParse(raw);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`${filename} failed validation: ${errors}`);
    }
    const staticDef = parsed.data;

    // File-name sanity: filename id must match the in-file id. Prevents renames
    // from silently producing two copies or mis-keyed runtime entries.
    const filenameId = filename.replace(/\.json$/, '');
    if (filenameId !== staticDef.id) {
      throw new Error(`${filename}: filename id '${filenameId}' does not match in-file id '${staticDef.id}'`);
    }

    let entry = runtime[staticDef.id];
    if (!entry) {
      const stat = await fs.stat(fullPath);
      const when = stat.mtime.toISOString();
      entry = { createdAt: when, updatedAt: when };
      runtime[staticDef.id] = entry;
      runtimeDirty = true;
    }
    apps.push({ ...staticDef, createdAt: entry.createdAt, updatedAt: entry.updatedAt });
  }

  if (runtimeDirty) {
    await writeRuntimeStore(runtime);
  }
  return apps;
}

async function writeStatic(appDef: AppDefinition): Promise<void> {
  const { createdAt, updatedAt, ...staticOnly } = appDef;
  void createdAt; void updatedAt;
  await writeJsonAtomic(getStaticFile(appDef.id), staticOnly, { mode: 0o644 });
}

async function removeStatic(id: string): Promise<void> {
  try {
    await fs.unlink(getStaticFile(id));
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function upsertRuntime(id: string, mutator: (prev: AppRuntimeEntry | undefined) => AppRuntimeEntry): Promise<AppRuntimeEntry> {
  const store = await readRuntimeStore();
  const next = mutator(store[id]);
  store[id] = next;
  await writeRuntimeStore(store);
  return next;
}

async function deleteRuntime(id: string): Promise<void> {
  const store = await readRuntimeStore();
  if (store[id]) {
    delete store[id];
    await writeRuntimeStore(store);
  }
}

async function readTrashed(): Promise<TrashedApp[]> {
  try {
    const raw = await readJsonStrict<unknown>(getTrashedAppsFile());
    if (!Array.isArray(raw)) return [];
    return raw as TrashedApp[];
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function saveTrashed(entries: TrashedApp[]): Promise<void> {
  await writeJsonAtomic(getTrashedAppsFile(), entries, { mode: 0o644 });
}
```

- [ ] **Step 2: Delete the leftover old `readApps`/`saveApps`/`getAppsFile` definitions.**

Scan the file for any remaining references to `getAppsFile()` and the old `readApps`/`saveApps` bodies and delete them. The `listApps`, `getApp`, `createApp`, `updateApp`, `deleteApp`, `listTrashedApps`, `restoreApp`, `purgeApp` functions below stay (Tasks 4-6 rewrite their bodies, but their exports are called from routes and must keep existing names).

- [ ] **Step 3: Temporarily stub the mutating functions so the file compiles.**

Replace the bodies of `createApp`, `updateApp`, `deleteApp`, `restoreApp`, `purgeApp` with `throw new Error('rewritten in next task')` — keep the exported signatures identical. `listApps` and `getApp` stay as they are (they only call `readApps`).

- [ ] **Step 4: Run the apps-d tests to confirm the read path passes.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx vitest run src/__tests__/apps-d.test.ts`
Expected: all 6 tests PASS.

- [ ] **Step 5: Type-check.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/services/app.ts
git commit -m "Implement apps.d/ + apps.runtime.json read path"
```

---

## Task 4: Write tests for `applyApp` (create / update / noop / trashed-conflict)

**Files:**
- Modify: `src/__tests__/apps-d.test.ts` (append new describe block)

- [ ] **Step 1: Append the applyApp tests to the bottom of `src/__tests__/apps-d.test.ts`.**

Append after the closing `});` of the existing `describe('readApps — ...')` block:

```ts
describe('applyApp — CLI upsert semantics', () => {
  it('creates a new app when none exists with that id', async () => {
    const { applyApp } = await import('../services/app');
    const result = await applyApp(validStatic('kwoutr'), 'cli:test');

    expect(result.result).toBe('created');
    expect(result.app.id).toBe('kwoutr');
    expect(result.app.createdAt).toBe(result.app.updatedAt);

    const files = await fs.readdir(path.join(dataDir, 'apps.d'));
    expect(files).toEqual(['kwoutr.json']);
  });

  it('updates an existing app and preserves createdAt', async () => {
    const { applyApp } = await import('../services/app');
    const first = await applyApp(validStatic('kwoutr'), 'cli:test');
    // Force a time gap so updatedAt would differ if bumped.
    await new Promise(r => setTimeout(r, 5));

    const modified = { ...validStatic('kwoutr'), domain_template: '*.kwoutr.io' };
    const second = await applyApp(modified, 'cli:test');

    expect(second.result).toBe('updated');
    expect(second.app.createdAt).toBe(first.app.createdAt);
    expect(second.app.updatedAt).not.toBe(first.app.updatedAt);
    expect(second.changedKeys).toContain('domain_template');
  });

  it('is a no-op when applying an unchanged file', async () => {
    const { applyApp } = await import('../services/app');
    const first = await applyApp(validStatic('kwoutr'), 'cli:test');
    await new Promise(r => setTimeout(r, 5));
    const second = await applyApp(validStatic('kwoutr'), 'cli:test');

    expect(second.result).toBe('noop');
    expect(second.app.updatedAt).toBe(first.app.updatedAt);
    expect(second.changedKeys).toEqual([]);
  });

  it('rejects when the id is in the trash', async () => {
    await fs.writeFile(path.join(dataDir, 'apps.trashed.json'), JSON.stringify([{
      app: { ...validStatic('kwoutr'), createdAt: 'x', updatedAt: 'x' },
      deletedAt: 'x', deletedBy: 'x', tenantCount: 0,
    }]));
    const { applyApp } = await import('../services/app');
    await expect(applyApp(validStatic('kwoutr'), 'cli:test')).rejects.toThrow(/in trash/);
  });

  it('rejects input that fails static schema validation', async () => {
    const { applyApp } = await import('../services/app');
    await expect(applyApp({ id: 'kwoutr' }, 'cli:test')).rejects.toThrow(/validation/);
  });

  it('rejects input that includes createdAt/updatedAt (static-only shape)', async () => {
    const { applyApp } = await import('../services/app');
    const withRuntime = { ...validStatic('kwoutr'), createdAt: 'x', updatedAt: 'x' };
    // Either the schema strips these silently OR rejects them. The test asserts
    // the runtime store is unaffected — the input must not be able to forge createdAt.
    const result = await applyApp(withRuntime, 'cli:test');
    expect(result.app.createdAt).not.toBe('x');
    expect(result.app.updatedAt).not.toBe('x');
  });
});
```

- [ ] **Step 2: Run tests — the applyApp tests must FAIL because the service function doesn't exist yet.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx vitest run src/__tests__/apps-d.test.ts`
Expected: 6 tests in `readApps` PASS, 6 tests in `applyApp` FAIL (applyApp is not exported).

- [ ] **Step 3: Commit.**

```bash
git add src/__tests__/apps-d.test.ts
git commit -m "Add failing tests for applyApp upsert semantics"
```

---

## Task 5: Implement `applyApp` and rewrite create/update/delete/restore

**Files:**
- Modify: `src/services/app.ts` (replace the stub bodies and add `applyApp`)

- [ ] **Step 1: Replace `createApp`, `updateApp`, `deleteApp`, `restoreApp`, `purgeApp` and add `applyApp`.**

Replace the entire block from `export async function createApp` to the end of the file with:

```ts
export async function listApps(): Promise<AppDefinition[]> {
  return readApps();
}

export async function getApp(id: string): Promise<AppDefinition | null> {
  const apps = await readApps();
  return apps.find(a => a.id === id) || null;
}

export async function createApp(input: CreateAppInput): Promise<AppDefinition> {
  return withFileLock('apps', async () => {
    const existing = await readApps();
    if (existing.find(a => a.id === input.id)) {
      throw new Error(`App '${input.id}' already exists`);
    }

    const now = new Date().toISOString();
    const app: AppDefinition = { ...input, createdAt: now, updatedAt: now };
    const parsed = AppDefinitionSchema.safeParse(app);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`Invalid app definition: ${errors}`);
    }

    await writeStatic(parsed.data);
    await upsertRuntime(parsed.data.id, () => ({ createdAt: now, updatedAt: now }));
    return parsed.data;
  });
}

export async function updateApp(input: UpdateAppInput): Promise<AppDefinition> {
  return withFileLock('apps', async () => {
    const apps = await readApps();
    const index = apps.findIndex(a => a.id === input.id);
    if (index === -1) {
      throw new Error(`App '${input.id}' not found`);
    }

    const now = new Date().toISOString();
    const updated: AppDefinition = { ...apps[index], ...input, updatedAt: now };
    const parsed = AppDefinitionSchema.safeParse(updated);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`Invalid app definition: ${errors}`);
    }

    await writeStatic(parsed.data);
    await upsertRuntime(parsed.data.id, prev => ({
      createdAt: prev?.createdAt ?? parsed.data.createdAt,
      updatedAt: now,
    }));
    return parsed.data;
  });
}

/**
 * Declarative upsert used by `overwatch apps apply <file>`.
 * - Validates against AppDefinitionStaticSchema (rejects forged createdAt/updatedAt).
 * - Errors if the id is currently soft-deleted in the trash.
 * - No-op (does not bump updatedAt) when the on-disk static file is deep-equal.
 */
export async function applyApp(
  input: unknown,
  _actor: string,
): Promise<{ result: ApplyResult; app: AppDefinition; changedKeys: string[] }> {
  return withFileLock('apps', async () => {
    const parsed = AppDefinitionStaticSchema.safeParse(input);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`Invalid app definition: ${errors}`);
    }
    const next = parsed.data;

    const trashed = await readTrashed();
    if (trashed.some(t => t.app.id === next.id)) {
      throw new Error(
        `App '${next.id}' is in trash. Restore with 'overwatch apps restore ${next.id}' ` +
        `or permanently remove with 'overwatch apps purge ${next.id}' before applying.`,
      );
    }

    const currentFile = getStaticFile(next.id);
    let prevRaw: string | null = null;
    try {
      prevRaw = await fs.readFile(currentFile, 'utf-8');
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }

    if (prevRaw) {
      // Compare canonical JSON (sorted keys) to avoid field-order false diffs.
      const prev = AppDefinitionStaticSchema.parse(JSON.parse(prevRaw));
      const changedKeys = diffKeys(prev, next);
      if (changedKeys.length === 0) {
        const runtime = await readRuntimeStore();
        const entry = runtime[next.id];
        if (!entry) {
          throw new Error(`apps.d/${next.id}.json exists but apps.runtime.json has no entry — state inconsistent`);
        }
        return {
          result: 'noop' as ApplyResult,
          app: { ...prev, createdAt: entry.createdAt, updatedAt: entry.updatedAt },
          changedKeys: [],
        };
      }
      const now = new Date().toISOString();
      await writeJsonAtomic(currentFile, next, { mode: 0o644 });
      const entry = await upsertRuntime(next.id, prevEntry => ({
        createdAt: prevEntry?.createdAt ?? now,
        updatedAt: now,
      }));
      return {
        result: 'updated' as ApplyResult,
        app: { ...next, createdAt: entry.createdAt, updatedAt: entry.updatedAt },
        changedKeys,
      };
    }

    // Create path.
    const now = new Date().toISOString();
    await writeJsonAtomic(currentFile, next, { mode: 0o644 });
    const entry = await upsertRuntime(next.id, () => ({ createdAt: now, updatedAt: now }));
    return {
      result: 'created' as ApplyResult,
      app: { ...next, createdAt: entry.createdAt, updatedAt: entry.updatedAt },
      changedKeys: Object.keys(next),
    };
  });
}

function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(k);
  }
  return changed.sort();
}

export async function deleteApp(id: string, force: boolean = false, deletedBy: string = 'unknown'): Promise<void> {
  return withFileLock('apps', async () => {
    const apps = await readApps();
    const victim = apps.find(a => a.id === id);
    if (!victim) {
      throw new Error(`App '${id}' not found`);
    }

    const { getAppsDir } = await import('../config/loader');
    const tenantDir = path.join(getAppsDir(), id, 'tenants');
    let tenantCount = 0;
    try {
      const entries = await fs.readdir(tenantDir);
      tenantCount = entries.filter(e => !e.startsWith('.')).length;
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }

    if (tenantCount > 0 && !force) {
      throw new Error(`App '${id}' has ${tenantCount} tenant(s). Delete all tenants first or use force=true.`);
    }

    if (tenantCount > 0) {
      const trashed = await readTrashed();
      trashed.push({ app: victim, deletedAt: new Date().toISOString(), deletedBy, tenantCount });
      await saveTrashed(trashed);
    }

    await removeStatic(id);
    await deleteRuntime(id);
  });
}

export async function listTrashedApps(): Promise<TrashedApp[]> {
  return readTrashed();
}

export async function restoreApp(id: string): Promise<AppDefinition> {
  return withFileLock('apps', async () => {
    const trashed = await readTrashed();
    const tIdx = trashed.findIndex(t => t.app.id === id);
    if (tIdx === -1) {
      throw new Error(`No trashed app with id '${id}' to restore`);
    }
    const apps = await readApps();
    if (apps.some(a => a.id === id)) {
      throw new Error(`Cannot restore '${id}': an app with that id already exists`);
    }
    const restored = trashed[tIdx].app;
    await writeStatic(restored);
    await upsertRuntime(restored.id, () => ({ createdAt: restored.createdAt, updatedAt: restored.updatedAt }));
    trashed.splice(tIdx, 1);
    await saveTrashed(trashed);
    return restored;
  });
}

export async function purgeApp(id: string): Promise<void> {
  return withFileLock('apps', async () => {
    const trashed = await readTrashed();
    const tIdx = trashed.findIndex(t => t.app.id === id);
    if (tIdx === -1) {
      throw new Error(`No trashed app with id '${id}' to purge`);
    }
    trashed.splice(tIdx, 1);
    await saveTrashed(trashed);
  });
}
```

- [ ] **Step 2: Run the apps-d tests — all 12 should pass.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx vitest run src/__tests__/apps-d.test.ts`
Expected: 12/12 PASS.

- [ ] **Step 3: Type-check.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/services/app.ts
git commit -m "Implement applyApp + port create/update/delete/restore to apps.d layout"
```

---

## Task 6: Update existing sprint tests that assume the old single-file layout

**Files:**
- Modify: `src/__tests__/sprint3.test.ts`
- Modify: `src/__tests__/sprint1.test.ts`
- Modify: `src/__tests__/sprint2.test.ts`

- [ ] **Step 1: Update `sprint3.test.ts` fixtures.**

In `src/__tests__/sprint3.test.ts`, find the `setupApp` helper (around line 68). Replace its body with a version that writes to `apps.d/` + `apps.runtime.json` instead of `apps.json`:

```ts
async function setupApp() {
  const dataDir = path.join(tmpRoot, 'data');
  const appsDir = path.join(tmpRoot, 'apps');
  await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
  await fs.mkdir(path.join(appsDir, 'kwoutr', 'tenants', 't1'), { recursive: true });
  const staticDef = {
    id: 'kwoutr',
    name: 'Kwoutr',
    domain_template: '*.kwoutr.com',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'a/b', auth: { type: 'token' } },
    services: [{ name: 'web' }],
    default_image_tag: 'latest',
  };
  await fs.writeFile(path.join(dataDir, 'apps.d', 'kwoutr.json'), JSON.stringify(staticDef));
  await fs.writeFile(path.join(dataDir, 'apps.runtime.json'), JSON.stringify({
    kwoutr: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  }));
  vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
  vi.doMock('../config/loader', () => ({ getAppsDir: () => appsDir }));
  vi.doMock('./fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
  return { dataDir, appsDir };
}
```

Then update the assertions in the same describe block that read `apps.json`:

Replace:
```ts
    const after = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.json'), 'utf-8'));
    expect(after).toHaveLength(1);
```
with:
```ts
    const after = await fs.readdir(path.join(dataDir, 'apps.d'));
    expect(after).toEqual(['kwoutr.json']);
```

Replace:
```ts
    const active = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.json'), 'utf-8'));
    expect(active).toHaveLength(0);
```
with:
```ts
    const active = await fs.readdir(path.join(dataDir, 'apps.d'));
    expect(active).toEqual([]);
```

Replace (there are two nearly-identical blocks, update both):
```ts
    const active = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.json'), 'utf-8'));
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('kwoutr');
```
with:
```ts
    const active = await fs.readdir(path.join(dataDir, 'apps.d'));
    expect(active).toEqual(['kwoutr.json']);
```

- [ ] **Step 2: Update `sprint1.test.ts`.**

In `src/__tests__/sprint1.test.ts`, find the two tests that write to `apps.json` directly (search for `apps.json` — there are assertions around malformed JSON and invalid entry at roughly lines 64-82). The old tests assert behavior of `readApps` on a malformed single file; the new behavior splits across per-file entries. Replace:

```ts
  it('throws a clear error when apps.json is malformed', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'apps.json'), '{not valid json');
```
with:
```ts
  it('throws a clear error when an apps.d/ file is malformed', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'apps.d', 'broken.json'), '{not valid json');
```

And:
```ts
  it('throws when apps.json has an invalid app entry (schema drift)', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'apps.json'), JSON.stringify([{ id: 'incomplete' }]));
```
with:
```ts
  it('throws when an apps.d/ file has an invalid app entry (schema drift)', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'apps.d', 'incomplete.json'), JSON.stringify({ id: 'incomplete' }));
```

Update the error-message assertions in those two tests to match the new strings:
- `apps.json is not valid JSON` → `broken.json is not valid JSON`
- `apps.json[0] failed validation` → `incomplete.json failed validation`

- [ ] **Step 3: Update `sprint2.test.ts`.**

Two classes of tests in `src/__tests__/sprint2.test.ts` reference `apps.json`:

- Tests in `describe('R1 writeJsonAtomic …')` (lines 19-41) use `apps.json` as an arbitrary target filename for a primitive-level test. These pass regardless of filename — **leave unchanged**.
- The `G2 configSnapshots` test at lines 94-114 explicitly round-trips `apps.json` through the snapshot service. After Task 13, `apps.json` is no longer in `FILES_TO_SNAPSHOT`. Replace that entire test with:

```ts
  it('create+list+restore round-trips apps.runtime.json and apps.d/', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'apps.runtime.json'), JSON.stringify({
      original: { createdAt: 'x', updatedAt: 'x' },
    }));
    await fs.writeFile(path.join(dataDir, 'apps.d', 'original.json'), JSON.stringify({ id: 'original' }));

    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    const { createSnapshot, listSnapshots, restoreSnapshot } = await import('../services/configSnapshots');

    const snap = await createSnapshot('test');
    expect(snap.files).toContain('apps.runtime.json');
    expect(snap.files).toContain('apps.d/');

    // Overwrite to simulate loss.
    await fs.writeFile(path.join(dataDir, 'apps.runtime.json'), JSON.stringify({}));
    await fs.rm(path.join(dataDir, 'apps.d', 'original.json'));

    const all = await listSnapshots();
    expect(all.length).toBeGreaterThan(0);

    await restoreSnapshot(snap.name);
    const runtime = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.runtime.json'), 'utf-8'));
    expect(runtime.original).toBeDefined();
    const appsD = await fs.readdir(path.join(dataDir, 'apps.d'));
    expect(appsD).toEqual(['original.json']);
  });
```

- [ ] **Step 4: Run all tests.**

- [ ] **Step 5: Run all tests.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx vitest run`
Expected: all tests PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/__tests__/sprint1.test.ts src/__tests__/sprint3.test.ts src/__tests__/sprint2.test.ts
git commit -m "Update sprint test fixtures for apps.d/ layout"
```

---

## Task 7: Export `writeAuditEntry` helper from middleware/audit.ts

**Files:**
- Modify: `src/middleware/audit.ts`

- [ ] **Step 1: Add an exported helper that takes a pre-built audit entry.**

Below the existing `enqueueAuditEntry` function (around line 48), add:

```ts
/**
 * Append a pre-built audit entry. For non-HTTP callers (CLI, background jobs)
 * that don't have a Request/Response pair. Caller is responsible for providing
 * all required fields; sanitisation of sensitive keys is still applied.
 */
export function writeAuditEntry(entry: Omit<AuditEntry, 'timestamp'> & { timestamp?: string }): void {
  const full: AuditEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    user: entry.user,
    action: entry.action,
    method: entry.method,
    path: entry.path,
    query: entry.query,
    body: sanitizeBody(entry.body),
    status: entry.status,
    ip: entry.ip,
    ...(entry.force ? { force: true } : {}),
  };
  enqueueAuditEntry(full);
}
```

- [ ] **Step 2: Type-check.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add src/middleware/audit.ts
git commit -m "Export writeAuditEntry helper for non-HTTP audit producers"
```

---

## Task 8: Add the `apps apply` CLI dispatcher

**Files:**
- Create: `src/cli/apps.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Create `src/cli/apps.ts`.**

Write `src/cli/apps.ts`:

```ts
import * as fs from 'fs/promises';
import * as os from 'os';
import { applyApp } from '../services/app';
import { writeAuditEntry, flushAuditLog } from '../middleware/audit';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const NC = '\x1b[0m';

function usage(): void {
  console.log('');
  console.log(`  ${BOLD}Overwatch Apps${NC}`);
  console.log('');
  console.log('  Usage: overwatch apps <subcommand> [args]');
  console.log('');
  console.log('  Subcommands:');
  console.log('    apply <file|->   Upsert an app definition from a JSON file (or stdin with "-")');
  console.log('');
}

async function readInput(arg: string): Promise<string> {
  if (arg === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf-8');
  }
  return fs.readFile(arg, 'utf-8');
}

function currentOsUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}

async function runApply(args: string[]): Promise<void> {
  const fileArg = args[0];
  if (!fileArg || fileArg === '--help' || fileArg === '-h') {
    usage();
    process.exit(fileArg ? 0 : 2);
  }

  let raw: string;
  try {
    raw = await readInput(fileArg);
  } catch (err: any) {
    console.error(`${RED}I/O error:${NC} ${err?.message || err}`);
    process.exit(3);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    console.error(`${RED}Invalid JSON:${NC} ${err?.message || err}`);
    process.exit(2);
  }

  const actor = `cli:${currentOsUser()}`;
  try {
    const { result, app, changedKeys } = await applyApp(parsed, actor);
    writeAuditEntry({
      user: actor,
      action: `apps.apply ${app.id}`,
      method: 'CLI',
      path: '/cli/apps/apply',
      body: { appId: app.id, result, changedKeys },
      status: 0,
      ip: 'local',
    });
    await flushAuditLog();
    const detail = result === 'updated' && changedKeys.length > 0 ? ` (changed: ${changedKeys.join(', ')})` : '';
    const colour = result === 'noop' ? YELLOW : GREEN;
    console.log(`${colour}apps.apply${NC} ${app.id} ${BOLD}${result}${NC}${detail}`);
  } catch (err: any) {
    console.error(`${RED}apps.apply failed:${NC} ${err?.message || err}`);
    process.exit(2);
  }
}

export async function runApps(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === '--help' || sub === '-h') {
    usage();
    return;
  }

  if (sub === 'apply') {
    await runApply(rest);
    return;
  }

  console.error(`${RED}Unknown apps subcommand:${NC} ${sub}`);
  usage();
  process.exit(1);
}
```

- [ ] **Step 2: Wire it into `src/cli.ts`.**

In `src/cli.ts`, add the import at the top alongside the other `runX` imports:

```ts
import { runApps } from './cli/apps';
```

And add the case in the switch block immediately after the `case 'admins':` block:

```ts
  case 'apps':
    run(runApps);
    break;
```

Also insert one line in the help text block. Find this line (currently line 90):

```ts
    console.log('    admins                  List, add, or remove admin users');
```

Insert immediately after it:

```ts
    console.log('    apps <sub>              Manage app definitions (apply from file)');
```

- [ ] **Step 3: Type-check.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Smoke-test the CLI help output.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine sh -c 'npx tsx src/cli.ts apps --help'`
Expected: prints the usage block from `cli/apps.ts` and exits 0.

- [ ] **Step 5: Commit.**

```bash
git add src/cli/apps.ts src/cli.ts
git commit -m "Add 'overwatch apps apply' CLI subcommand"
```

---

## Task 9: Add CLI end-to-end test

**Files:**
- Create: `src/__tests__/cli-apps-apply.test.ts`

- [ ] **Step 1: Write the E2E test.**

Write `src/__tests__/cli-apps-apply.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;
let dataDir: string;
let configPath: string;

const cliEntry = path.resolve(__dirname, '..', 'cli.ts');

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

function runCli(args: string[], stdin?: string) {
  return spawnSync('npx', ['tsx', cliEntry, ...args], {
    input: stdin,
    encoding: 'utf-8',
    env: { ...process.env, OVERWATCH_CONFIG: configPath, FORCE_COLOR: '0' },
  });
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-cli-'));
  dataDir = path.join(tmpRoot, 'data');
  await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
  configPath = path.join(tmpRoot, 'overwatch.yaml');
  await fs.writeFile(configPath, `
project:
  name: "Test"
  prefix: "test"
database:
  type: "mariadb"
  host: "h"
  port: 3306
  root_user: "root"
  root_password_env: "MYSQL_ROOT_PASSWORD"
  container_name: "c"
networking:
  external_network: "test-network"
  apps_path: "${path.join(tmpRoot, 'apps')}"
data_dir: "${dataDir}"
`);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('overwatch apps apply — end-to-end', () => {
  it('creates an app from a file', async () => {
    const appFile = path.join(tmpRoot, 'kwoutr.json');
    await fs.writeFile(appFile, JSON.stringify(validStatic('kwoutr')));

    const proc = runCli(['apps', 'apply', appFile]);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toMatch(/kwoutr created/);

    const onDisk = await fs.readFile(path.join(dataDir, 'apps.d', 'kwoutr.json'), 'utf-8');
    expect(JSON.parse(onDisk).id).toBe('kwoutr');
  });

  it('reads from stdin with "-"', async () => {
    const proc = runCli(['apps', 'apply', '-'], JSON.stringify(validStatic('goalmaster')));
    expect(proc.status).toBe(0);
    expect(proc.stdout).toMatch(/goalmaster created/);
  });

  it('is idempotent — second apply reports noop', async () => {
    const appFile = path.join(tmpRoot, 'kwoutr.json');
    await fs.writeFile(appFile, JSON.stringify(validStatic('kwoutr')));
    runCli(['apps', 'apply', appFile]);
    const proc = runCli(['apps', 'apply', appFile]);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toMatch(/kwoutr noop/);
  });

  it('writes an audit.log entry', async () => {
    const appFile = path.join(tmpRoot, 'kwoutr.json');
    await fs.writeFile(appFile, JSON.stringify(validStatic('kwoutr')));
    runCli(['apps', 'apply', appFile]);

    const audit = await fs.readFile(path.join(dataDir, 'audit.log'), 'utf-8');
    const lines = audit.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.action).toMatch(/apps\.apply kwoutr/);
    expect(last.user).toMatch(/^cli:/);
  });

  it('exits 2 on invalid JSON', async () => {
    const appFile = path.join(tmpRoot, 'broken.json');
    await fs.writeFile(appFile, '{not valid');
    const proc = runCli(['apps', 'apply', appFile]);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toMatch(/Invalid JSON/);
  });

  it('exits 2 when the app is in the trash', async () => {
    await fs.writeFile(path.join(dataDir, 'apps.trashed.json'), JSON.stringify([{
      app: { ...validStatic('kwoutr'), createdAt: 'x', updatedAt: 'x' },
      deletedAt: 'x', deletedBy: 'x', tenantCount: 0,
    }]));
    const appFile = path.join(tmpRoot, 'kwoutr.json');
    await fs.writeFile(appFile, JSON.stringify(validStatic('kwoutr')));
    const proc = runCli(['apps', 'apply', appFile]);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toMatch(/in trash/);
  });
});
```

- [ ] **Step 2: Run the CLI tests.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine sh -c 'npx vitest run src/__tests__/cli-apps-apply.test.ts'`
Expected: 6/6 PASS. If any fail because of config-loader path resolution, inspect `src/config/loader.ts` to confirm `OVERWATCH_CONFIG` env var is honoured — if not, switch the test to `cwd: tmpRoot` and drop a named `overwatch.yaml` in `tmpRoot`.

- [ ] **Step 3: Commit.**

```bash
git add src/__tests__/cli-apps-apply.test.ts
git commit -m "Add end-to-end test for overwatch apps apply"
```

---

## Task 10: Implement the v3 schema migration

**Files:**
- Modify: `src/services/migration.ts` (append new function)

- [ ] **Step 1: Append the migration at the bottom of `src/services/migration.ts`.**

Append:

```ts
/**
 * Migrate apps schema v2 → v3: split the single data/apps.json array into
 * per-app static files in data/apps.d/ plus a data/apps.runtime.json sidecar.
 * Idempotent: if apps.d/ already contains files, exits without touching anything.
 */
export async function runAppsV3Migration(): Promise<void> {
  const { getDataDir } = await import('../config');
  const dataDir = getDataDir();
  const legacyPath = path.join(dataDir, 'apps.json');
  const appsDDir = path.join(dataDir, 'apps.d');
  const runtimePath = path.join(dataDir, 'apps.runtime.json');
  const backupPath = path.join(dataDir, 'apps.json.pre-apps.d');

  // Idempotency: already migrated if apps.d/ has files.
  try {
    const entries = await fs.readdir(appsDDir);
    if (entries.filter(e => e.endsWith('.json')).length > 0) {
      console.log('[migrate] apps.d/ already populated — skipping v3 migration');
      return;
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }

  // Fresh install path: no legacy file AND empty apps.d/.
  let legacyRaw: string;
  try {
    legacyRaw = await fs.readFile(legacyPath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      await fs.mkdir(appsDDir, { recursive: true });
      await fs.writeFile(runtimePath, '{}\n', { mode: 0o644 });
      console.log('[migrate] apps v2→v3: fresh install — created empty apps.d/ and apps.runtime.json');
      return;
    }
    throw err;
  }

  let legacyApps: any[];
  try {
    legacyApps = JSON.parse(legacyRaw);
  } catch (err: any) {
    throw new Error(`apps v2→v3 migration: apps.json is not valid JSON (${err.message}). Fix or restore before running.`);
  }
  if (!Array.isArray(legacyApps)) {
    throw new Error(`apps v2→v3 migration: apps.json must be an array; got ${typeof legacyApps}.`);
  }

  await fs.mkdir(appsDDir, { recursive: true });
  const runtimeStore: Record<string, { createdAt: string; updatedAt: string }> = {};

  for (const app of legacyApps) {
    if (!app || typeof app !== 'object' || typeof app.id !== 'string') {
      throw new Error(`apps v2→v3 migration: entry without a string 'id' field: ${JSON.stringify(app).slice(0, 120)}`);
    }
    const { createdAt, updatedAt, ...staticDef } = app;
    // Preserve any timestamp present; synthesize from 'now' if missing so we
    // don't fail validation later. The migration runs once; this is the best
    // historical record we can offer for entries that lacked timestamps.
    const now = new Date().toISOString();
    runtimeStore[app.id] = {
      createdAt: typeof createdAt === 'string' ? createdAt : now,
      updatedAt: typeof updatedAt === 'string' ? updatedAt : now,
    };
    await writeJsonAtomic(path.join(appsDDir, `${app.id}.json`), staticDef, { mode: 0o644 });
  }

  await writeJsonAtomic(runtimePath, runtimeStore, { mode: 0o644 });
  await fs.rename(legacyPath, backupPath);
  console.log(`[migrate] apps v2→v3: split ${legacyApps.length} app(s) into apps.d/; legacy backup at ${backupPath}`);
}
```

`writeJsonAtomic` and `path`, `fs` imports are already at the top of `migration.ts`; no new imports needed.

- [ ] **Step 2: Type-check.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add src/services/migration.ts
git commit -m "Add apps v2->v3 migration: split apps.json into apps.d/ + runtime"
```

---

## Task 11: Test the v3 migration

**Files:**
- Modify: `src/__tests__/apps-d.test.ts` (append a migration describe block)

- [ ] **Step 1: Append migration tests.**

Append at the bottom of `src/__tests__/apps-d.test.ts`:

```ts
describe('runAppsV3Migration', () => {
  it('splits a legacy apps.json with 3 apps into apps.d/ + apps.runtime.json', async () => {
    const legacy = [
      { ...validStatic('kwoutr'), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
      { ...validStatic('goalmaster'), createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-02T00:00:00Z' },
      { ...validStatic('finalio'), createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-02T00:00:00Z' },
    ];
    await fs.writeFile(path.join(dataDir, 'apps.json'), JSON.stringify(legacy));

    const { runAppsV3Migration } = await import('../services/migration');
    await runAppsV3Migration();

    const files = (await fs.readdir(path.join(dataDir, 'apps.d'))).sort();
    expect(files).toEqual(['finalio.json', 'goalmaster.json', 'kwoutr.json']);

    const runtime = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.runtime.json'), 'utf-8'));
    expect(runtime.kwoutr.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(runtime.goalmaster.updatedAt).toBe('2026-02-02T00:00:00Z');

    // Legacy file renamed to backup.
    await expect(fs.access(path.join(dataDir, 'apps.json'))).rejects.toThrow();
    await expect(fs.access(path.join(dataDir, 'apps.json.pre-apps.d'))).resolves.toBeUndefined();
  });

  it('is idempotent — running a second time is a no-op', async () => {
    const legacy = [{ ...validStatic('kwoutr'), createdAt: 'x', updatedAt: 'x' }];
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
```

- [ ] **Step 2: Run the migration tests.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx vitest run src/__tests__/apps-d.test.ts`
Expected: 15 tests PASS (12 from before + 3 new).

- [ ] **Step 3: Commit.**

```bash
git add src/__tests__/apps-d.test.ts
git commit -m "Test apps v2->v3 migration: split, idempotency, fresh install"
```

---

## Task 12: Wire the v3 migration into `cli/migrate.ts` and bump schema version

**Files:**
- Modify: `src/services/schemaVersions.ts`
- Modify: `src/cli/migrate.ts`

- [ ] **Step 1: Bump the apps version target.**

In `src/services/schemaVersions.ts`, change:

```ts
export const CURRENT_SCHEMA_VERSIONS: SchemaVersions = {
  apps: 2,
  envVars: 2,
  tenantOverrides: 2,
  adminUsers: 1,
};
```

to:

```ts
export const CURRENT_SCHEMA_VERSIONS: SchemaVersions = {
  apps: 3,
  envVars: 2,
  tenantOverrides: 2,
  adminUsers: 1,
};
```

- [ ] **Step 2: Wire the migration into `src/cli/migrate.ts`.**

Replace the `// v3+ migrations will register here. For now, no-op but commit version bumps.` block (roughly lines 60-67) with:

```ts
    if (pending.length > 0) {
      for (const { store, from, to } of pending) {
        if (store === 'apps' && from < 3 && to >= 3) {
          console.log(`${DIM}[migrate]${NC} apps: v${from} → v${to} running...`);
          const { runAppsV3Migration } = await import('../services/migration');
          await runAppsV3Migration();
        } else {
          console.log(`${DIM}[migrate]${NC} ${store}: v${from} → v${to} (no transform required)`);
        }
      }
      await writeSchemaVersions(CURRENT_SCHEMA_VERSIONS);
      ranSomething = true;
    }
```

- [ ] **Step 3: Type-check.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run all tests.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx vitest run`
Expected: all tests PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/services/schemaVersions.ts src/cli/migrate.ts
git commit -m "Bump apps schema to v3 and wire runAppsV3Migration into migrate CLI"
```

---

## Task 13: Update `configSnapshots.ts` to capture the new layout

**Files:**
- Modify: `src/services/configSnapshots.ts`

- [ ] **Step 1: Extend the snapshot file list and add directory handling.**

Replace the `FILES_TO_SNAPSHOT` constant (line 6-13) with:

```ts
const FILES_TO_SNAPSHOT = [
  'apps.runtime.json',
  'apps.trashed.json',
  'env-vars.json',
  'tenant-env-overrides.json',
  'admin-users.json',
  'audit.log',
  '.schema-versions.json',
];

// Directories captured recursively — each becomes a subdir inside the snapshot.
const DIRS_TO_SNAPSHOT = [
  'apps.d',
];
```

Add a helper for recursive dir copy below `isoStamp` (around line 29):

```ts
async function copyDir(src: string, dest: string): Promise<number> {
  let bytes = 0;
  try {
    await fs.access(src);
  } catch {
    return 0;
  }
  await fs.mkdir(dest, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      bytes += await copyDir(from, to);
    } else if (entry.isFile()) {
      const stat = await fs.stat(from);
      await fs.copyFile(from, to);
      await fs.chmod(to, stat.mode & 0o777);
      bytes += stat.size;
    }
  }
  return bytes;
}
```

Inside `createSnapshot`, right after the `for (const file of FILES_TO_SNAPSHOT)` loop, add:

```ts
  for (const dir of DIRS_TO_SNAPSHOT) {
    const src = path.join(dataDir, dir);
    try {
      await fs.access(src);
    } catch {
      continue;
    }
    const bytes = await copyDir(src, path.join(dest, dir));
    if (bytes > 0) {
      files.push(dir + '/');
      totalBytes += bytes;
    }
  }
```

Inside `restoreSnapshot`, after the existing file-copy loop, add:

```ts
  for (const dir of DIRS_TO_SNAPSHOT) {
    const candidate = path.join(src, dir);
    try {
      await fs.access(candidate);
    } catch {
      continue;
    }
    // Wipe destination dir then copy fresh — matches the "last snapshot wins" semantics.
    const destDir = path.join(dataDir, dir);
    await fs.rm(destDir, { recursive: true, force: true });
    await copyDir(candidate, destDir);
  }
```

- [ ] **Step 2: Run existing snapshot tests.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx vitest run src/__tests__/sprint2.test.ts`
Expected: existing tests PASS. If the test `expect(siblings).toEqual(['apps.json'])` or similar asserted on the old list, update to `['apps.runtime.json']` in the test.

- [ ] **Step 3: Commit.**

```bash
git add src/services/configSnapshots.ts src/__tests__/sprint2.test.ts
git commit -m "Snapshot apps.d/ recursively + apps.runtime.json; drop legacy apps.json"
```

---

## Task 14: Update `cli/init.ts` for fresh-install seeding

**Files:**
- Modify: `src/cli/init.ts`

- [ ] **Step 1: Replace the apps.json seed.**

`src/cli/init.ts` imports `fs` as `import * as fs from 'fs'` (sync), so the replacement uses sync APIs to stay consistent with the rest of the file.

Find the block writing `apps.json` (around line 639-642 per earlier reads):

```ts
  await writeFileSafe(
    path.join(base, 'overwatch', 'data', 'apps.json'),
    '[]\n',
  );
```

Replace with:

```ts
  const dataDir = path.join(base, 'overwatch', 'data');
  if (!fs.existsSync(path.join(dataDir, 'apps.d'))) {
    fs.mkdirSync(path.join(dataDir, 'apps.d'), { recursive: true });
  }
  await writeFileSafe(
    path.join(dataDir, 'apps.runtime.json'),
    '{}\n',
  );
```

- [ ] **Step 2: Type-check.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add src/cli/init.ts
git commit -m "init: seed apps.d/ + apps.runtime.json instead of apps.json"
```

---

## Task 15: Bump package version and run the full suite

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version.**

In `package.json`, change `"version": "1.3.18"` to `"version": "1.4.0"`.

- [ ] **Step 2: Run the full test suite.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx vitest run`
Expected: ALL tests PASS.

- [ ] **Step 3: Type-check.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Build the binary to confirm pkg packaging still works.**

Run: `docker run --rm -v "$(pwd)":/app -w /app node:22-alpine sh -c 'npm run build'`
Expected: build completes without errors (tsc compiles `src/` → `dist/`).

- [ ] **Step 5: Commit.**

```bash
git add package.json
git commit -m "Bump version to 1.4.0"
```

- [ ] **Step 6: Tag the release.**

```bash
git tag v1.4.0
```

Do NOT push the tag yet — operator must verify production upgrade plan first (stop container, run `overwatch migrate up` to execute the v3 migration, start container).

---

## Post-implementation checklist

- [ ] Confirm `docker-compose` image for Overwatch rebuilds cleanly in CI.
- [ ] Document the upgrade procedure in `docs/updating.md`: stop overwatch → run `overwatch migrate up` on the host as the deploy user (the pkg'd binary with `getDataDir()` resolving via `OVERWATCH_CONFIG` or cwd heuristic) → start overwatch. Note: `OVERWATCH_AUTO_MIGRATE=1` only gates the boot refuse-to-start behavior; it does NOT actually execute migrations. The explicit CLI step is required.
- [ ] In a separate PR on the Kwoutr repo, add a step to `build-and-push.yml`'s `deploy-infrastructure` job that runs `ssh deploy@host 'overwatch apps apply <path>'` with `deploy/overwatch/apps/kwoutr.json` (adjust paths to match Kwoutr's repo layout). Do NOT reintroduce any direct write of `apps.d/kwoutr.json`.
