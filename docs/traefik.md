# Traefik configuration

From v1.6 Overwatch ships a first-class Traefik configuration surface. Cert resolvers, the global middleware library, the dashboard, Overwatch's own routing, and per-tenant overrides all live under one schema and are editable from three places:

- **Web UI** — Sidebar → Traefik (admin only): Cert Resolvers, Middlewares, Entrypoints, Dashboard, Overwatch Server. Per-app middleware library is on the App Settings page; per-tenant overrides live behind the **Routing** action on each tenant row.
- **REST API** — `/api/traefik/*` and `/api/apps/:appId/traefik`, `/api/apps/:appId/tenants/:tenantId/traefik`.
- **CLI** — `overwatch config traefik [view|resolver|migrate|reload|doctor]`.

Sensitive cert-resolver env values are masked on read in all three surfaces. The legacy `networking.cert_resolvers` field is shimmed automatically for backwards compatibility — operators upgrade with `overwatch config traefik migrate`.

## Schema

```yaml
traefik:
  log_level: INFO

  cert_resolvers:
    - name: cf-prod
      challenge: dns
      provider: cloudflare        # any DNS provider Traefik supports
      acme_email: ops@example.com
      env: { CF_DNS_API_TOKEN: ${CF_TOKEN} }
      domain_patterns: ["*.app.example.com"]
    - name: gandi-eu
      challenge: dns
      provider: gandi
      acme_email: ops@example.com
      env: { GANDI_API_KEY: ${GANDI_KEY} }
      domain_patterns: ["*.example.eu"]
    - name: http
      challenge: http
      acme_email: ops@example.com
      entrypoint: web

  middlewares:
    admin-auth: { type: basicAuth, users: ["admin:$apr1$REPLACE"] }
    hsts: { type: headers, sts_seconds: 31536000, sts_include_subdomains: true, sts_preload: true }
    api-rl: { type: rateLimit, average: 200, burst: 400 }

  default_middlewares: [hsts]

  dashboard:
    enabled: true
    host: "traefik.example.com"
    cert_resolver: cf-prod
    middlewares: [admin-auth]

  overwatch:
    host: "overwatch.example.com"
    cert_resolver: cf-prod
    middlewares: [admin-auth]
```

## Cert-resolver selection

When a tenant is created or its compose is regenerated:

1. If the tenant has an explicit `cert_resolver`, use it.
2. Otherwise, match the tenant's domain against every resolver's `domain_patterns`. Longest pattern wins on ties.
3. Otherwise, the first resolver with `challenge: http` and no patterns is the implicit fallback.
4. If nothing matches, tenant create/update fails with a clear error — Overwatch never silently picks a wrong cert.

## Middlewares

Overwatch ships typed schemas for the most common middlewares:

| Type | Notes |
|---|---|
| `rateLimit` | `average`, `burst`, `period` |
| `basicAuth` | htpasswd-style `users[]` |
| `forwardAuth` | `address`, `auth_response_headers`, etc. |
| `ipAllowList` | `source_range[]` (CIDRs) |
| `headers` | HSTS, custom request/response headers, content-type-nosniff, frame-deny, referrer policy |
| `redirectScheme` | `scheme`, `port`, `permanent` |
| `redirectRegex` | `regex`, `replacement`, `permanent` |
| `compress` | `excluded_content_types`, `min_response_body_bytes` |
| `retry` | `attempts`, `initial_interval` |
| `circuitBreaker` | `expression` |
| `replacePath` / `replacePathRegex` | basic + regex variants |
| `inFlightReq` | `amount` |
| `chain` | `middlewares[]` (compose other middlewares) |

For anything not modeled, set `raw_labels: { "traefik.…": "value" }` on the service or tenant. Raw labels may only address the tenant's own Traefik objects (see below). The reserved-key list is enforced by Zod refinement; ownership is enforced when raw labels are saved through the API or `overwatch apps apply` (HTTP 400 naming the key) and again when the compose file is generated.

Label values (raw labels and typed middleware fields alike) reach the tenant's `docker-compose.yml` verbatim, backslashes and quotes included, so a regex such as `^https://(.*)\.example\.com` arrives at Traefik unchanged. Line breaks are folded to a space, and `$` is still subject to Docker Compose variable interpolation.

### Ownership

For a service `web` of app `myapp` on tenant `acme`, the router is named `myapp-acme-web`. Raw labels (app-level and tenant-level) may only use:

- `traefik.http.routers.myapp-acme-web.*`
- `traefik.http.services.myapp-acme-web.*`
- `traefik.http.middlewares.myapp-acme-web-<name>.*`, where `<name>` is a single token of letters, digits and `_` (no hyphen). Slugs may contain hyphens but never `_`, so this cannot collide with the middlewares of another tenant whose router name extends this one (e.g. tenant `acme-web-x`). Use `rate_limit`, not `rate-limit`.

