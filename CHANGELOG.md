# Changelog

All notable changes to Overwatch will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.11.0] — 2026-10-26

### Added

- Optional managed host Nginx edge configured in `overwatch.yaml.edge`: ordered IP/path/method rules, endpoint-specific request limits, query-free access logs, TLS 1.2/1.3, version hiding, trusted forwarding and rejection of unknown hosts/TLS names.
- `overwatch infra edge render|check|deploy|rollback`: complete Nginx validation, explicit adoption of existing files, protected backups, concurrent-edit detection and rollback on failure. Conflicting virtual hosts fail validation instead of silently ignoring access policies. Existing installations remain unchanged until explicitly enabled and deployed.
- [Managed edge setup and operations guide](docs/edge-security.md), including proxy boundaries, MCP exceptions, safe rollout and application responsibilities.

## [1.10.0] — 2026-10-26

### Added

- **App-wide URL and IP access policies.** Ordered allow/deny rules match Go/RE2
  path regexes, IPv4/IPv6 addresses and CIDRs, or both, with an explicit fallback
  action. Configure private apps with public health/webhook exceptions, URL/IP
  blacklists, and partner-specific endpoints in App Settings → Traefik or the
  app Traefik API. First matching rule wins; existing authentication and other
  middleware still apply. Invalid rules and unknown policy fields are rejected.
- **Access-control setup guide** with full examples, precedence, regex boundaries,
  client IP/proxy limitations, and rollout instructions: [docs/access-control.md](docs/access-control.md).

### Changed

- Access policies follow the current admin-owned app definition across tenant
  image versions and apply on each tenant's next Overwatch start, restart, or
  update. Tenant overrides and embedded image manifests cannot disable them.
  Apps without a policy retain their existing routing behavior.
- Denied requests receive an explicit proxy rejection instead of falling through
  to a less-specific service. The original service routing priorities are retained.

## [1.9.3] — 2026-10-26

### Security

- **Upgrade `zod` from 3 to 4 to fix [CVE-2023-54404](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)**
  (memory exhaustion validating oversized unbounded-array schemas; the fix exists
  only in zod 4). This was the deferred item from 1.9.2. `npm audit` is now clean
  for both production and dev. No change to the REST/MCP request or response
  contracts.

### Changed

- **`gen-ui-types` now walks zod 4 internals (`_zod.def`).** The generated
  `ui/src/lib/api-types.generated.ts` is unchanged except that `TraefikGlobal` is
  now emitted as an `interface` rather than a `type` alias (the same object shape):
  in zod 3 its top-level `.superRefine()` hid it behind a `ZodEffects` wrapper, so
  it missed the object check; zod 4 refinements don't wrap, so it is now detected
  as an object like every other schema.

### Fixed

- **A partial app update no longer silently resets `default_image_tag` to
  `latest`.** Under zod 4, `.partial()` lets a field's `.default()` fire when the
  field is omitted (zod 3 suppressed it), so `PATCH /api/apps/:id` without
  `default_image_tag` would have overwritten the app's pinned tag. The update
  schema now re-declares that field as a plain optional, so an omitted field means
  "leave unchanged".

## [1.9.2] — 2026-10-26

### Security

