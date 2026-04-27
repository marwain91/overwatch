# GitLab Container Registry

Overwatch supports both **SaaS GitLab** (`gitlab.com` + `registry.gitlab.com`) and **self-hosted GitLab** as a first-class registry type. Picking `type: gitlab` (instead of the generic `type: custom`) gets you tag browsing in the UI, the same as GHCR — `custom` only handles `docker login`/`docker pull`.

This guide walks through setting it up end to end.

---

## Pick the right token

GitLab has four token shapes that can authenticate to the container registry **and** the REST API. Pick the most narrowly-scoped one that fits.

| Token type | Owned by | Scope | Tag listing? | Recommended for |
|---|---|---|---|---|
| **Group Access Token** | A group | One group + sub-projects | Yes (`read_api`) | **Org repos — recommended.** Survives user offboarding, scoped to the group. |
| **Project Access Token** | A single project | One project | Yes (`read_api`) | A single project, no sub-projects. |
| **Personal Access Token (PAT)** | A user | Whatever the user can see | Yes (`read_api`) | Personal namespaces, quick experiments. |
| **Deploy Token** | A project (or group) | Pull-only (no API) | **No** | Strictly pull-only — Overwatch will fail to list tags. Don't pick this unless you also pin a tag manually. |

> **Note:** Deploy Tokens are tempting because they look "least privileged," but the GitLab REST API doesn't accept them — Overwatch's "browse tags" UI will return 401. Pick a Group Access Token instead.

### Required scopes

Whichever token you pick, it needs:

- **`read_api`** — list repository tags via `/api/v4/projects/:id/repository/tags`.
- **`read_registry`** — pull container images from the project's registry.

Both are available on every token type listed above (except Deploy Tokens, which have neither — they use a different permission model).

---

## 1. Create the token

### Group Access Token (recommended)

1. Open the **group** (not a project) → **Settings → Access Tokens**.
2. **Token name:** anything memorable, e.g. `overwatch`.
3. **Role:** `Reporter` is enough — `Developer` works too.
4. **Scopes:** check `read_api` and `read_registry`.
5. **Expiration:** set whatever your security policy requires; Overwatch will surface 401s when it expires.
6. Click **Create**, copy the token immediately — GitLab only shows it once.

### Personal Access Token

Same flow under your **user → Preferences → Access Tokens**. Same scopes.

---

## 2. Find the URLs

You need two host values, which may or may not be the same:

| Field | SaaS | Self-hosted (typical) |
|---|---|---|
| **Registry URL** (`url`) | `registry.gitlab.com` | `registry.acme.com:5050` or `gitlab.acme.com:5050` |
| **API URL** (`api_url`) | *(leave empty — derived)* | `https://gitlab.acme.com` |

To find these on a self-hosted instance:

- **Registry URL** → in your project, **Deploy → Container Registry**. The page header says e.g. *"Login: `docker login registry.acme.com:5050`"* — that hostname (with port) is your `url`.
- **API URL** → just the GitLab web URL, with scheme. If you log in at `https://gitlab.acme.com`, that's it.

> **Note:** SaaS does not need an API URL. Overwatch derives `https://gitlab.com` automatically when `url` is `registry.gitlab.com`. Setting it explicitly is fine but unnecessary.

---

## 3. Set the environment variable

Overwatch reads the token from an env var whose name you choose. The plan-of-record is:

```bash
export GITLAB_TOKEN="glpat-xxxxxxxxxxxxxxxxxxxx"
```

> **Tip:** GitLab tokens follow visible prefixes — `glpat-` for PATs, `glptt-` for Project ATs, `glgrt-` for Group ATs, `gldt-` for Deploy Tokens. Overwatch doesn't care which, but you can use the prefix to spot which kind of token landed in your env.

If you're using `.env`, **avoid trailing newlines** — they break `docker login` silently. `printf '%s\n' "GITLAB_TOKEN=$TOKEN" >> .env` is safe; pasting from a clipboard often is not.

---

## 4. Configure the Overwatch app

### Through the UI