Everything under `traefik.tcp.` / `traefik.udp.` and every other `traefik.*` key (other routers, services or middlewares, `serverstransports`, ...) is dropped at generation time with a `[traefik] dropped raw label` warning, and rejected with HTTP 400 when saved. App-level raw labels are rendered once per tenant, so the same per-tenant names apply; at save time any `myapp-<tenant>-web` is accepted for service `web`. A router's `service` field may only name its own service, and on its own service only `loadbalancer.*` options are allowed, except `loadbalancer.server(s).url` (would point the tenant's host at an arbitrary backend) and `loadbalancer.serverstransport` (could reference a foreign transport). `weighted`, `mirroring` and `failover` services are denied because they can name another tenant's service. `port`, `scheme`, `sticky`, `healthcheck`, `passhostheader` etc. are fine. Labels that are not `traefik.*` (for example `com.example.*`) are passed through.

Own middlewares are restricted to types that cannot address another service, a URL or a file: `headers`, `ratelimit` (not `ratelimit.redis`), `inflightreq`, `compress`, `retry`, `ipallowlist`/`ipwhitelist`, `redirectscheme`, `redirectregex`, `stripprefix`, `stripprefixregex`, `addprefix`, `replacepath`, `replacepathregex`, `buffering`, `contenttype`, `passtlsclientcert`, `grpcweb`, and `basicauth`/`digestauth` with `users`, `realm`, `removeheader` and `headerfield` only (not `usersfile`). `errors`, `forwardauth`, `chain`, `plugin` and anything else are denied; define those through typed middlewares at the app or global level. A router's `middlewares` raw label may only list the router's own middlewares (`@docker` optional) and the typed middlewares Overwatch generates for it; `@file`, `@internal` and other tenants' middlewares are rejected. `routers.<own>.tls.*` (for example `tls.options`) is denied.

Host alias checks fail closed: if the configuration, the app, the apps directory or another tenant's `.env`/`traefik.yaml` cannot be read (a genuinely missing file or directory counts as empty), saving an alias fails and generation drops all of the tenant's aliases with a warning.

Stored data is not rejected on load: non-conforming labels already on disk are simply not emitted.

### Denylist

These keys are reserved and rejected at validation time:

- `traefik.enable`
- `traefik.http.routers.*.rule`
- `traefik.http.routers.*.tls.certresolver`
- `traefik.http.routers.*.entrypoints`
- `traefik.http.routers.*.tls` (including `tls.domains`)

Indexed spellings such as `entrypoints[0]` are covered too.

Matching is case-insensitive. At generation time, a raw label key containing characters outside `A-Z a-z 0-9 . _ - [ ]` is dropped, as is any reserved key, so escaped or non-ASCII spellings of a reserved key cannot slip through. `com.overwatch.*` (container ownership) and `com.docker.*` keys are reserved the same way.

Use the typed fields (`cert_resolver`, `host_aliases`, `middlewares`) instead — they cover the same ground without breaking multi-tenancy invariants.

## Per-app middleware library

Define middlewares once on the app, then reference them from any service:

```jsonc
// data/apps.d/myapp.json
{
  "id": "myapp",
  "traefik": {
    "middlewares": {
      "strict-rl": { "type": "rateLimit", "average": 50, "burst": 100 }
    },
    "default_middlewares": ["hsts"]
  },
  "services": [
    {
      "name": "web",
      "routing": {
        "middlewares": ["strict-rl"]
      }
    }
  ]
}
```

The app definition rides in the app's frozen tenant snapshot (v1.5.5), so middleware library changes only affect a tenant on the next `tenant update`.

## Per-tenant overrides

```yaml
# apps/myapp/tenants/acme/traefik.yaml
cert_resolver: gandi-eu              # explicit override of the auto-pick
host_aliases:
  - "legacy.acme.com"
middleware_overrides:
  web: ["strict-rl", "ip-allowlist-corp"]   # REPLACES the app's middleware list for this service
raw_labels:
  web:
    "traefik.http.routers.myapp-acme-web.observability.tracing": "true"
```

`host_aliases` add extra `Host()` matchers on the tenant's routers, so they are checked when saved (HTTP 400) and again when the compose file is generated (a failing alias is dropped with a warning). An alias must:

- be a valid hostname;
- not be a host Overwatch serves itself: the `traefik.overwatch.host`, the host of `mcp.public_url`, or the `traefik.dashboard.host`;
- not equal the domain or alias of any other tenant;
- when the app's `domain_template` is a wildcard (`*.example.com`), lie inside that pattern or inside a domain listed in the optional `traefik.allowed_alias_domains` (default: empty, so only hosts matching the template are accepted):

```yaml
# overwatch.yaml
traefik:
  allowed_alias_domains:
    - partner.example.org   # also allows www.partner.example.org
```

Override semantics: `middleware_overrides` is a full replacement, not a merge. `raw_labels` are merged on top of the generated and app-level labels (denylist enforced after merge).

## Operational notes

- **Reload Traefik** after changing cert resolvers, entrypoints, or the dashboard config — the static config in `traefik.yml` is read at start. Use the **Reload Traefik** button in the UI, `overwatch config traefik reload`, or `docker restart <prefix>-traefik`.
- **Per-tenant changes** (middleware overrides, raw labels, host aliases) only require `docker compose up -d` on that tenant.
- **`overwatch infra deploy`** regenerates `traefik.yml`, `dynamic.yml`, the infrastructure compose, and the Overwatch compose from the global config. For legacy installs, it keeps the static templates.
- **Frozen snapshots**: each tenant has a frozen copy of its app definition (incl. `traefik.middlewares`). Middleware changes don't affect existing tenants until you explicitly `tenant update`.

