# Changelog

All notable changes to Overwatch will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
