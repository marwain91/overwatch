# apps.d/ storage + `overwatch apps apply` CLI

Date: 2026-04-22
Status: design approved, awaiting implementation plan
Target version: v1.4.0

## Background

On 2026-04-22 production lost two of three registered apps (GoalMaster,
Finalio) from Overwatch's `apps.json`. Root cause was the Kwoutr repo's
`build-and-push.yml` pipeline rsyncing its own `deploy/overwatch/data/apps.json`
(a Kwoutr-only seed) over the multi-app runtime file on every push to main.
The rsync step has been removed from the Kwoutr pipeline as a stopgap; this
spec is the structural fix so the class of bug is impossible going forward.

The core design flaw being fixed: `apps.json` is a single file holding
entries for every registered app, but each app lives in its own repo and
each repo's pipeline wants to manage its own entry. Any write path that
serializes the whole list — whether rsync, a naive "seed" mechanism, or a
future per-app deploy script — will stomp entries it doesn't know about.

## Goals

1. Make it impossible for one app's pipeline to affect another app's
   registration, **by construction** (file-level isolation).
2. Give pipelines a supported, declarative way to register/update their app
   — replacing the current "write the data file directly" anti-pattern.
3. Preserve the existing HTTP API behavior for the Overwatch UI (admins can
   still create/edit/delete apps through the UI).
4. Preserve audit trail for all mutations.

## Non-goals

- No change to tenant storage or `env-vars.json` layout.
- No new remote API token system; the CLI runs on the server.
- No Kubernetes-style prune / `--all` apply. Apply takes one file, acts on
  one app. Bootstrap from multiple files is `for f in *.json; do apply $f; done`.
- No change to how UI edits persist beyond the new storage layout.

## Storage layout

Current:

```
data/
  apps.json              # array of full AppDefinition
  apps.trashed.json      # soft-deleted entries
```

After:

```
data/
  apps.d/
    kwoutr.json          # static definition, per-app — file-level isolation
    goalmaster.json
    finalio.json
  apps.runtime.json      # { [id]: { createdAt, updatedAt } }
  apps.trashed.json      # unchanged (full AppDefinition inside)
  apps.json.pre-apps.d   # one-time backup of pre-migration file
```

Per-file ownership boundary: a writer touching `apps.d/kwoutr.json` cannot
affect `apps.d/goalmaster.json`. The CLI enforces "one file per invocation";
the HTTP API writes only to the `<id>.json` matching the app being edited.

## Schemas

Two new schemas in `src/models/app.ts`, plus the existing `AppDefinitionSchema`
kept for the merged view consumed by route handlers:

```ts
// Static portion — persisted in apps.d/<id>.json.
export const AppDefinitionStaticSchema = AppDefinitionSchema.omit({
  createdAt: true,
  updatedAt: true,
});

// Runtime portion — persisted in apps.runtime.json.
export const AppRuntimeEntrySchema = z.object({
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const AppRuntimeStoreSchema = z.record(AppRuntimeEntrySchema);
```

`AppDefinitionSchema` itself is unchanged — it remains the shape handed to
the rest of the codebase. It is only reconstructed in memory by merging the
static file with the runtime entry.

Schema versions (`src/services/schemaVersions.ts`):
`apps: 2 → 3`. Migration runs under the existing pending-migration gate
(`OVERWATCH_AUTO_MIGRATE=1` or explicit `overwatch migrate up`).

## Read path

`readApps()` in `src/services/app.ts` is rewritten:

1. Under `withFileLock('apps', …)`, read all `apps.d/*.json` entries
   (stable sort by id for deterministic ordering).
2. Parse each with `AppDefinitionStaticSchema` — any entry failure throws,
   same "fail loudly on drift" behavior as today.
3. Read `apps.runtime.json`. For each static entry:
   - If runtime entry exists → merge as `{...static, ...runtime}` into
     `AppDefinitionSchema`.
   - If runtime entry missing (hand-dropped file, or recovery scenario) →
     synthesize `{ createdAt: <file mtime>, updatedAt: <file mtime> }`,
     persist it back to `apps.runtime.json`, and continue. The file mtime
     is a reasonable historical marker; "now" would incorrectly present
     the app as freshly created.