## Behind an upstream SSL terminator

Some setups place Overwatch behind another reverse proxy that handles TLS — Cloudflare full-strict, AWS ALB / NLB, an upstream nginx or HAProxy, even another Traefik. v1.6.1 supports this with three knobs:

```yaml
traefik:
  tls_termination: upstream     # global default. Per-service and per-tenant overrides win.
  upstream_entrypoint: web      # name of the entrypoint Traefik listens on (default: web)

  entrypoints:
    - name: web
      port: 80                       # container-side port Traefik listens on
      host_port: 8080                # host-side published port (optional; defaults to `port`)
      host_bind: "127.0.0.1"         # host-side bind address (optional; defaults to "0.0.0.0")
      forwarded_headers:
        # CIDRs of upstream proxies whose X-Forwarded-* headers Traefik should trust.
        # Without this, Traefik strips them and apps see the upstream's IP.
        trusted_ips: ["127.0.0.1/32"]
      proxy_protocol:
        # PROXY protocol v1/v2 for HAProxy / AWS NLB. Optional.
        trusted_ips: ["10.0.0.0/8"]
      # No `redirect_to` — the upstream already terminates HTTPS.
```

`host_port` and `host_bind` (v1.6.10+) control the compose `ports:` mapping for Traefik. Use them when the host already has another process on 80/443 — e.g. an upstream nginx terminating TLS with pre-issued certs and proxying to Traefik on loopback. Omit both to publish on `0.0.0.0:port`.

When `tls_termination: upstream` is in effect for a router, the generator:

- Routes the service to `upstream_entrypoint` (default `web`) instead of `websecure`.
- Drops `tls=true` and `tls.certresolver` from the labels — Traefik will not try to manage certs for that route.

**Mixed mode is supported.** You can keep `tls_termination: traefik` globally (so Overwatch's own admin and most tenants terminate at Traefik with Let's Encrypt) and set `tls_termination: upstream` on specific tenants that sit behind Cloudflare. Cert resolvers stay defined and usable.

### Per-service / per-tenant override

```jsonc
// data/apps.d/myapp.json — service-level override
{
  "services": [
    { "name": "web", "routing": { "tls_termination": "upstream" } }
  ]
}
```

```yaml
# apps/myapp/tenants/cf-tenant/traefik.yaml — tenant-level override (wins over service)
tls_termination: upstream
```

### Common topologies

| Upstream | What to set |
|---|---|
| **Cloudflare full / full-strict** | `tls_termination: upstream`, `forwarded_headers.trusted_ips: [<Cloudflare IPs>]`, omit `redirect_to` on `web` |
| **AWS ALB** | `tls_termination: upstream`, `forwarded_headers.trusted_ips: [<VPC CIDR>]` |
| **AWS NLB / HAProxy with PROXY** | as above, plus `proxy_protocol.trusted_ips` |
| **Upstream nginx terminating TLS** | `tls_termination: upstream`, `forwarded_headers.trusted_ips: [<nginx IP>]` |
| **Direct (default)** | leave `tls_termination` unset; Traefik manages certs via `cert_resolvers` |

After changing entrypoint config or `tls_termination`, run **Reload Traefik** (UI button or `overwatch config traefik reload`) — those settings are read at start-time.

## Validation: `overwatch config traefik doctor`

Cross-check the resolved Traefik configuration against the loaded apps and tenant overrides:

```bash
overwatch config traefik doctor
```

Reports errors (exit 1) and warnings (exit 0) for:

- Middleware references that don't resolve in any of `traefik.middlewares`, `app.traefik.middlewares` (per-app library), or tenant `middleware_overrides`.
- Tenant `cert_resolver` overrides that point to a resolver name that isn't defined.
- Cert-resolver `env: { KEY: ${VAR} }` entries where `VAR` is missing from the deploy `.env` and `process.env`.
- `tls_termination: upstream` on the global config when the chosen `upstream_entrypoint` either isn't defined or has no `forwarded_headers.trusted_ips` configured.
- `cert_resolvers` lacking a fallback (no `challenge: http` resolver without patterns AND no resolver with a `*` pattern) — every tenant domain must match an explicit pattern, otherwise tenant-create fails.
- Cert resolvers still carrying placeholder values from the legacy `networking.cert_resolvers` shim — i.e. you haven't run `overwatch config traefik migrate` yet.

The same checks are pure functions (`validateTraefik` in `src/services/traefikDoctor.ts`) so a CI hook or REST endpoint can use them.

## Migration from `networking.cert_resolvers`

```bash
# Walks you through provider, acme email, wildcard pattern, env var name.
overwatch config traefik migrate
overwatch infra deploy
overwatch config traefik reload
```

The shim that synthesizes the legacy two-slot config into `traefik.cert_resolvers` is removed in the next major release.
