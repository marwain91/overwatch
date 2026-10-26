# App URL and IP access control

An app can allowlist or blacklist URL paths, client IPs, or combinations of both. Configure `traefik.access_control` in the app definition, or open **App Settings → Traefik → URL and IP access rules** as an admin. The policy covers every routed service and every tenant host/alias of that app, including tenants on older image versions.

## Private app with public URL exceptions

This example allows public health checks and one webhook endpoint, permits office/VPN networks to reach the rest of the app, and denies all other requests:

```json
{
  "traefik": {
    "access_control": {
      "default_action": "deny",
      "rules": [
        {
          "description": "Public health check",
          "action": "allow",
          "path_regex": "^/health$"
        },
        {
          "description": "Public provider webhook",
          "action": "allow",
          "path_regex": "^/api/webhooks/provider$"
        },
        {
          "description": "Office and VPN",
          "action": "allow",
          "source_ranges": ["203.0.113.0/24", "2001:db8:1234::/48"]
        }
      ]
    }
  }
}
```

Merge this `access_control` field into your existing app's `traefik` object; retain any existing `middlewares` and `default_middlewares`. The ranges above are documentation examples: replace them with your real public office/VPN egress addresses, including IPv6 if your clients use it. Private LAN addresses such as `10.0.0.0/8` only work when those are actually the addresses Traefik receives.

| Request | Office/VPN IP | Any other IP |
| --- | --- | --- |
| `/health` | Allow | Allow |
| `/health?verbose=1` | Allow | Allow |
| `/api/webhooks/provider` | Allow | Allow |
| `/health/admin` | Allow | Deny |
| `/api/webhooks/provider-extra` | Allow | Deny |
| `/`, `/login`, `/api/users` | Allow | Deny |

“Allow” passes this access policy. Existing authentication, rate limits, headers, and other middleware still run. Application login and webhook signature verification still apply. For a public web page, also allow the assets and API endpoints that page needs, or it may load HTML but fail to render.

## Evaluation and precedence

1. Traefik chooses the service using its existing host, path-prefix, and priority rules. Policies retain the original priority, including an explicitly configured priority.
2. The chosen service evaluates the app's rules **from top to bottom**. The **first matching rule wins**.
3. Within one rule, `path_regex` **AND** `source_ranges` must match if both are supplied. Multiple entries in `source_ranges` are alternatives (**OR**).
4. An omitted path condition matches every path. An omitted IP condition matches every client IP. A rule must have at least one condition.
5. If no rule matches, `default_action` decides.

A deny rule has no automatic precedence over an allow rule. Put an unconditional block before broader allows if it must apply even to office users. Put a deliberate exception before a broader deny if it should win. Rule descriptions are comments for operators and do not affect matching.

Denied requests are explicitly handled by Traefik with HTTP **403**, rather than simply removing the service's matching route. This prevents a denied API request from falling through to a frontend catch-all. Entrypoint middleware executes before router middleware, so an entrypoint authentication gate or redirect may respond first.

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `default_action` | Yes | `"allow"` or `"deny"` when no rule matches |
| `rules` | Yes | Ordered list, up to 50 rules; an empty list uses only the fallback |
| `rules[].action` | Yes | `"allow"` or `"deny"` |
| `rules[].description` | No | Operator note, up to 200 characters |
| `rules[].path_regex` | At least one condition | Go/RE2 path regex, 1–1,024 characters, one line |
| `rules[].source_ranges` | At least one condition | 1–100 IPv4/IPv6 addresses or CIDRs |

Single IPs such as `203.0.113.42` and `2001:db8::42` are accepted alongside CIDRs. IPv4 prefixes must be 0–32 and IPv6 prefixes 0–128. Hostnames, dash-separated address ranges, ports, and IPv6 zone IDs are not accepted. `0.0.0.0/0` covers all IPv4 clients and `::/0` covers all IPv6 clients; use both when you intend both families.

With no `access_control` field, there is no additional app policy. An enabled policy with `default_action: "deny"` and `rules: []` blocks the whole app. An enabled policy with `default_action: "allow"` and `rules: []` permits everything through this policy.

## Path regex rules

