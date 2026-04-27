# Traefik configuration

From v1.6 Overwatch ships a first-class Traefik configuration surface. Cert resolvers, the global middleware library, the dashboard, Overwatch's own routing, and per-tenant overrides all live under one schema and are editable from three places:

- **Web UI** — Sidebar → Traefik (admin only). Tabs: Cert Resolvers, Middlewares, Dashboard, Overwatch Server.
- **REST API** — `/api/traefik/*` and `/api/apps/:appId/traefik`, `/api/apps/:appId/tenants/:tenantId/traefik`.
- **CLI** — `overwatch config traefik [view|resolver|migrate|reload]`.

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

For anything not modeled, set `raw_labels: { "traefik.…": "value" }` on the service or tenant. The denylist below is enforced by Zod refinement, so all three editing surfaces produce the same error.

### Denylist

These keys are reserved and rejected at validation time:

- `traefik.enable`
- `traefik.http.routers.*.rule`
- `traefik.http.routers.*.tls.certresolver`
- `traefik.http.routers.*.entrypoints`
- `traefik.http.routers.*.tls`

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
      port: 80
      forwarded_headers:
        # CIDRs of upstream proxies whose X-Forwarded-* headers Traefik should trust.
        # Without this, Traefik strips them and apps see the upstream's IP.
        trusted_ips: ["10.0.0.0/8", "172.16.0.0/12"]
      proxy_protocol:
        # PROXY protocol v1/v2 for HAProxy / AWS NLB. Optional.
        trusted_ips: ["10.0.0.0/8"]
      # No `redirect_to` — the upstream already terminates HTTPS.
```

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

## Migration from `networking.cert_resolvers`

```bash
# Walks you through provider, acme email, wildcard pattern, env var name.
overwatch config traefik migrate
overwatch infra deploy
overwatch config traefik reload
```

The shim that synthesizes the legacy two-slot config into `traefik.cert_resolvers` is removed in the next major release.