- **Patch an unauthenticated denial of service in `body-parser`.** A request
  carrying `Content-Encoding` plus trailing bytes after a valid compressed
  frame reached the finished decoder as an uncaught exception and terminated
  the process; parsing runs before routing, so no auth or matching route was
  required. Pin `body-parser` to `2.4.0` via an override (within Express 5's
  accepted range). Fixes [CVE-2026-111181](https://github.com/advisories/GHSA-27r3-jxmh-p828).
  Existing deployments need a rebuilt image and container recreation.
- **Patch URI-parsing flaws in `fast-uri`** (pulled in transitively through the
  MCP server's `ajv` JSON-schema validation). Pin `fast-uri` to `3.1.9` via an
  override, covering [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg),
  GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr and GHSA-333x-w4r6-6crp (URI scheme
  spoofing, path-equivalence, host confusion and scheme injection).
- **Refresh the Alpine `docker-cli` / `docker-cli-compose` packages** in the
  runtime image to the fixed `29.9.2-r0` / `5.6.1-r0` (CVE-2026-78669,
  CVE-2026-111943). The Dockerfile installs these with `apk add --no-cache`, so
  a clean rebuild of this release pulls the patched versions.
- **Bump the dev-only `undici` to `7.30.1`** (via override) in the `@yao-pkg/pkg`
  build toolchain, clearing it from `npm audit`. This package is build-time only
  and never shipped in the runtime image.

### Known issues

- A moderate-severity memory-exhaustion advisory affects `zod` 3.x
  ([CVE-2023-54404](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)); the fix
  requires the `zod` 4 major upgrade, which is tracked as a separate reviewed
  migration. The affected `safeParse` paths are reachable only by an
  authenticated admin.

## [1.9.1] — 2026-10-22

### Security

- Update all three Docker stages from Node.js 24.22.0 to 24.22.1, pinned by
  image digest. This applies the [October 21, 2026 Node.js security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases),
  including CVE-2026-111497 (Brotli remote code execution), CVE-2026-105482,
  CVE-2026-105483, CVE-2026-106069, CVE-2026-105481, CVE-2026-106072,
  CVE-2026-106074 and CVE-2026-106073, plus bundled dependency and CA updates.
  Existing deployments need a rebuilt image and container recreation.
- Build standalone CLI binaries in SEA mode with stock Node.js 24.22.1.
  Standard `pkg` mode embeds Node.js 24.20.0 even when the build host is patched;
  existing CLI installations need the rebuilt binary too. CI checks for the
  latest Node 24 patch before tests and release builds.
- Upgrade Vitest and its mocker to 4.1.12 for
  [CVE-2026-112949](https://github.com/advisories/GHSA-qxg6-89mg-rqv8) and
  [CVE-2026-112950](https://github.com/advisories/GHSA-xp26-3454-mjgp), fixing
  development-server mock injection and Windows path traversal.

## [1.9.0] — 2026-10-15

A security and reliability release from a whole-app audit. Read the **Upgrade notes** before upgrading: some editor permissions are tightened, the restore API needs a confirmation header, and installs should be checked for tenant volumes shared between tenants.

### Security

- **An unauthenticated client can no longer crash Overwatch through `/ws`.** A WebSocket upgrade whose request target does not parse, a `Host` header that is not a valid URL host (`host:x`), or a first frame over the 4 KB payload limit each raised an uncaught error and took the whole process down: UI, API, MCP and any tenant update or restore in flight. Upgrades are now also rate-limited per IP, unauthenticated sockets are capped per IP (the oldest unauthenticated socket is evicted at the global ceiling), and a socket that fails or times out authentication is freed at once.
- **Tenants no longer share Docker volumes.** A `volumes[]` entry without `name_template`, and a backup path no volume already mounts, became one Docker volume used by every tenant of every app with that service: tenants saw each other's files, every backup held every tenant's files, a restore wrote into the shared volume, and deleting one tenant could remove everyone's data. New tenants get `<app>-<tenant>-<name>` volumes. Existing tenants keep the names their compose file already uses, now declared external so a delete never removes them (see Upgrade notes).
- **Editing an app's Traefik config is admin-only.** An editor could add a `forwardAuth` default middleware that sent every tenant user's `Cookie` and `Authorization` headers to any URL. App middlewares can no longer redefine a global middleware, global `default_middlewares` always apply to tenant routers (tenant `middleware_overrides` and raw labels can neither drop nor redefine them), and tenant raw labels can no longer redirect users off the tenant's hosts, forge identity headers (`Authorization`, `X-Forwarded-User`, `Remote-*`, …), empty CSP/HSTS/X-Frame-Options, or allow credentialed CORS from any origin.
- **Only admins can set, delete or read tenant admin-token secrets.** Editors could set `AUTH_SERVICE_SECRET` or an app's `admin_access.secret_env` as a variable or tenant override; `shared.env` beats `.env` and the image ENV, so they could sign their own tenant system-admin token. Non-admins now get `403` for those keys and always see them masked.
- **`X-Forwarded-For` is honoured only from the Traefik container.** Tenants share Overwatch's Docker network, so a compromised tenant could forge client IPs to dodge per-IP limits (including client registration) and fake audit-log IPs. Set `OVERWATCH_TRUST_PROXY_HOST` (default `<project.prefix>-traefik`) for another proxy.
- **Postgres restores run with only the tenant's privileges.** The restore connects as the tenant's database role, so neither a crafted dump nor index or CHECK expressions in tenant data run as superuser, and a dump cannot switch back to the superuser. Dumps are taken with `--no-owner --no-privileges`; older dumps still restore. The MySQL restore still runs as the DB root user.
- **Restoring and deleting backups is checked and confirmed.** A restore or snapshot delete only accepts a snapshot tagged for the app and, in place, for the target tenant (a cross-tenant restore is an explicit opt-in); restore requires `X-Confirm-Id` with the target tenant, and the UI asks for the tenant id before restoring and confirms before deleting a snapshot. Before, an app's delete could remove another app's snapshot in a shared repository, and one click could restore one customer's data into another tenant.
- **Child processes no longer inherit Overwatch's secrets.** Database dump/restore clients, registry logins, manifest extraction, `infra deploy` and the Traefik reload run with an allowlisted environment instead of the full process env (which held `JWT_SECRET`, the DB root password and registry tokens). A test now fails if a new module spawns processes outside this boundary.
- **A tenant can no longer claim the admin UI host** on installs routed by the legacy `OVERWATCH_ADMIN_HOST` labels; it is reserved like `traefik.overwatch.host`. Host-alias writes are now serialised with tenant creation, so two tenants can no longer claim the same host concurrently.
- **Volume names that would mount a host path are refused.** A volume `name` or `name_template` starting with `/` or `.`, or containing `:`, became a host bind mount (for example `/var/run/docker.sock`). Saving one now fails; stored definitions still load, with a warning.
- **Registry `url`, `repository` and `api_url` are validated before use.** A value starting with `-` reached `docker login`/`pull`/`create` as an option. New or changed values must follow the registry reference format; stored values that don't still load with a warning, but Overwatch refuses to pull, log in or list tags for that app until they are fixed. Docker calls end their options with `--`.
- **MCP OAuth hardening.** Reusing a rotated refresh token revokes the whole grant; a removed and re-added admin no longer gets old grants back; client registration has its own stricter per-IP limit and caps each `redirect_uris` entry at 2048 characters; the consent page shows the full redirect URI; consent, token issuance, refresh, revoke and web sign-ins are audit-logged.
- **Signing out revokes the session on the server.** Sessions carry an id that sign-out records until the token expires; the API and the WebSocket refuse it.
- **MCP tool roles are enforced centrally** and role denials are audit-logged, like REST `403`s.
- **Container logs require the editor role.** Tenant logs can hold PII and tokens; viewers no longer see them.
- **Backup restore, backup prune and DB process kill count against the destructive rate limit,** and `/api/monitoring` and `/api/database` are now covered by it. Classification follows Express routing exactly (case-insensitive paths cannot bypass it).
- **Secrets stay masked for non-admins.** Editing a tenant override without re-sending `sensitive` keeps the stored flag (a new override of a sensitive global variable inherits it); every cert-resolver env value is masked; static `env_mapping` values in app definitions are masked. Saving a masked value back keeps the stored one.
- **The audit log no longer stores credentials.** Traefik-bearing request bodies (global, app and tenant Traefik config, app definitions) are masked before auditing, and basicAuth/digestAuth `users` lists are redacted.
- **Config snapshots are safer.** Restore reads only real files inside `.snapshots` (no symlinks, no path names) and is atomic and locked; snapshots no longer include `audit.log` or the MCP OAuth store, so restoring an old one cannot revive revoked grants.
- **Browser hardening.** CSP `connect-src` is pinned to `'self'` (no longer any `wss:` host), and HSTS is sent over HTTPS.
- **MySQL database-level grants escape `_` and `%`,** so a tenant grant no longer matches other databases whose names differ only in those positions.
- **Release images and CLI binaries carry signed build-provenance attestations,** and the image's base is pinned by digest (see [updating.md](docs/updating.md) to verify).

### Fixed

- **Backup retention now deletes old snapshots.** `restic forget` grouped by host and path, and every snapshot had its own path, so nothing was ever pruned. It now groups by tag within the app's own snapshots; `dryRun: true` shows what would go.
- **Backups no longer fail silently.** A run that cannot list its tenants (for example with Docker down) is a failed run, a backup whose file copies failed is reported incomplete, failures go to the error log, and the new `backup_failed` and `backup_stale` alert rules report them.
- **In-place restore is safe.** It stops the tenant, takes a `pre-restore` snapshot, resets the database so tables that exist only in the live database do not survive, imports, copies files, and rolls back to the pre-restore copy if anything fails. Postgres restores abort on the first SQL error instead of reporting success.
- **A failed tenant update restores its database.** The database is dumped right before the new version starts; if the restart fails, the database is put back before the previous version starts again (if the dump cannot be taken, the update stops with nothing changed).
- **A database restore that stops early no longer crashes Overwatch** (an unhandled EPIPE killed the process mid-restore and skipped create-from-backup rollback), and a dump resolves only once its file is fully written.
- **Dumps, restores, registry calls and manifest extraction have timeouts,** so a hung client can no longer block every later scheduled backup or hold a tenant lock forever; the dump/restore timeout is enforced inside the DB container.
- **A backup can no longer capture a half-restored database:** backups take the tenant lock. Backups include stored routines and events (`mysqldump --routines --events`), staging directories can no longer collide and are swept at startup, scheduled backups of different apps run one at a time, and `restic unlock` no longer removes live locks unless forced.
- **"Keep data" delete keeps the tenant's volumes and saves its `.env`** (with the database password) under `data/deleted-tenants/`; it used to delete the volumes. Re-creating over a kept database explains what to do.
- **Start and restart apply tenant routing changes.** Host aliases and middleware overrides were only applied on the next image update, although the UI said a restart applies them.
- **Hyphenated app and tenant ids can create tenants,** and a tenant whose compose project, container, database or volume names would collide with another tenant's is refused. The MySQL 32-character user-name limit is checked up front.
- **Deleting a trashed app's tenant drops its real database** (it guessed the name from the project default prefix and orphaned the database), and fails closed when the name cannot be determined.
- **Image cleanup keeps tags another tenant still uses,** so a stopped tenant can always start again.
- **An update without an `IMAGE_TAG` line in the tenant `.env` fails** instead of reporting a success that never happened.
- **Overwatch logs in to an app's registry before each pull,** not only at boot: apps added later, rotated tokens and expired ECR tokens work without a restart, and apps sharing a registry host with different credentials no longer overwrite each other's login mid-pull. ECR tag listing no longer blocks the server and reports errors instead of an empty list.
- **A lost, legacy or mismatched env store no longer empties tenants' `shared.env`.** A missing `env-vars.json` or `tenant-env-overrides.json` is no longer recreated empty while tenants still have variables, the legacy array format is refused instead of read as empty, and regeneration keeps a tenant's file when no store knows its app.
- **Env values containing ` #`, a leading quote or a trailing backslash are quoted,** so compose no longer truncates them or fails to parse the tenant's env file.
- **One malformed admin email can no longer lock every user out,** and `ALLOWED_ADMIN_EMAILS` now seeds an empty `admin-users.json`, so the first sign-in after `overwatch init` works.
- **`health_check_failed` alerts fire** once per outage when consecutive failures reach `consecutive_failures` (they could never fire), and **`container_down` no longer alerts for deliberate stops and deletes.**
- **A hung `docker stats` call no longer freezes metrics and CPU/memory alerts;** stats calls time out after 10 s and at most 10 run at once.
- **Concurrent notification-channel edits are no longer lost.**
- **Expired, malformed or revoked MCP access tokens get `401` with `WWW-Authenticate`** instead of `500`, so MCP clients refresh; `/oauth/token` and `/oauth/revoke` answer malformed token parameters with `400`/`200` instead of `500`.
- **A crash loop can no longer rotate out the pre-incident config snapshots;** boot snapshots are deduplicated and capped on their own, and `snapshot prune --keep 0` is rejected.
- **Migrations are safe to re-run** after a partial failure, `OVERWATCH_AUTO_MIGRATE=1` really runs them, markers are written only on success, and a migrated legacy tenant keeps the volume names that hold its data.
- **`overwatch config edit` no longer overwrites concurrent UI changes,** and `config traefik doctor` on the host sees tenant overrides.
- **File locks can no longer be stolen from a live holder** (including a host CLI) or double-held after a reclaim race.
- **Every app write path enforces the same checks** (REST, `overwatch apps apply`, image manifests); creating an app with an id in the trash, or purging an app whose tenants still exist, is refused.
- **The saved theme applies before first paint again** (its inline script was blocked by the CSP), and **a crash is logged with its cause** before the process exits.

### Changed

- **New alert rules `backup_failed` and `backup_stale`** (with `max_age_hours`, default 26).
- **Start and restart regenerate the tenant compose file** from its definition and current overrides; hand edits to a tenant `docker-compose.yml` are overwritten.
- **Tenant updates dump the database before the new version starts,** so an update takes longer for a large database and needs temporary disk space for the dump.
- **Audit entries keep at most 4 KB of request body,** audit and alert logs are capped at 32 MB on prune, and history is read from the end of the file.
- **Faster listings:** admin users are cached by file signature (revocation still applies on the next request), tenant listings read `.env` files in parallel and only for the requested app, and the Database page polls only while its window is active.
- **The UI's tenant, container, health, metrics, alert and audit types are generated from the backend.**
- **CLI config commands say the server needs `overwatch recreate`** to pick up `overwatch.yaml` changes.

### Upgrade notes

- **Check each host for shared legacy volumes** before relying on tenant isolation: [troubleshooting.md](docs/troubleshooting.md#shared-legacy-volumes) has the detection commands and a per-tenant migration. Existing tenants keep their current volumes (now external), so nothing moves on upgrade; separating files that are already mixed needs knowledge of the app.
- **The first backup prune after upgrading removes the whole backlog** older versions never pruned. Run it with `dryRun: true` first; its exclusive lock blocks other apps that share the repository while it runs.
- **The restore API requires `X-Confirm-Id`** with the target tenant id; update any scripts that call it.
- **Editors lose some access:** editing an app's Traefik config, setting `AUTH_SERVICE_SECRET` or any app's `admin_access.secret_env`. Viewers can no longer read container logs.
- **Check the startup log for `[proxy-trust]`.** It should say `X-Forwarded-For trusted only from '<prefix>-traefik'`. Behind another proxy, set `OVERWATCH_TRUST_PROXY` to its IP/CIDR, or `OVERWATCH_TRUST_PROXY_HOST`; `OVERWATCH_TRUST_PROXY_HOST=none` restores the previous behaviour.
- **Tenant raw labels that drop or redefine a global default middleware,** redirect off the tenant's hosts, forge identity headers, empty security headers or allow credentialed wildcard CORS are dropped with a `[traefik] dropped raw label` warning at the next compose regeneration (now also on start/restart). An app middleware named like a global one is ignored in favour of the global one. Check the logs after upgrading.
- **Health-check alerts will start arriving** with your existing `health_check_failed` rules. Once you add `backup_failed`/`backup_stale` rules, a downgrade to 1.8.2 fails config validation until they are removed.
- **Postgres:** a backup that needs a superuser-only (untrusted) extension, such as PostGIS, restores only once that extension is installed on the server. **MySQL/MariaDB:** `mysqldump --routines --events` needs the DB root user to have the EVENT and SHOW_ROUTINE privileges (root has them by default).
- **The first log prune trims `audit.log` and `alert-history.jsonl` larger than 32 MB,** dropping the oldest entries; copy them first if you need the full history. Entries and snapshots written before the upgrade can still contain basicAuth hashes, so consider rotating those credentials.
- **Private registries:** the `/root/.docker` mount is read only when Overwatch runs as root (`OVERWATCH_UID=0`); set the app's registry `token_env` instead. A stored registry value with an invalid format logs `App '<id>' has an invalid registry.<field>` at start and blocks pulls for that app until fixed.
- **`overwatch infra deploy` no longer passes shell-exported variables** to compose; put them in `infrastructure/.env`.
- **To purge a trashed app, restore it and delete its tenants first.**
- **Downgrading to 1.8.2:** tenants created on 1.9.0 use tenant-scoped volume names (`<app>-<tenant>-<name>`). 1.8.2 regenerates a tenant's compose file on update with the old shared names, which would point the tenant at a different, possibly empty volume, so do not update such tenants on 1.8.2. Remove any `backup_failed`/`backup_stale` alert rules first.
- **Sessions issued before the upgrade** cannot be revoked by signing out and stay valid until they expire (at most 24 h). MCP refresh tokens issued before the upgrade keep working and rotate into the new format.

## [1.8.2] — 2026-10-14

### Changed

- **Node.js 24 LTS everywhere.** The Docker image stages, CI and the CLI binaries move from Node 22 to Node 24 (LTS until April 2028; Node 22 reaches end of life in April 2027). Running from source or building the CLI now needs Node 24.
- **CI actions updated** (docker/build-push-action 7.4.0, docker/metadata-action 6.2.0).

### Fixed

- **A container without a name no longer hides every tenant.** Docker reports `Names: []` for some leftover containers (for example a stale build container in the `created` state); one of those made the tenant and container listings come back empty in the API and UI.
- **A request path containing `%s` or `%o` no longer mangles the server error log.** The path was part of the log format string, so such a path consumed the error and dropped it from the log line (CodeQL `js/tainted-format-string`).

### Upgrade notes

- **Running Overwatch from source or building the CLI binary now needs Node.js 24.** Docker image users need no action.

## [1.8.1] — 2026-10-14

### Security

- **Viewers and editors no longer receive credentials from Overwatch's read APIs.** Database process-list statement text is `[hidden]` (it can show `CREATE USER … IDENTIFIED BY` during tenant creation). Traefik credentials are masked on every read surface — the global Traefik config, app definitions (`/api/apps`, `/api/apps/:id`, `/api/apps/:id/traefik`, `/api/apps/.trashed`) and tenant Traefik overrides: basicAuth/digestAuth users, forwardAuth addresses (shown as origin only, e.g. `https://auth.example/••••••••`), custom and health-check header values, plugin settings, router rules with header or query matchers, any other value containing `@` or a credential-named parameter, and every raw-label value whose key is not a known non-secret field. Admins still see full values. Saving a masked value back keeps the stored credential (resolved under the write lock, so a concurrent rotation is not reverted); a masked value with nothing stored is refused. Container logs and update progress stay readable by viewers.
- **Credential masking cannot be used to stall the server.** Values longer than 2 KB are hidden from non-admins without being parsed, and credential-parameter detection is linear (a 100 000-character value previously took over a minute per read).
- **Docker child processes receive only an allowlist of `DOCKER_*` variables** (`DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_CONTEXT`, `DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY`, `DOCKER_API_VERSION`, `DOCKER_BUILDKIT`, `DOCKER_DEFAULT_PLATFORM`, `DOCKER_CONTENT_TRUST`, `DOCKER_CONTENT_TRUST_SERVER`) instead of every `DOCKER_*` variable.
- **Concurrent creates can no longer claim the same domain**; the domain check and the tenant `.env` write are serialised under one lock.
- **The SSRF guard strips every trailing dot from a hostname** (`localhost..` is refused), and a registry `Link: next` header matches the registry origin even with an explicit `:443`; a dropped foreign-origin link is logged.
- **The WebSocket membership re-check cannot stall**: runs never overlap, and each user-store read times out after 10 seconds.

### Fixed

- **Creating a tenant from a backup restores before the app first starts.** The tenant is created stopped (`docker compose create`), the database and volume paths are restored, then it starts; a failed start rolls the new tenant back. Backed-up paths must be volume mount points or exist in the image.
- **Restore uses the tenant's own app-definition snapshot** for its services and paths, takes the per-tenant lock, and reports an invalid snapshot with its real error instead of a generic server error. Shared env regeneration also takes the per-tenant lock.
- **Rolling back a failed update no longer overwrites a newer global app definition**; it is restored only if it is still the one this update applied.
- **Env values with leading or trailing whitespace are quoted in generated env files**, so containers receive the exact value (verified against real `docker compose`).
- **Lock waits have a deadline.** A caller waiting more than 30 seconds (`OVERWATCH_LOCK_TIMEOUT_MS`) gets a 409 "busy" error instead of hanging; lock files carry a per-process id, so two PID-1 containers sharing a data directory no longer reclaim each other's live lock.
- **Saving env vars while a tenant is mid-update no longer stalls or fails.** A busy tenant is skipped after 2 seconds and its `shared.env` is rewritten in the background as soon as the running operation finishes; the save returns 200 with a warning naming the busy tenants, shown as a toast.
- **`overwatch apps apply` refuses masked placeholders** copied from a non-admin API read instead of saving them as credentials.
- **A stuck audit or alert log no longer retries forever.** Retries back off, at most 10 000 lines are kept in memory (oldest dropped, logged once), and shutdown waits at most 5 seconds for the final flush, logging how many lines were not written.
- **Healthcheck `interval` / `start_period` are validated as Compose durations** on the API and `overwatch apps apply`; stored invalid values still load and fall back with a warning.
- **`overwatch config edit` shows the "fix the values" hint only for validation errors** (listed per field again); no-op deletes no longer rewrite `overwatch.yaml`.
- **Smaller fixes:** a backup reconcile queued after shutdown no longer restarts cron tasks; notification-channel saves take a file lock; Docker event buffering counts bytes; startup permission tightening isolates failures per file; `overwatch init` skips the MariaDB placeholder on Postgres hosts; database restore errors keep only the last 2 KB of stderr and MySQL rollback revokes the grant on a dropped database; the backup summary hides schedule, bucket and endpoint when backups are disabled; admin access `email_template` replaces every `${tenantId}`; `GET /api/auth/verify` verifies the token once; `overwatch apps restore|purge` treat an audit-write failure after success as a warning (exit 0).
- **Web UI:** client routes containing dots are served again (only `/assets/*` and static file extensions return 404); the WebSocket client detects half-open connections and falls back to polling, and the tenant list refreshes every 2 minutes while live to catch CLI edits; editors can test the registry connection from App Settings; the service editor keeps its state when a middle service is removed; the Trash and Admin Users pages get accessible labels, Enter-to-confirm and per-row pending states ("Remove Admin" is now "Remove user").

### Changed

- **TypeScript 6 and `@types/dockerode` 4** for the backend (no config or output change); UI dependencies refreshed (React 19.3, react-router 7.18, Vite 8.3); `npm audit` is clean for backend and UI.
- **CI actions updated** (checkout v7, docker/login-action v4, softprops/action-gh-release v3; SHA-pinned). Dependabot ignores zod major updates — zod stays on v3 until a dedicated migration (the MCP SDK and the UI type generator depend on v3 internals).
- **Raw router `middlewares` labels may name any of the app's own (hyphenated) typed middlewares** at save time; a name the generator doesn't produce is dropped with a warning at generation.
- **Docs:** viewer read scope (`docs/api.md`), the `DOCKER_*` allowlist, `OVERWATCH_LOCK_TIMEOUT_MS`, the writable `<data>/.locks` / `.config-tmp` the CLI needs, and new troubleshooting entries.
- **Tests:** CLI end-to-end tests warm `tsx` once instead of timing out on a cold compile; new coverage for broadcast backpressure, lock reclaim and deadlines, the apps cache, JSONL outages, the config writer CLI paths, the scheduler and the create-from-backup order.

### Upgrade notes

- **Integrations that read app or Traefik configuration with a viewer or editor token now receive `••••••••` placeholders** for credentials and for raw-label values outside the known non-secret options (`/api/apps`, `/api/apps/:id`, `/api/apps/:id/traefik`, `/api/apps/.trashed`, `/api/traefik*`, tenant Traefik overrides), and process-list statements as `[hidden]`. Use an admin token where the real values are needed.
- **Editors see their own raw-label values masked** when the option is not a known non-secret field; re-saving the form keeps the stored values, and a placeholder can only stand for a value already stored under the same key.
- **Operations on a tenant that is busy for more than 30 seconds now fail with 409 "busy"** instead of waiting indefinitely (`OVERWATCH_LOCK_TIMEOUT_MS` changes the wait). Retry when the running update, create or restore finishes.

## [1.8.0] — 2026-10-14

### Security

- **An image's embedded `/overwatch/app.json` can no longer change security-relevant parts of the app definition.** On tenant update the manifest still adds, removes and reorders services and updates their ports, health checks, `env_mapping`, `depends_on`, routing paths and `env_vars` declarations. These fields keep the value an admin set: `admin_access`, `backup`, `credentials`, `db_prefix`, `traefik`, and per service `user`, `command`, `volumes`, `networks`, `backup`, `routing.middlewares`, `routing.raw_labels` and `routing.tls_termination`. Services a manifest adds to an existing app start with routing disabled, and a service that was not routable stays unrouted. Ignored changes are logged as `[manifest] ignored protected fields from image <tag>: <paths>` and shown in the update progress.
- **Raw Traefik labels and host aliases can no longer route anything but the tenant's own hosts and objects.** Raw labels may only address the tenant's own routers, services and middlewares; `traefik.tcp.*`, `traefik.udp.*`, other tenants' objects, `tls.domains`, indexed `entrypoints[n]` / `rule[n]`, a router `service` pointing elsewhere, `loadbalancer` server URLs and non-`loadbalancer` service types are dropped when labels are generated and rejected with 400 on save (API and `overwatch apps apply`). Raw middlewares may only use types that cannot reach another service, a URL or a file (headers, ratelimit, inflightreq, compress, retry, ipallowlist, redirects, prefix and path rewrites, buffering, contenttype, passtlsclientcert, grpcweb, inline basicauth/digestauth users); `errors`, `forwardauth`, `chain`, `plugin` and `usersfile` are refused, a router's raw `middlewares` may list only the tenant's own or generated middlewares, and raw `tls.*` on a router is refused. A new tenant's primary domain gets the same reserved-host and other-tenant checks as aliases. Host aliases must be valid hostnames, may not be the Overwatch, MCP or dashboard host or another tenant's domain or alias, and for wildcard `domain_template` apps must match the template or the new optional `traefik.allowed_alias_domains`. If the alias check cannot load its data it fails closed. Traefik config errors now return 400/404 instead of 500.
- **Tenant `docker-compose.yml` files are generated as data, so no field value can change their structure.** Service names, `env_mapping`, volumes, health-check fields and label values used to be pasted into YAML text; a quote, backslash or line break in an app definition could add keys such as `privileged: true` or make the file unparseable. Duplicate service names and duplicate `depends_on` entries now fail generation with a clear error.
- **`docker compose` for tenants runs with a curated environment.** It no longer inherits Overwatch's process env (`JWT_SECRET`, database root password, registry and backup tokens); only `PATH`, `HOME`, `DOCKER_*` and compose tuning variables (`COMPOSE_HTTP_TIMEOUT`, `COMPOSE_COMPATIBILITY`, `COMPOSE_PARALLEL_LIMIT`, `COMPOSE_ANSI`, `COMPOSE_STATUS_STDOUT`, `COMPOSE_MENU`) pass through, so a stray `COMPOSE_PROJECT_NAME` or `COMPOSE_FILE` cannot merge tenants into one compose project.
- **App definitions and image manifests are bounded.** New and edited apps need slug service names, the service-name label is `$`-escaped, and an image manifest larger than 1 MiB, or one that is not a regular file, is ignored. A manifest shipped as a symlink can no longer make Overwatch read a file from its own filesystem.
- **Overwatch core secrets can no longer be used as tenant-admin or registry credentials.** Admin access token minting refuses an `admin_access.secret_env` naming `JWT_SECRET`, the Google credentials, the database root or restic passwords, `R2_*`, `AWS_*` or `GHCR_TOKEN`; registry `token_env` / `username_env` refuse the same names (except `GHCR_TOKEN` for GHCR). Stored definitions that name one log a warning at load.
- **Web sessions are audience-bound and re-validated.** Session tokens carry `aud=overwatch-web` / `iss=overwatch`, so MCP and OAuth-consent tokens signed with the same secret are no longer accepted as sessions. A token for a removed admin returns 401, and the WebSocket closes at token expiry or within 60 seconds of the user's removal.
- **MCP OAuth asks for consent and is harder to abuse.** After Google sign-in an Approve/Deny page names the client, its redirect host and the scope before any code is issued. Dynamic registration accepts only `https` or loopback `http` redirect URIs, caps clients at 200 and prunes never-used clients after 24 hours (oldest first when the cap is hit) and used ones after 90 days idle. The token endpoint requires a matching `client_id` on code exchange and refresh (a mismatch does not revoke the token), rejects unknown `resource` values and reports the real `expires_in`; expired codes and refresh tokens are swept periodically.
- **Outbound webhook and registry URLs share one SSRF guard.** Both A and AAAA records are resolved and the URL is refused if any address is private (including CGNAT, multicast, IPv4-mapped, IPv4-compatible, 6to4 and Teredo IPv6). A DNS failure rejects the URL, redirects are never followed (registry token and tag requests included), and a custom `Host` header is ignored. Webhook URLs are checked again at send time.
- **Postgres tenant databases are no longer connectable by every role.** `CONNECT` is revoked from `PUBLIC` and granted only to the tenant's own role (see the upgrade notes for existing databases).
- **The database root password no longer appears in `docker exec` arguments** (`MYSQL_PWD` / `PGPASSWORD` are passed by name), so it is not visible in `ps`.
- **Unexpected 5xx responses no longer leak internals.** They return a generic "Internal server error" and log the full error.
- **Notification-channel changes are audited** with the webhook URL reduced to its origin and header values masked.

### Fixed

- **Tenant creation no longer adopts or drops a database it did not create.** It fails with 409 Conflict when a database for the tenant already exists, and rollback drops only what that call created. MySQL/MariaDB resets the password of an existing user so it matches the written `.env`.
- **Postgres tenant deletion is no longer cut off by the 30-second admin statement timeout.**
- **Backups and restores no longer report success when they are incomplete.** Backup, restore and tenant delete resolve the database from the tenant's `DB_NAME` (migrated tenants restore into the right database), a failed `docker exec ls` marks the backup incomplete, and restore returns `warnings` that the API passes on and the UI shows as a toast.
- **Creating a tenant from a backup no longer sleeps a fixed 5 seconds.** It restores once the new tenant's containers (including init containers) are up, restarts the app afterwards, and removes the new tenant if the restore fails.
- **Backup schedules follow app changes.** Creating, editing, deleting or restoring an app updates its schedules immediately, and a 1-minute reconcile picks up edits made directly in `apps.d/`.
- **App Settings can turn off Backup and Admin access.** `PUT /api/apps/:id` is validated against the update schema (400 with field errors), and `GET /api/apps/:id/tags` returns a classified error instead of the raw registry message.
- **Audit log and alert history no longer lose entries to retention.** Appends and hourly pruning share one serialized, locked writer. Role changes on admin users are audited as `change role of <email> to <role>`.
- **Env-var saves no longer report success when `shared.env` could not be written.** Failures are returned as a 500 naming the failing tenants.
- **Tenant lifecycle operations are serialised per tenant and bounded.** create/update/delete/start/stop/restart take a per-tenant lock; `compose up` and `pull` are bounded at 1 hour and other compose and restic calls have shorter timeouts and output limits; a lock file left by a killed Overwatch process is reclaimed after a restart instead of blocking the tenant; and a failing `restic snapshots` is no longer cached as "no backups".
- **Saving per-tenant Traefik overrides for a tenant that does not exist returns 404** instead of creating its directory.
- **The Admin Users page shows an error when the list fails to load**, and the container log viewer signs you out on 401 and shows server errors.
- **Monitoring is more reliable and no longer leaks state.** Docker events are line-framed and matched by the managed label, alert timers and listeners are cleaned up, a corrupt notification-channels file is never overwritten, webhook delivery failures are reported (the test endpoint returns 502), and state for containers that no longer exist is dropped after 10 minutes (stopped containers keep their alerts).
- **Writes of `overwatch.yaml` go through one locked, validated writer that keeps the file's inode.** `overwatch config traefik` and `overwatch config edit` no longer leave the container reading a stale bind-mounted file, and Traefik config updates no longer lose concurrent changes.
- **`$` in values stays literal.** `$` in Traefik label values (`$apr1$` htpasswd hashes, `$1` regex replacements), static `env_mapping` values and `shared.env` / tenant `.env` values is no longer interpolated by compose, and backslashes in label values (regexes in `redirectRegex` / `replacePathRegex`) reach Traefik exactly as written.
- **External volumes are read from the parsed compose file**, which stops a stray volume being created with the external network's name.
- **Duplicate or `networks: []` edge cases in generated compose files** now render correctly: `networks: []` attaches to the default network instead of being rejected.
- **An ambiguous short container-id prefix on logs and restart returns 404** instead of acting on the first match.
- **Duplicate, missing and invalid app, tenant and admin-user operations return 409/404/400** instead of 500, and MCP read tools surface the error message.

### Changed

- **`overwatch init` and `overwatch infra deploy` produce the same infrastructure.** Init renders its compose and Traefik files through the shared generator (MariaDB 10.11 / PostgreSQL 16, Traefik v3.6, `traefik-letsencrypt` volume, `overwatch.yaml` mounted read-write so UI Traefik edits persist) and writes a `traefik` block into `overwatch.yaml`. The Overwatch compose passes `ALLOWED_ADMIN_EMAILS` through, defaults `OVERWATCH_TRUST_PROXY` to `1` everywhere, loads `overwatch/.env` as an optional `env_file` so operator-chosen variable names (registry and backup `*_env`) reach the container, and no longer passes the removed `GITHUB_APP_*` or the unused `GOOGLE_CLIENT_SECRET`.
- **`overwatch infra deploy` refuses to downgrade a running database.** If the running `<prefix>-mariadb` / `-postgres` image has a higher major.minor than the one being deployed it aborts before writing anything; `--allow-db-downgrade` overrides.
- **Database pools are bounded and closed on shutdown.** Connect, idle and statement timeouts for Postgres, a connect timeout and queue limit for MySQL, and all cached adapters are closed during graceful shutdown.
- **The web UI stops polling while the WebSocket is live and loads heavy pages on demand.** Tenant, health and metrics queries are driven by WebSocket events (polling resumes if the socket drops), container logs poll only while the tab is visible, and the server disconnects WebSocket clients with more than 1 MB buffered for 30 seconds. Missing `/assets/*` files return 404 instead of `index.html`, and a tab left open across an upgrade shows a Reload prompt (or reloads once) instead of a blank page.
- **Backend hot paths are cheaper.** Tenant listing makes one Docker listing and one app read, app definitions are cached against file metadata (CLI edits are still picked up), and health probes run concurrently.
- **The registry form and service editor are shared between the create wizard and app settings**, and settings can now edit the registry `tag_pattern`. UI API types are generated from the backend schemas by `npm run build`.
- **Dependencies are refreshed and `npm audit` is clean** for the backend and UI (including the critical `proxy-addr` advisory via Express). Docker image stages, CI and the CLI binaries target Node 22 (the image was on `node:26-alpine`), CI actions are pinned to commit SHAs, and `curl` is dropped from the runtime image.
- **`data_dir`, `OVERWATCH_DEPLOY_DIR` and `OVERWATCH_SKIP_CHECKSUM` are documented**, and `docs/architecture.md` lists the current source tree.
- **The backend compiles with `noUnusedLocals` and `noUnusedParameters`, and the tests are type-checked in CI** (`npm run typecheck:test`, using the new `tsconfig.test.json`). Batch-named test files were split into per-module files; no test was added or removed.

### Added

- **Roles can be assigned and changed from the API, UI and CLI.** `POST /api/admin-users` takes an optional `role`, `PATCH /api/admin-users/:email` changes it, the Admin Users page has role pickers, and `overwatch admins add --role` / `overwatch admins role` do the same. The last admin can no longer be demoted or removed.
- **Deleted apps can be restored and purged from the UI and CLI.** A "Deleted apps" page lists the trash with restore and typed-id purge (admins only); `overwatch apps restore|purge <id>` do the same (purge needs `--yes` or a retyped id).
- **The admin UI hides controls your role cannot use.** `GET /api/auth/verify` and the login response include the role; viewers and editors see every page read-only instead of buttons that fail with 403, and a WebSocket closed as expired or revoked signs you out instead of reconnecting.
- **`traefik.allowed_alias_domains`** (optional) lists domains tenants may use as `host_aliases` for wildcard `domain_template` apps.

### Removed

- `scripts/update.sh` and `tenant-template/`. The `tenant_template` config key is no longer used; it is still accepted and ignored.

### Upgrade notes

- **Every web session is invalidated.** Session tokens now carry an audience and issuer, so all users sign in again after the upgrade.
- **Users added without a role are now `viewer`, not admin.** Existing users with no stored role (including those seeded from `ALLOWED_ADMIN_EMAILS`) stay admin. Pass `role: "admin"` or `--role admin` to grant full access.
- **Docker Compose 2.24 or newer is required on the host.** The Overwatch compose uses `env_file` with `required: false`, which older Compose versions reject. Node 22 is required for running from source or building the CLI.
- **Image manifests can no longer change protected app fields.** If your release process relied on that, make the change in Overwatch (`overwatch apps apply <file>`, `PUT /api/apps/<appId>`, or the admin UI) and update the tenant again. A release that adds a service needing a volume, `user` or `command` starts it without them until an admin adds them, and a new HTTP service on an existing app needs routing enabled once by an admin. Earlier manifests may already have written protected fields into `apps.d/<id>.json` and tenant snapshots; review them after upgrading.
- **Raw Traefik labels and host aliases outside the tenant's own objects are silently dropped.** On the next tenant update (warning in the logs) labels addressing other objects (shared middleware names, L4 labels, `loadbalancer` server URLs, `weighted` / `mirroring` / `failover` services, `serverstransport`) and aliases outside the app's template are no longer emitted, and re-saving such config is rejected. Raw middleware names must be `<app>-<tenant>-<service>-<token>` with a hyphen-free token (rename `-rate-limit` to `-rate_limit`), and raw middlewares of other types (`errors`, `forwardauth`, `chain`, `plugin`, file-based auth) are dropped as well — use typed middlewares for those; for aliases, add the domain to `traefik.allowed_alias_domains`.
- **Tenant creation refuses reserved and taken domains**: the Overwatch, MCP or Traefik dashboard host, or a domain or alias another tenant already uses.
- **New and edited apps need slug service names** (lowercase letters, digits, hyphens). Stored apps with other names keep loading and deploying, but those services must be renamed before the app's next edit through the UI, API or `overwatch apps apply`; services a manifest adds with an invalid name are skipped with a warning.
- **Compose no longer inherits Overwatch's environment, and `$` in values is literal.** Static `env_mapping` values and label values that relied on `${X}` / `$X` being interpolated stay literal; use a named source (`"KEY": "SRC"`) for interpolation. Doubled `$$` in basicauth users still works. If you doubled backslashes in label values to work around YAML escaping, remove the extra backslash. Redeploy (update or restart) tenants to regenerate their compose and env files. Registry credential helpers in the host Docker config are not supported for tenant pulls; the built-in ECR adapter works. A named source that used to resolve from Overwatch's own environment (for example a secret set only in `overwatch/.env`) is now empty unless the variable is defined in the tenant `.env` or `shared.env`, and `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE` and the other compose selection variables in Overwatch's environment are no longer passed to tenant compose.
- **`overwatch infra deploy` refuses DB downgrades and hosts created by an old `init`.** Those hosts run `mariadb:11`, `traefik:v3.3` and a `letsencrypt` volume, so deploy fails with the downgrade error by design. Keep running init's files, or restore from backup and use `--allow-db-downgrade`; the Let's Encrypt volume is renamed to `traefik-letsencrypt`, so certificates are re-issued after switching, and an `overwatch.yaml` without a `traefik` block makes deploy use the legacy static template until one is added.
- **Existing Postgres tenant databases stay connectable by every role** until you run `REVOKE CONNECT ON DATABASE "<db>" FROM PUBLIC; GRANT CONNECT ON DATABASE "<db>" TO "<tenant role>";` for each (or `createDatabase` runs again for them). Any non-tenant role that relied on implicit access needs an explicit `GRANT CONNECT`.
- **Outbound URLs are stricter.** Webhook and registry URLs resolving to private addresses are rejected; set `OVERWATCH_ALLOW_PRIVATE_WEBHOOK=1` or `OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL=1` to opt out. Redirects are never followed, a hostname that does not resolve is rejected, and a user `Host` header is ignored.
- **MCP OAuth.** Clients registered with a non-loopback `http://` redirect keep working (the consent page warns) but cannot be registered again; clients that omit `client_id` on refresh now get `invalid_grant`; users see one extra Approve click per authorization; redirect URIs with custom schemes (for example `cursor://` or `vscode://`) are refused at registration.
- **`overwatch snapshot restore` now also restores `notification-channels.json` and `mcp-oauth.json`.** Restoring an older snapshot can bring back MCP clients and refresh tokens revoked since; revoke them again after a restore.
- **Tenant creation returns 409** when a database for the tenant already exists on the server; drop or rename it first.
- **Ambiguous short container-id prefixes on logs and restart now return 404**; use a longer prefix (the UI sends full ids).
- **`scripts/update.sh` and `tenant-template/` are gone.** `overwatch update` replaces the script (it pulls the latest Overwatch image and recreates the `overwatch` compose service); `overwatch self-update` only updates the CLI binary. The `tenant_template` config key is ignored.

## [1.7.2] — 2026-10-13

### Fixed

- **Creating an app from the web UI no longer fails with a 400.** The wizard sent the default health-check `interval` as the number `30`; the API expects a duration string and now receives `'30s'`.
- **"AWS ECR" registry auth can be selected again.** The UI sent `aws_ecr`, which the API rejects; it now sends `aws_iam`, the value the schema, docs and adapters use.
- **Tenant, env-var and backup requests run their middleware once.** `/api/apps/:appId/*` requests passed through the `/api/apps` chain and then the app-scoped chain, so every mutation wrote two identical audit lines and the API / destructive rate limits were effectively halved.
- **Health checks and metrics work for hyphenated app IDs.** The health checker and metrics collector identified containers by splitting the name on `-`, so `customer-portal` was read as app `customer`: health checks were silently skipped (no `health_check_failed` alerts) and metrics were filed under the wrong app. Both now read the container's ownership labels first, as the container list already did.
- **Two CPU or memory alert rules on the same container no longer cancel each other.** Threshold timers were keyed by container only, so a stricter rule (e.g. 95%) reset a looser rule's (80%) timer on every snapshot and the looser rule never fired.
- **`/api/status/health` reports `database: "disconnected"` during a DB outage** instead of failing with a 500 and hiding the status grid.
- **The Docker event listener can no longer crash the process.** A failure while listing apps on (re)connect was an unhandled promise rejection; it now logs and retries.
- **Postgres: a dropped idle connection no longer crashes Overwatch.** The pool had no `error` listener, so a database restart or `pg_terminate_backend` on an idle pooled client threw an uncaught error.
- **Deleting a tenant keeps its env-var overrides if teardown fails.** Overrides were removed before `docker compose down`, so a failed delete (which refuses to drop the database and asks you to retry) had already lost them.
- **Database counts no longer include other prefixes' databases.** `_` in a `db_prefix` is a LIKE wildcard, so `a_b` also matched `aXb_…`.
- **`overwatch infra deploy` honours `DEPLOY_DIR`**, like every other command (the undocumented `OVERWATCH_DEPLOY_DIR` still works). The `overwatch update` example in docs/updating.md pointed `DEPLOY_DIR` one level too deep.
- **Creating a tenant from a backup uses the app's `default_image_tag`** when no tag is given, instead of forcing `latest`.
- **`/api/audit-logs` handles a repeated `?user=` and a negative `limit`** instead of returning an empty list.
- **Running from a `.env` file (`npm run dev` / `npm start`) loads it before modules read `JWT_SECRET`.** Container deployments, which pass env vars directly, were not affected.
- **Env-var keys with leading or trailing whitespace are rejected.** The key was trimmed for validation but stored untrimmed, so `" FOO"` could shadow `FOO` in `shared.env`.

### Security

- **Traefik label values can no longer start a new line in a tenant's `docker-compose.yml`.** Raw line breaks in `raw_labels` and middleware fields (editor-settable) are folded to a space, which is what YAML already did to a break inside a quoted value.
- **Editing a sensitive env var without re-sending the `sensitive` flag keeps it masked.** Previously the flag defaulted to `false`, exposing the stored secret to every viewer. Clearing the flag now also requires re-entering the value, so a caller can't reveal a secret the API never shows them, and `sensitive` must be a real boolean.
- **Reserved Traefik label keys can't be smuggled in through `raw_labels`.** Keys that differ from what compose and Traefik see passed the denylist: mixed case (`…routers.x.Rule`), a YAML escape (`…rul\x65`), an embedded `=` (compose splits there), or a non-ASCII look-alike that Traefik folds to ASCII. When labels are generated, raw label keys must now be plain ASCII (`A-Z a-z 0-9 . _ - [ ]`), and reserved keys are matched case-insensitively and dropped. The `com.overwatch.*` ownership labels (which monitoring now trusts) and `com.docker.*` are reserved too.
- **Viewers no longer receive notification-channel credentials.** `GET /api/monitoring/notifications` now returns only the webhook URL's scheme and masks header values for non-admins (and for any caller whose role can't be resolved); admins still get the full config they need to edit it.
- **Startup rejects the documented placeholder `JWT_SECRET` values** from `.env.example` and `docs/development.md`. They passed the length check while being public. **Deployments still using it will refuse to start until `JWT_SECRET` is replaced** (e.g. `openssl rand -hex 32`); all existing sessions are then invalidated.
- **Container restarts via `/api/status` are now audit-logged.**
- **MCP tools validate `appId` / `tenantId` with the same slug rule as the REST API.**
- **`overwatch init` writes `infrastructure/.env` and `overwatch/.env` with mode 0600**, and the legacy-format migration writes tenant `.env` files the same way tenant creation does (0600, atomic).
- **The tenant "access" link opens with `noopener`**, so the tenant app gets no `window.opener` handle on the admin tab.

### Changed

- `npm run build:all` (the CI gate) now runs the full `npm run build`, including template embedding, instead of bare `tsc`.
- Removed dead code: unused exports and types, an unused `services/index.ts` barrel, and two unused UI hooks. CLI commands share one set of colour constants and output helpers.

### Upgrade notes

- **Rotate `JWT_SECRET` before upgrading if it is still the `.env.example` placeholder.** Overwatch now refuses to start with `replace-with-at-least-32-random-characters` (or the old `docs/development.md` example `dev-secret-at-least-32-characters`) as its secret. Generate a new one (e.g. `openssl rand -hex 32`) and set it in `.env` before starting v1.7.2. Changing the secret signs every admin and MCP session out, so users sign in again.
- **Env-var writes are stricter.** `POST /api/apps/:appId/env-vars` returns 400 if `sensitive` is sent as anything other than a boolean. It also returns 400 for `sensitive: false` on an existing sensitive variable unless you send a new `value` in the same request. Callers that toggled the flag without a value need to re-send the value. A non-string `description`, and a non-boolean `sensitive` on tenant overrides, are also rejected with 400 (they used to be saved and then broke every later read of the env-var files).
- **Non-conforming `raw_labels` keys are dropped.** When labels are generated, a raw label key containing anything outside `A-Z a-z 0-9 . _ - [ ]` is dropped, and so is any key that matches a reserved key (`traefik.enable`, `…routers.*.rule`, `…tls`, `…entrypoints`, `…tls.certresolver`) case-insensitively, as is any `com.overwatch.*` or `com.docker.*` key. Previously a mixed-case reserved key passed through. Check your tenants' `raw_labels` for dropped keys and move them to the typed fields (`cert_resolver`, `host_aliases`, `middlewares`) where one exists.
- **MCP tools take slugs.** `appId` and `tenantId` must be lowercase slugs (`a-z`, `0-9`, `-`, max 63 characters), the same rule the REST API applies. MCP clients that passed other identifiers will get a validation error.

## [1.7.1] — 2026-08-06

### Fixed

- **Init container failures no longer pass as successful deploys.** Generated compose files emitted short-form `depends_on`, which only orders startup — it never waits for the dependency to finish and never checks its exit code. A migrator that died (e.g. `sh: drizzle-kit: not found`, exit 127) still let the backend start and report healthy against an un-migrated schema; the only symptom was a 500 on the one screen querying the missing column. Services depending on a service with `is_init_container: true` are now emitted as `condition: service_completed_successfully`, so a failed migration aborts `docker compose up` and leaves dependents unstarted. Non-init dependencies keep today's semantics via an explicit `condition: service_started` (Compose forbids mixing short and long form in one block). A `depends_on` naming an unknown service now fails compose generation with a message naming the app, service, and available services, instead of emitting a dangling reference.
- **Failed deploys report why they failed.** `docker compose` writes its fatal error after a wall of progress output, so the previous "first non-empty stderr line" heuristic reported noise — a gated init container failure surfaced as `level=warning msg="No services to build"`. Compose failures are now matched against known fatal signatures (`service "…" didn't complete successfully: exit N`, `dependency failed to start: …`, `Error response from daemon: …`), and tenant create/update attach the failed init container's exit code and log tail to the operator-visible error, collected before rollback destroys the container.

### Upgrade notes

- **Existing tenants are unaffected until their compose file is regenerated**, which happens only during a tenant update (`updateTenant`). There is no standalone re-render command, so a tenant that shipped against a dead migrator keeps its ungated compose file until you run an update — re-applying its current image tag is enough.
- **Init containers must be idempotent.** Compose starts a completed init container again on every `up`, including the `up -d --force-recreate` that a tenant update runs. A migration runner that errors when there is nothing to migrate previously failed harmlessly; it will now block the services that depend on it. Verify your init containers before re-rendering. See [docs/configuration.md](docs/configuration.md#init-containers-and-depends_on).

## [1.7.0] — 2026-06-01

### Added

- **Remote MCP server with OAuth 2.1.** Expose a Model Context Protocol server at `/mcp` for AI clients (Claude, etc.) to manage tenants over the network. Disabled by default; enable via the `mcp:` block in `overwatch.yaml` with `enabled: true` and `public_url` set to your externally reachable Overwatch URL. Implements OAuth 2.1 with PKCE (S256), reuses `JWT_SECRET` and `GOOGLE_CLIENT_ID` for credentials, and rate-limits both OAuth and MCP endpoints. Tools (`list_apps`, `list_tenants`, `get_tenant`, `update_tenant`, `start_tenant`, `stop_tenant`, `restart_tenant`) are role-gated by admin-users RBAC (read ops require viewer role, update + lifecycle ops require editor role). See [docs/mcp.md](docs/mcp.md).

## [1.6.18] — 2026-05-29

### Fixed
- **Tenant image cleanup.** After a successful `updateTenant`, the previous image tags that the regenerated compose no longer references are removed via `docker rmi`. Avoids unbounded disk growth from accumulated old tags. Safe across tenants: `rmi` fails harmlessly when another container still references the image, and `--images` is resolved by `docker compose config` so env interpolation is honored.

## [1.6.17] — 2026-05-22

### Fixed
- **CLI help side effects.** `overwatch update --help`, `overwatch self-update --help`, and simple lifecycle command help now print usage and exit before Docker, deploy-directory discovery, or GitHub release checks run.

## [1.6.16] — 2026-05-22

### Fixed
- **Renamed tenant updates.** Tenant updates now resolve registry and runtime identity from the requested app ID, not a stale per-tenant snapshot ID. Embedded image manifests are normalized the same way before being saved/applied, so renamed apps such as `hyperproduct` → `product` pull from the current repository instead of the old GHCR path.

## [1.6.15] — 2026-05-20

### Fixed
- **Documentation drift.** Removed stale GHCR GitHub App guidance, documented destructive API confirmation headers and current route coverage, clarified migration behavior, and aligned Docker-only development instructions with the Node 26 Dockerfile.
- **Release metadata.** Aligned `package-lock.json` with the `package.json` version.

## [1.6.14] — 2026-05-19

### Fixed
- **Express 5 SPA fallback.** `app.get('*', ...)` crashed at boot under Express 5 / path-to-regexp 8 with `PathError: Missing parameter name at index 1: *`. The catch-all is now `app.get('/*splat', ...)`.
- **Express 5 `req.params` typing.** `@types/express` 5 widened `ParamsDictionary` to `{ [key: string]: string | string[] }`, breaking ~55 destructure sites in `src/routes/*` and `src/middleware/*`. All sites now cast `req.params` to `Record<string, string>` at access (every route uses single-value `:slug` placeholders).
- **Login error feedback.** `LoginPage` swallowed sign-in failures into `console.error`; users whose email was missing from the admin allowlist saw nothing happen. Errors now surface as a `sonner` toast.
- **CodeQL real findings (7).** Prototype-pollution guard added to `setNestedValue` in `cli/config/edit.ts`; `EMAIL_RE` and `parseLockInfo` regexes hardened against polynomial backtracking; legacy `public/` (containing XSS sinks) deleted in favour of the React UI in `ui/dist/`.

### Changed
- **Dependency major bumps.** UI: React 18 → 19, react-dom 18 → 19, Vite 6 → 8, `@vitejs/plugin-react` 4 → 6, TypeScript 5 → 6, Tailwind CSS 3 → 4 (with `@import "tailwindcss"` + `@config` migration), react-router-dom 6 → 7, sonner 1 → 2, tailwind-merge 2 → 3, vitest 3 → 4, `@types/react`/`@types/react-dom` 18 → 19, `@types/node` 20 → 25. Backend: Express 4 → 5, `@types/express` 4 → 5, inquirer 8 → 13, dotenv 16 → 17, dockerode 4 → 5, google-auth-library 9 → 10. Container base image: `node:22-alpine` → `node:26-alpine`. GitHub Actions: checkout 4 → 6, setup-node 4 → 6, metadata-action 5 → 6, build-push-action 5 → 7, codeql-action 3 → 4, `delete-package-versions` pinned by full commit SHA.

### Added
- **Test workflow on PRs.** `.github/workflows/test.yml` runs `npm test` + `npm run build:all` on every PR and push to `main`, on Node 22 with npm caching. Required status check on `main`.
- **CodeQL security-extended.** `.github/workflows/codeql.yml` analyses both `javascript-typescript` and `actions`. Required status check on `main`.
- **Branch protection.** `main` enforces PR-only, squash-only, linear history; no force-push, no deletion.
- **Community health.** `SECURITY.md` (vulnerability disclosure), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `CONTRIBUTING.md`, issue + PR templates, README badges, Dependabot config for npm + GitHub Actions + Docker.

## [1.6.13] — 2026-05-11

### Fixed
- **Database dumps for non-trivial DBs.** `MySQLAdapter.dumpDatabase` and `PostgresAdapter.dumpDatabase` buffered the entire `mysqldump`/`pg_dump` stdout in memory (`execFile` with `maxBuffer: 100 MB`). Dumps larger than 100 MB crashed Overwatch with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`; smaller-but-still-multi-MB dumps caused memory pressure. Both adapters now stream stdout directly to the output file via `spawn` + pipe, matching the existing `restoreDatabase` pattern. No upper bound on dump size.

### Added
- **`R2_ENDPOINT` as a first-class .env variable.** The generated Overwatch compose now emits `R2_ENDPOINT: ${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}`. Existing deploys keep working unchanged (fallback constructs the non-jurisdictional URL from `R2_ACCOUNT_ID`). Operators on EU / FedRAMP / other jurisdictional buckets can now set `R2_ENDPOINT` explicitly in `overwatch/.env` instead of relying on the constructed URL — required for `<account>.eu.r2.cloudflarestorage.com` buckets.

## [1.6.12] — 2026-05-11

### Fixed
- **Compose env quoting:** `OVERWATCH_UID`, `OVERWATCH_GID`, and `cpus` in the generated `overwatch/docker-compose.yml` were emitted with extra inner double quotes (e.g. `cpus: "\"1.0\""`). Docker Compose rejected the file on parse. Quotes are now single-layer.
- **Missing env passthroughs:** the dynamic generator dropped `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GOOGLE_CLIENT_SECRET` from the Overwatch container env even though the static template had them. Without them, an Overwatch container generated by `overwatch infra deploy` couldn't authenticate to GHCR via GitHub App or accept Google sign-in. All four are now passed through.

These were pre-existing bugs latent in 1.6.9; surfaced during the first `overwatch infra deploy` on a fresh nginx-front host.

## [1.6.11] — 2026-05-11

### Fixed
- **Empty `certificatesResolvers` rejected by Traefik v3:** when `traefik.tls_termination=upstream` was set with no `cert_resolvers`, `traefik.yml` contained `certificatesResolvers: {}` which Traefik refused to load (`command traefik error: certificatesResolvers cannot be a standalone element`). The key is now omitted entirely when no resolvers are configured.

Regression introduced in 1.6.10.

## [1.6.10] — 2026-05-11

### Added
- **`host_port` and `host_bind` on entrypoints** (schema + generator). Controls the compose `ports:` mapping for Traefik so it can publish on a non-default host port or loopback address. Use case: an upstream nginx on the same host owns 80/443 and proxies to Traefik on `127.0.0.1:8080`. See `docs/traefik.md` § "Behind an upstream SSL terminator".

### Changed
- `buildInfraComposeYml` and `shouldUseDynamicTraefik` now accept `traefik.tls_termination='upstream'` without requiring `cert_resolvers`. Upstream-only deploys (nginx terminates TLS) don't need ACME.
- Static `traefik.yml` entrypoint default honors `tls_termination=upstream` — emits a single `web` entrypoint instead of `web` + `websecure`.

### Fixed
- **Overwatch admin labels under upstream mode:** `buildOverwatchLabels` and `legacyOverwatchLabels` previously hardcoded `entrypoints=websecure` and `tls=true`. With `tls_termination=upstream`, the admin UI was unreachable (Traefik would try to terminate TLS for the admin host without a cert). Labels now respect `tls_termination` — drop `tls=true` and `certresolver=*`, route to `upstream_entrypoint` (default `web`).

### Compatibility
Existing deploys with `cert_resolvers` (every production deploy today) produce byte-identical generator output to 1.6.9. New behavior only activates when an operator opts into `tls_termination: upstream`. Verified by `src/__tests__/regression-v1.6.10.test.ts`.

[1.6.17]: https://github.com/marwain91/overwatch/compare/v1.6.16...v1.6.17
[1.6.16]: https://github.com/marwain91/overwatch/compare/v1.6.15...v1.6.16
[1.6.15]: https://github.com/marwain91/overwatch/compare/v1.6.14...v1.6.15
[1.6.14]: https://github.com/marwain91/overwatch/compare/v1.6.13...v1.6.14
[1.6.13]: https://github.com/marwain91/overwatch/compare/v1.6.12...v1.6.13
[1.6.12]: https://github.com/marwain91/overwatch/compare/v1.6.11...v1.6.12
[1.6.11]: https://github.com/marwain91/overwatch/compare/v1.6.10...v1.6.11
[1.6.10]: https://github.com/marwain91/overwatch/compare/v1.6.9...v1.6.10
