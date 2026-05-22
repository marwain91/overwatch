# Changelog

All notable changes to Overwatch will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
