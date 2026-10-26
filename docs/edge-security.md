# Managed Nginx edge

Overwatch optionally manages an existing host Nginx proxy in front of Traefik. Existing installations do not change until configured and deployed. Requirements: Nginx 1.25.1+, a running master, operator-managed certificates, and exactly one `include /etc/nginx/conf.d/*.conf;` in the main config's `http` block. This does not install packages or change firewall/SSH settings.

Use this when Nginx receives the real connection but Traefik sees a Docker gateway. Rules use the TCP peer IP, never client-supplied forwarding headers. Keep Traefik loopback-only. A CDN/upstream proxy requires a separately reviewed client-IP design.

## Example

```yaml
edge:
  enabled: true
  upstream: http://127.0.0.1:8080
  tls:
    certificate: /etc/ssl/example/fullchain.pem
    certificate_key: /etc/ssl/example/private.key
  access_log: /var/log/nginx/overwatch-edge-access.log
  adopt_files: [product.conf, default.conf]
  sites:
    - name: product
      host: product.example.com
      access_control:
        default_action: deny
        rules:
          - action: allow
            source_ranges: [10.0.0.0/8, 203.0.113.42/32]
          - action: allow
            path_regex: '^/portal(/|$)'
            methods: [GET, HEAD]
          - action: allow
            path_regex: '^/portal-public(/|$)'
          - action: allow
            path_regex: '^/(assets|logos)/'
            methods: [GET, HEAD]
      request_limits:
        - name: portal_auth
          path_regex: '^/portal-public/p/[^/]+/auth/(magic-link|verify(/peek)?)/?$'
          methods: [POST]
          requests_per_second: 2
          burst: 20
```

Replace example IPs. First matching rule wins; conditions within a rule use AND, IP/method lists use OR. Omitted conditions match everything; at least one condition is required. Regexes use validated RE2-compatible syntax compiled by Nginx and match its **normalized, decoded `$uri` without query strings**, unlike Traefik's original-path matching. Test encoded paths during migration. Unknown fields, invalid CIDRs/regexes, duplicate hosts/names and unsafe filenames are rejected.

Public pages need API, branding and asset exceptions too. Restrict published uploads to exact paths. Cloud MCP exceptions should permit only transport, exact OAuth endpoints and discovery URLs from verified provider CIDRs. Browser login/consent stays on allowed user networks. Application authentication and authorization remain required.

Request limits use peer IPs and only selected paths/methods. `exempt_ranges` optionally exempts trusted sources. Excess requests return 429; bursts pass without delay. No blanket request/connection limits are imposed on shared office/cloud NAT or MCP streaming. Use application account-level limits too. Sites default to a 100 MB body limit and 300-second upstream read timeout, configurable with `max_body_size_mb` and `proxy_read_timeout_seconds`.

Generated settings provide TLS 1.2/1.3, disabled session tickets, hidden edge versions and upstream `X-Powered-By`, bounded header/body/send timeouts, fixed-host HTTPS redirects, HSTS, WebSocket forwarding and overwritten forwarding headers. Unknown HTTP hosts close with 444; unknown TLS SNI is rejected. List every valid hostname, including Overwatch admin. IPv6 listeners, wildcards and ACME HTTP challenges are not generated automatically.

Managed access logs include time, host, peer IP, method, normalized path, status, bytes and duration, excluding queries, Referer, credentials, cookies and bodies. Rotate the selected file. Secrets in paths still appear. **Error logs and app/Traefik logs are separate** and may retain full requests: review their permissions, retention and redaction independently.

## Operations

```sh
overwatch config docs edge
overwatch infra edge render > /tmp/overwatch-edge.conf
overwatch infra edge check
overwatch infra edge deploy
overwatch infra edge rollback <backup-id>
```

Run where Nginx config, executable, certificates and master PID are accessible. Options: `--nginx-dir /etc/nginx`, `--nginx-binary nginx`. Inside Docker, mount the config **directory** (writes use atomic rename), certificates, binary/libraries, logs/state and PID file; share host PID namespace for reload. Confine this authority to an operator helper, not the web app.

`render` prints config; `check` validates the complete candidate without changing live files. `deploy` locks, backs up, validates, detects concurrent edits, installs `conf.d/overwatch-edge.conf`, removes only explicit `adopt_files`, validates again and gracefully reloads. Failures restore original files. Conflicting virtual-host warnings count as failures, preventing old unrestricted sites from overriding policy. Unchanged deployments validate without reload.

Backups live in `<nginx-dir>/.overwatch-edge/<backup-id>`. Rollback restores only touched files, refuses subsequent manual changes and validates/reloads. Rollback changes Nginx, not YAML: revert YAML before the next deploy if retaining an old policy. Checks remove temporary candidates; failed deployments retain them for diagnosis. Protect and retain backups according to local policy.

`infra deploy` and `init` also render `infrastructure/nginx/overwatch-edge.conf` when enabled, but **do not activate host Nginx**. The explicit edge deploy avoids accidental proxy takeover during an infrastructure update.

Edge version hiding does not rewrite upstream HTML. Configure `server_tokens off;` in frontend source images too. App permissions, public/private data filtering, secure uploads and dependencies remain application responsibilities.
