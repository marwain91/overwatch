# Security Policy

## Supported Versions

Only the latest minor release line receives security fixes. See [CHANGELOG.md](CHANGELOG.md) for the current version.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report vulnerabilities privately using one of:

- **GitHub Security Advisories** — [open a private advisory](https://github.com/marwain91/overwatch/security/advisories/new) (preferred)
- **Email** — jiri.havlicek@daktela.com

Please include:

- A description of the issue and its impact
- Steps to reproduce, or a proof-of-concept
- The affected version(s) and any relevant configuration
- Your name/handle if you'd like to be credited

You should receive an initial response within 7 days. We'll keep you updated as we investigate, prepare a fix, and coordinate disclosure.

## Scope

In scope:

- The Overwatch CLI and Docker image (`ghcr.io/marwain91/overwatch`)
- The admin web UI under `ui/`
- The REST API exposed by the admin server
- Configuration handling, secret resolution, and tenant isolation logic

Out of scope:

- Vulnerabilities in third-party apps deployed *by* Overwatch — report those to the respective upstream projects
- Issues that require an attacker to already have root on the host
- Denial-of-service via resource exhaustion on a self-hosted single-tenant deployment
