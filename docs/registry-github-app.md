# GitHub App Authentication for App Registries

Overwatch supports two ways to authenticate against `ghcr.io` and the GitHub Tags API:

1. **Personal Access Token (PAT)** — simple, fine for personal repos and quick experiments. One token does both registry pulls and tag listing.
2. **GitHub App** — recommended when the source repository lives in a GitHub **organisation**. Org-owned, fine-grained per-repo permissions, installation tokens that rotate roughly every hour. Survives the original setup user leaving the org.

This guide walks through the GitHub App path end to end.

---

## Why a GitHub App vs a PAT?

| | PAT | GitHub App |
|---|---|---|
| Owned by | A user | The org (or a user) |
| Token lifetime | Months/years (you set it) | ~1 hour, auto-rotated |
| Scope granularity | Coarse: `read:packages`, `repo`, … | Fine: per-repo, specific permissions |
| Survives user offboarding | No (tokens go with the user) | Yes (App stays installed) |
| Setup effort | Single env var | App + install + 3 env vars |

**Rule of thumb:** if the repo lives in an org, use a GitHub App. If it's in your personal namespace, a PAT is fine.

> **Note:** Both auth types can coexist across apps. Each Overwatch app picks its own `auth.type` independently.

---

## 1. Create the GitHub App

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App** on the org (or user) that owns the source repo.
2. Fill in the basics:
   - **Name:** anything memorable — e.g. `Overwatch — Acme`.
   - **Homepage URL:** the Overwatch host URL (or any placeholder).
   - **Webhook:** **uncheck "Active"**. Overwatch never receives webhooks; leaving them on just creates noise and a useless secret.
3. **Repository permissions** (this is the important bit — minimum needed):
   - **Contents:** `Read-only` — for git tag listing.
   - **Metadata:** `Read-only` — required by GitHub whenever Contents is set.
   - **Packages:** `Read-only` — for `docker pull` from `ghcr.io`.
4. **Account permissions:** none needed. Leave them all on `No access`.
5. **Where can this GitHub App be installed?** — `Only on this account` is the safer choice for org-internal use.
6. Click **Create GitHub App**.

You'll land on the App's settings page. Note the **App ID** (a small number like `123456`) at the top — you'll need it.

---

## 2. Generate the Private Key

On the same App settings page, scroll to **Private keys**:

1. Click **Generate a private key**.
2. A `.pem` file downloads. Treat it like a password — anyone with this file can mint tokens for any repo the App is installed on.

> **Warning:** GitHub does not store the private key. If you lose this file, you must generate a new one and rotate it everywhere.

---

## 3. Install the App on the Repository

Still on the App settings page:

1. In the left sidebar, click **Install App**.
2. Pick the org (or user). You'll be prompted to choose:
   - **All repositories** — easiest, but the App can read every repo's tags. Fine for an internal-only org.
   - **Only select repositories** — recommended for shared orgs. Pick the specific repos Overwatch needs.
3. Confirm. After install, the URL becomes something like `https://github.com/organizations/<org>/settings/installations/<installation_id>`.

The number at the end (`<installation_id>`) is the **Installation ID** — you'll need it as well. It is **not** the same as the App ID.

---

## 4. Set the Environment Variables

Overwatch reads three env vars whose names you choose. Defaults shown below — you can use any names as long as the Overwatch app config points at them.

```bash
# Copy from the GitHub App page
export GH_APP_ID="123456"
export GH_APP_INSTALLATION_ID="78901234"
```

The private key has two acceptable formats. Pick whichever your secret manager / shell makes easiest.

**Option A — raw PEM (multi-line):** good for `dotenv` parsers that support multi-line quoted values, or when exporting from a script:

```bash
# .env
GH_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA…
…many lines…
-----END RSA PRIVATE KEY-----"
```

Or, in a shell:

```bash
export GH_APP_PRIVATE_KEY="$(cat ./overwatch-acme.2026-04-27.private-key.pem)"
```

**Option B — base64-encoded PEM (single line):** safer for tools that don't handle multi-line env vars (most `.env` parsers, Docker Compose `environment:`, GitHub Actions secrets). Overwatch auto-detects and decodes:

```bash
export GH_APP_PRIVATE_KEY="$(base64 -w0 < ./overwatch-acme.2026-04-27.private-key.pem)"
# Or on macOS:
export GH_APP_PRIVATE_KEY="$(base64 < ./overwatch-acme.2026-04-27.private-key.pem)"
```