4. Return the array.

Consumers of `readApps()` / `listApps()` / `getApp()` do not change. They
still receive full `AppDefinition` objects.

## Write paths

### CLI `overwatch apps apply`

Shape: `overwatch apps apply <file|->`. Exactly one static-definition JSON
object on stdin or in the given file.

Behavior under `withFileLock('apps', …)`:

1. Parse input → validate with `AppDefinitionStaticSchema`.
2. If `id` present in `apps.trashed.json` → exit code 2 with message
   instructing `overwatch apps restore <id>` or `overwatch apps purge <id>`.
3. Read current `apps.d/<id>.json` if it exists.
   - If deep-equal to input → no write, result = `noop`, `updatedAt` not
     bumped. (True idempotency — pipelines that re-apply on every push
     don't churn `updatedAt` for free.)
   - Otherwise → `writeJsonAtomic(apps.d/<id>.json)`, result = `created`
     or `updated`.
4. Update `apps.runtime.json`:
   - On `created`: insert `{ createdAt: now, updatedAt: now }`.
   - On `updated`: preserve `createdAt`, set `updatedAt = now`.
   - On `noop`: no change.
5. Write one audit entry (see Audit section).
6. Print one-line result to stdout, exit 0.

Stdout formats:
```
apps.apply kwoutr created
apps.apply kwoutr updated (changed: services, backup)
apps.apply kwoutr noop
```

### HTTP API (existing `createApp`, `updateApp`, `deleteApp`)

These continue to exist and keep their route contracts. Internals change to
operate on the new layout:

- `createApp(input)`: `writeJsonAtomic(apps.d/<id>.json)` with the static
  subset; inserts runtime entry with `createdAt = updatedAt = now`. Fails
  if the static file already exists (same "already exists" semantics as
  today).
- `updateApp(input)`: reads current static file, merges with partial input,
  writes back; bumps runtime `updatedAt`. Fails if no static file exists.
- `deleteApp(id, force)`: reads static + runtime, assembles the full
  `AppDefinition`, appends to `apps.trashed.json`, removes `apps.d/<id>.json`
  and the runtime entry. Tenant-count guard and force/soft semantics are
  unchanged from current code.
- `restoreApp(id)`: pops from trash, writes `apps.d/<id>.json` (static) and
  a new runtime entry (preserving the trashed entry's original timestamps).
- `purgeApp(id)`: unchanged (removes from trash only).

All paths hold `withFileLock('apps', …)` for the read-modify-write window.

## Migration (apps v2 → v3)

In `src/services/migration.ts` (new function, registered with the existing
pending-migration machinery):

1. Under `withFileLock('apps', …)`, read legacy `apps.json` as an array of
   full `AppDefinition`.
2. For each entry:
   - Split into `static` (everything except `createdAt`/`updatedAt`) and
     `runtime` (those two).
   - `writeJsonAtomic(apps.d/<id>.json, static)`.
   - Accumulate `{ [id]: runtime }` into a single object.
3. `writeJsonAtomic(apps.runtime.json, runtimeStore)`.
4. Rename legacy `apps.json` to `apps.json.pre-apps.d` (atomic rename in
   same directory).
5. Bump `.schema-versions.json` apps field to `3`.
6. Migration is idempotent: re-running detects `apps` already at `3` and
   no-ops.

Rollback: operator can restore legacy by stopping Overwatch, renaming
`apps.json.pre-apps.d` → `apps.json`, deleting `apps.d/` and
`apps.runtime.json`, and resetting `apps` in `schema-versions.json` to `2`.
This is documented in the migration's log output, not automated.

## Audit

Both the CLI and the HTTP API write to `audit.log` via a single helper.

In `src/middleware/audit.ts`, extract the in-request `writeAuditEntry(entry)`
helper so non-HTTP callers can use it. Entry shape unchanged from today:
`{ timestamp, user, action, method?, path?, body?, status?, ip? }`.

CLI-originated entries:
- `user: "cli:<os-user>"` (e.g. `cli:deploy`)
- `action: "apps.apply"`
- `body: { appId, result, diff: [changedKeys] | null }`

This gives a single audit stream regardless of whether a change came from
the UI, the API directly, or a pipeline-invoked CLI.

## CLI integration

- New file `src/cli/apps.ts` — dispatcher for `overwatch apps <subcommand>`.
  Initially implements only `apply`. Structured so `apps list`, `apps delete`,
  `apps restore` can be added later without restructuring.
- `src/cli.ts` — add one `case 'apps':` branch to the top-level switch,
  delegating to `src/cli/apps.ts`.
- `src/services/app.ts` — add `applyApp(input, actor)` returning
  `{ result: 'created' | 'updated' | 'noop', app: AppDefinition, changedKeys: string[] }`.
  Reused by the CLI; not exposed over HTTP for now.

## Fresh-install behavior (`overwatch init`)

`src/cli/init.ts` currently writes a seed `apps.json` as `[]`. Updated to
write:

- An empty `apps.d/` directory (just `mkdir`).
- `apps.runtime.json` as `{}`.
- No legacy `apps.json` at all — `readApps()` on an empty `apps.d/` returns
  `[]` naturally.

No migration runs on fresh installs (nothing to migrate).

## Config snapshots

`src/services/configSnapshots.ts` currently lists `apps.json` in the files
it captures for daily/boot snapshots. The list is updated to cover the new
layout:

- Replace `apps.json` with `apps.runtime.json`.
- Add the entire `apps.d/` directory (recursive copy, same tree depth).
- `apps.trashed.json` stays in the list (unchanged).

Snapshot restore logic must know how to write back a directory, not just
individual files. If this requires a small extension to the snapshot
format, document it in the snapshot file's own `snapshot.json` manifest so
older Overwatch binaries refuse to restore newer-format snapshots loudly
(same principle as schema-versions gating).

## Error handling and exit codes (CLI)

| Code | Meaning                                                          |
|------|------------------------------------------------------------------|
| 0    | Success (including noop)                                         |
| 1    | Generic / unexpected error                                       |
| 2    | Input validation error (bad shape, missing required, trashed id) |
| 3    | I/O error (lock timeout, disk)                                   |
| 4    | Config not found / can't resolve data dir                        |

Messages go to stderr for errors, stdout for success/noop. No ANSI colors
when stdout is not a TTY (match existing CLI convention from `src/cli/init.ts`).

## Testing

Add `src/__tests__/apps-d.test.ts`:

- `readApps` with a mixed fixture (apps.d/ + apps.runtime.json) returns
  merged `AppDefinition[]`.
- `readApps` synthesizes runtime entries for hand-dropped static files and
  persists them.
- `applyApp` cases: create, update (preserves createdAt), noop (no
  `updatedAt` bump), trashed-id conflict, invalid-shape.
- Migration: legacy single-file → new layout; idempotent second run.
- Concurrency: two `applyApp` invocations for different ids run without
  corrupting either file (use the existing file-lock contention test
  pattern).
- `createApp` / `updateApp` / `deleteApp` / `restoreApp` still behave per
  their current route contracts (update existing tests if they asserted on
  the old `apps.json` shape).

Add `src/__tests__/cli-apps-apply.test.ts`:

- Spawn the compiled CLI against a fixture `data/` dir; assert exit codes,
  stdout lines, and on-disk state.

## Open questions (tracked, not blocking this spec)

- Should `overwatch apps apply -` accept YAML as well as JSON? Not in this
  spec; keep JSON to avoid a YAML parser dep on the CLI side. Can be added
  later without breaking change.
- Should the CLI support `--dry-run`? Nice-to-have; defer to follow-up.
- Should `apps.d/<id>.json` files carry a top-level `$schema` URL for
  editor support? Defer — adding it later is additive.

## Out of scope

- No change to tenant storage, env-vars, overrides.
- No change to the Kwoutr repo. The stopgap (removing the rsync) already
  shipped. Adopting the new CLI in Kwoutr's pipeline is a follow-up in that
  repo's own PR.
- No deprecation of `apps.json` as a concept name in docs — just as a file.