1. **Apps → New** (or open an existing app's **Settings**).
2. **Registry Type:** `GitLab Container Registry`. Overwatch fills `Registry URL` with `registry.gitlab.com` and the auth type with `Personal Access Token` — adjust as needed.
3. **Repository:** the GitLab project's full path, e.g. `acme/myapp` or `acme/platform/api`. This is the slug in the GitLab URL after the host, **not** the registry image path.
4. **API URL:** leave empty for SaaS. For self-hosted, paste `https://gitlab.acme.com`.
5. **Token Env Var:** `GITLAB_TOKEN`.
6. Save.

### Through the JSON / API

```json
{
  "registry": {
    "type": "gitlab",
    "url": "registry.gitlab.com",
    "repository": "acme/myapp",
    "auth": {
      "type": "token",
      "token_env": "GITLAB_TOKEN"
    }
  }
}
```

Self-hosted variant — note the explicit `api_url`:

```json
{
  "registry": {
    "type": "gitlab",
    "url": "registry.acme.com:5050",
    "api_url": "https://gitlab.acme.com",
    "repository": "acme/platform/api",
    "auth": {
      "type": "token",
      "token_env": "GITLAB_TOKEN"
    }
  }
}
```

---

## 5. Verify

In the app's **Settings → Registry**, click **Test Registry** (calls `POST /api/apps/:id/registry/test`). Expected outcomes:

- **200 OK** with a tags array — you're done.
- **HTTP 401** — token rejected. Check the scopes (`read_api` + `read_registry`) and that the token isn't expired. Deploy Tokens always 401 on tag listing.
- **HTTP 404** — the project path is wrong, or the token cannot see it. Repository should be the GitLab project's full path (`group/subgroup/project`), not the registry image path.
- **`needs an api_url`** error — you picked self-hosted GitLab but didn't set the API URL. Fill it in.
- **`Registry URL points to private IP`** — the SSRF guard caught a private-network address. Either fix the URL or set `OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL=1` (next section).

The Overwatch backend logs `Authenticating with GitLab Container Registry at <url>...` and `Successfully logged in to <url>` on a successful login.

---

## Self-hosted GitLab on a private network

If your GitLab and Overwatch share a private network (RFC1918, link-local, or `localhost` for a dev box), Overwatch's SSRF guard will refuse to talk to the API URL by default. To allow it:

```bash
export OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL=1
```

> **Warning:** This opt-out applies to **all** registries' URL validation, not just this one app. Only set it when you trust every URL operators can put into an app config — i.e., admin-only Overwatch deployments where the admin and the GitLab operator are the same person or team.

The flag mirrors the existing `OVERWATCH_ALLOW_INSECURE_S3` pattern. There is intentionally no per-app override — operators would just enable it everywhere if it existed.

---

## Token rotation

GitLab tokens don't auto-rotate. When you rotate one:

1. Generate the replacement (same scopes).
2. Update `GITLAB_TOKEN` in your env / `.env` / secret manager.
3. Restart Overwatch (the registry adapter caches resolved env values per process — restart picks up the new value).
4. The old token can be deleted from GitLab once Overwatch is verified working.

If the token expires before you rotate, the next tag listing or registry login fails with HTTP 401 — Overwatch surfaces this as a clear UI error rather than a hang.

---

## Migrating from `type: custom`

If you were already using GitLab via the `custom` adapter:

```diff
   "registry": {
-    "type": "custom",
+    "type": "gitlab",
     "url": "registry.acme.com:5050",
+    "api_url": "https://gitlab.acme.com",
     "repository": "acme/myapp",
     "auth": {
-      "type": "basic",
-      "username_env": "GITLAB_USERNAME",
       "type": "token",
       "token_env": "GITLAB_TOKEN"
     }
   }
```

You gain tag browsing in the UI. `docker login` keeps working — `oauth2` (the username GitLab expects) is now the default; you can drop the `username_env` field. Existing pinned tags continue to resolve unchanged.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| 401 on tag listing | Token lacks `read_api`, expired, or it's a Deploy Token. |
| 401 on docker pull | Token lacks `read_registry`, or you have leading/trailing whitespace in the env var. |
| 404 on tag listing | `repository` doesn't match the project's full path; or self-hosted with wrong `api_url`. |
| `needs an api_url` | Self-hosted GitLab, no `api_url` set. |
| `denied: requested access to the resource is denied` on docker pull | Wrong registry host (`url`), or the token cannot see this project. |
| `Registry URL points to private IP` | SSRF guard. Set `OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL=1` if intentional. |
| Tags load but show only old versions | `tag_pattern` regex is filtering out newer tags — relax or remove it. |

---

## How it works under the hood

1. The factory picks `GitLabAdapter` for `type: 'gitlab'`.
2. `login()` runs `docker login <url> -u oauth2 --password-stdin` with the token piped on stdin. `oauth2` is the canonical GitLab username for token auth — works for every token type.
3. `getImageTags()` derives the API base (`api_url` if set; `https://gitlab.com` if `url === 'registry.gitlab.com'`; error otherwise), URL-encodes the repository path (so `group/sub/project` → `group%2Fsub%2Fproject`), and calls `GET /api/v4/projects/:id/repository/tags?per_page=100&order_by=name&sort=desc` with a `PRIVATE-TOKEN` header.
4. Tags are filtered by `tag_pattern` (if set) and re-sorted client-side using `localeCompare(undefined, { numeric: true })` so `v1.10.0` correctly outranks `v1.9.0`.
5. SSRF guard runs against the API base **only when `api_url` was set explicitly** — the SaaS-derived `https://gitlab.com` is trusted. Override via `OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL=1`.