> **Note:** Overwatch detects which format it received by checking whether the value starts with `-----BEGIN`. If yes, it's used verbatim. If no, it's base64-decoded. There is no flag to switch — just pick one.

---

## 5. Configure the Overwatch App

### Through the UI

1. Open the app's create wizard (or **Settings → Registry** for an existing app).
2. **Auth Type:** pick **GitHub App (recommended for org repos)**.
3. Fill in the three env-var **names** (not values):
   - **App ID Env Var:** `GH_APP_ID`
   - **Installation ID Env Var:** `GH_APP_INSTALLATION_ID`
   - **Private Key Env Var:** `GH_APP_PRIVATE_KEY`
4. Save.

### Through the JSON / API

```json
{
  "registry": {
    "type": "ghcr",
    "url": "ghcr.io",
    "repository": "acme/myapp",
    "auth": {
      "type": "github_app",
      "app_id_env": "GH_APP_ID",
      "installation_id_env": "GH_APP_INSTALLATION_ID",
      "private_key_env": "GH_APP_PRIVATE_KEY"
    }
  }
}
```

The same shape works in `data/apps.d/<id>.json` and in `overwatch apps apply <file>.json`.

---

## 6. Verify

In the UI, on the app's settings page, the **Test Registry** action calls `POST /api/apps/:id/registry/test`. Expected behaviour:

- **200 OK** with a tags list — done. Overwatch successfully minted an installation token, talked to `api.github.com`, and listed tags.
- **HTTP 401** — usually a wrong **Installation ID** or a mismatched **App ID** / **Private Key**. Double-check both — the App ID is at the top of the App settings page, the Installation ID is in the install URL.
- **HTTP 404** — the App is **not installed on this specific repository**. Go back to step 3 and add it.
- **`Contents:Read` / `Packages:Read` permission errors** — adjust the App's repository permissions (step 1.3), then **revisit the install** (GitHub will prompt installed orgs to accept the new permissions).

You can also tail the Overwatch backend logs while triggering the test — the adapter logs `Authenticating with GitHub Container Registry...` and `Successfully logged in to ghcr.io` on success.

---

## 7. Rotation and Revocation

- **Installation tokens** rotate roughly every hour automatically — no action required.
- **Private keys** can be regenerated from the App settings page at any time. After regenerating, update `GH_APP_PRIVATE_KEY` and restart Overwatch (or wait for the in-process token cache to expire — at most ~55 minutes).
- **Revoking the App** (uninstall from the org) instantly invalidates all outstanding installation tokens. Overwatch will start failing within ~1 hour and surface the failure on the affected app's registry test.

---

## Troubleshooting

**"GitHub App installation token request failed (HTTP 401)"** — the JWT was rejected. Causes (in order of likelihood):
1. Wrong **App ID** (`GH_APP_ID`) — verify against the App settings page.
2. Wrong **Private Key** — regenerate and re-set the env var.
3. Clock skew on the Overwatch host — the JWT is valid for 9 minutes with a 60-second backdate; if your clock is off by more, sync it (`timedatectl`).

**"GitHub App installation token request failed (HTTP 404)"** — the **Installation ID** does not match the App ID, or the install was deleted. Re-check both.

**"Contents:Read permission" / 403 on tag listing** — the App lacks `Contents:Read`. Edit the App's permissions and accept the prompt on the org installation.

**Tag listing returns 404** — the App is installed on the org but **not on this specific repository**. Open the App's install settings and add the repo.

**Tags load but `docker pull` fails with `denied`** — the App lacks `Packages:Read`. Same fix as above.

---

## How it works under the hood

1. Overwatch's `GHCRAdapter` notices `auth.type === 'github_app'` and resolves the three env-var names to actual values.
2. On every `login()` and `getImageTags()` call, the adapter awaits `getInstallationToken(creds)`.
3. The token mint service:
   - Returns the cached token if it has more than 5 minutes of life left.
   - Otherwise: signs a short-lived (9 min) RS256 JWT with `iss = appId` and `iat - 60s` to absorb minor clock drift, calls `POST /app/installations/:id/access_tokens` on `api.github.com`, and caches the resulting `{ token, expires_at }`.
   - Concurrent callers waiting on the same `(appId, installationId)` share one in-flight mint (no API thundering herd).
4. The minted token becomes both the `--password-stdin` for `docker login ghcr.io` and the `Authorization: Bearer …` for the GitHub Tags API.

The whole exchange is in-process and stateless across Overwatch restarts — there's no on-disk token cache, by design.