Paths use [Traefik's Go-style `PathRegexp` matching](https://doc.traefik.io/traefik/v3.6/routing/routers/#path-pathprefix-and-pathregexp). The regex matches the request path Traefik sees, before any service `strip_prefix`, `replacePath`, or other router middleware runs. It does not include the scheme, hostname, port, query string, or fragment. A backend mounted at `/api` therefore needs `^/api/webhooks/provider$`, even if the backend internally sees `/webhooks/provider`.

Matching is case-sensitive and searches for a match anywhere unless you anchor the expression:

| Intent | Regex |
| --- | --- |
| Exactly `/health` | `^/health$` |
| `/health` with an optional trailing slash | `^/health/?$` |
| `/public` and its descendants, excluding `/publicity` | `^/public(/|$)` |
| Only descendants of `/public/` | `^/public/` |
| Either of two exact paths | `^/(health|ready)$` |
| Numeric shared-resource IDs | `^/api/share/[0-9]+$` |
| Literal `.json` suffix | `^/public/[^/]+\.json$` |
| Case-insensitive health endpoint | `(?i)^/health$` |

The table shows regex text as entered in the UI. JSON requires escaping backslashes: the `.json` example becomes `"^/public/[^/]+\\.json$"`. YAML single quotes preserve backslashes: `path_regex: '^/public/[^/]+\.json$'`. Use plain regex text without JavaScript `/.../` delimiters or a trailing `g`/`i` flag. Go flags such as `(?i)` go inside the expression. Lookahead, lookbehind, and backreferences are unsupported; use ordered rules to express exceptions.

The proxy and application may normalize or decode paths differently. Verify percent-encoded paths, duplicate slashes, dot segments, case, and trailing slashes against your actual ingress and application. These rules do not restrict HTTP methods: allowing a path permits every method on that path through the policy, including `OPTIONS`. A URL fragment never reaches the server. Use application authorization for permissions that depend on users, methods, resource ownership, headers, or query parameters.

## URL blacklist with a public default

Leave the app public while blocking selected URL trees for everyone:

```json
{
  "default_action": "allow",
  "rules": [
    { "action": "deny", "path_regex": "^/(internal|debug)(/|$)" },
    { "action": "deny", "path_regex": "^/api/admin/export$" }
  ]
}
```

Use that object as `traefik.access_control`. `/internal`, `/internal/logs`, `/debug`, and the exact export endpoint are denied. `/internal-tools` remains allowed because the regex requires a path boundary.

To allow the office to use `/internal` while blocking it for everyone else, place a rule with `action: "allow"`, `path_regex: "^/internal(/|$)"`, and the office `source_ranges` **before** the deny rule. Both conditions must match, so the office exception does not accidentally grant access to other paths.

## IP blacklist and partner-specific endpoints

Block an IP range across the whole app by using an IP-only deny before broader allows:

```json
{
  "default_action": "allow",
  "rules": [
    { "action": "deny", "source_ranges": ["198.51.100.0/24", "2001:db8:bad::/48"] }
  ]
}
```

A private app can expose a partner webhook only to that partner's IP ranges while keeping a health check public:

```json
{
  "default_action": "deny",
  "rules": [
    { "action": "deny", "path_regex": "^/(internal|debug)(/|$)" },
    { "action": "allow", "path_regex": "^/health$" },
    {
      "action": "allow",
      "path_regex": "^/api/webhooks/partner$",
      "source_ranges": ["192.0.2.0/24"]
    },
    { "action": "allow", "source_ranges": ["203.0.113.0/24", "2001:db8:1234::/48"] }
  ]
}
```

Here the internal/debug block also applies to the office; the health check is public; the partner can reach only its webhook; and the office can reach everything except the blocked trees.

## Client IPs behind proxies

IP conditions use [Traefik's `ClientIP` matcher](https://doc.traefik.io/traefik/v3.6/routing/routers/#clientip). This uses the address of the connection to Traefik and **ignores `X-Forwarded-For`**, even when `forwarded_headers.trusted_ips` is configured. Sending that header cannot turn an outside client into an allowed client.

- **Direct connections:** use the public client/office/VPN IP seen by Traefik. NAT may cause several users to share that IP.
- **Trusted PROXY protocol ingress:** configure the entrypoint's `proxy_protocol.trusted_ips` to the actual load balancer addresses, and configure the load balancer to send PROXY protocol. The original client address then reaches the matcher. See [TLS termination and proxy settings](traefik.md#behind-an-upstream-ssl-terminator).
- **HTTP reverse proxy, CDN, or tunnel:** without preserved connection addresses or PROXY protocol, Traefik sees the upstream proxy's IP. Allowing that range grants access to every client relayed through that proxy. Enforce end-user IP restrictions at that upstream layer, or use a suitable trusted authentication service. The URL-only rules still work.

Do not move an existing `ipAllowList` middleware into a “public” policy exception and expect the middleware to be bypassed: the two restrictions are cumulative. When migrating, move the intended app IP restrictions into this policy and deliberately remove their previous middleware references. Global middleware restrictions remain in force and cannot be bypassed by an app allow rule or tenant override. If your current IP middleware depends on `ipStrategy` and forwarded headers, it cannot be replaced by these IP matcher rules without changing which address is checked.

## Save, apply, and verify

1. Sign in as an admin and open the app's settings. Select **Edit access rules**, enable the policy, and add or reorder rules. The private-app example uses documentation IP ranges; replace them before saving.
2. Select the fallback action and save. Invalid regexes, IPs, empty match conditions, and oversized policies are rejected.
3. For **each existing tenant**, use Overwatch's **Restart** action (Start for a stopped tenant, or Tenant Update). This regenerates Compose and recreates containers with changed labels. Saving the app does not immediately change running containers. Running `docker compose up -d` against an old generated file does not regenerate its policy.
4. Test from an allowed network and a separate outside network, including IPv6 where available. Verify public paths, private paths, blocked paths, trailing slash variants, and the tenant's aliases. Outside requests to denied paths should receive 403 from the proxy; permitted requests should reach normal app/auth handling.
5. To remove the policy, disable it in the editor or omit `access_control` from the saved app `traefik` object, then restart affected tenants again. Removing the current policy also clears any stale policy in their frozen snapshots on regeneration.

For automation, the admin-only `PUT /api/apps/:appId/traefik` endpoint accepts the app's **complete** Traefik object, including `access_control`; preserve the existing middleware library/defaults when updating it. `GET` on the same endpoint returns the saved policy. The full app-definition API and `overwatch apps apply` accept the same field. Tenant routing overrides cannot replace or disable this app policy, and image-embedded manifests cannot overwrite the admin-owned `traefik` object.

Access control applies to traffic passing through these generated Traefik routers. Keep backend ports off public host bindings, and account for any separate ingress paths. Policies are app-wide; they currently have no per-tenant override or service selector. Existing service path prefixes still determine which service owns an allowed URL; an allow rule does not publish an otherwise unrouted endpoint.
