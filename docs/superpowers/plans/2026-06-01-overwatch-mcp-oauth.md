# Overwatch MCP Server with OAuth2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a remote Streamable-HTTP MCP server to Overwatch that exposes tenant read/update/lifecycle tools, secured by OAuth 2.1 with Overwatch acting as its own Authorization Server (Google login delegation + `admin-users.json` RBAC).

**Architecture:** Three new concerns mounted into the existing Express app in `src/index.ts`, gated by `config.mcp.enabled`: (1) an OAuth 2.1 Authorization Server (`src/oauth/`) that delegates login to the existing Google sign-in and issues Overwatch-signed JWT access tokens + rotating refresh tokens; (2) an MCP Resource Server at `/mcp` built on `@modelcontextprotocol/server` + `@modelcontextprotocol/express`, protected by `requireBearerAuth`; (3) MCP tools (`src/mcp/tools/`) that are thin wrappers over existing services. The long-running `updateTenant` streams its existing `eventBus` progress steps as MCP progress notifications.

**Tech Stack:** TypeScript, Express 5, Zod 3, `jsonwebtoken` (HS256, reusing `JWT_SECRET`), `google-auth-library` (reused), `@modelcontextprotocol/server`, `@modelcontextprotocol/express`, vitest 4. Node `crypto` for PKCE/refresh tokens. JSON file persistence via existing `writeJsonAtomic` / `withFileLock`.

**Reference spec:** `docs/superpowers/specs/2026-06-01-overwatch-mcp-oauth-design.md`

---

## Conventions used in this plan

- All commands run in Docker per the project rule. Use this wrapper for build/test/install:
  ```bash
  docker run --rm -v "$(pwd)":/app -w /app node:22-alpine sh -c '<command>'
  ```
  Shorthand below: `D '<command>'` means the above with `<command>` substituted.
- Test runner: `npm test` → `vitest run`. Single file: `npx vitest run <path>`.
- Tests live in `src/__tests__/*.test.ts` (existing convention) and use `vitest` with `vi.mock`.
- Commit after every green step. Branch is already `feat/mcp-oauth`.

## File structure (created/modified)

```
CREATE  src/config/mcp.ts              # MCP Zod schema + types (kept out of schema.ts to avoid bloat)
MODIFY  src/config/schema.ts           # add `mcp` to OverwatchConfigSchema
MODIFY  src/config/validate.ts         # require mcp.public_url when mcp.enabled
CREATE  src/oauth/types.ts             # shared OAuth types (RegisteredClient, AuthCode, etc.)
CREATE  src/oauth/pkce.ts              # S256 PKCE verification
CREATE  src/oauth/store.ts             # client + refresh-token (file) + auth-code (memory) stores
CREATE  src/oauth/tokens.ts           # issue/verify access JWT, mint/rotate/verify refresh tokens
CREATE  src/oauth/metadata.ts          # RFC 8414 + RFC 9728 metadata documents
CREATE  src/routes/oauth.ts            # /oauth/register, /authorize, /token, /revoke + metadata routes
CREATE  src/mcp/auth.ts                # OAuthTokenVerifier -> AuthInfo{email, role}
CREATE  src/mcp/audit.ts               # writeMcpAudit() helper over writeAuditEntry
CREATE  src/mcp/tools/read.ts          # list_apps, list_tenants, get_tenant
CREATE  src/mcp/tools/lifecycle.ts     # start_tenant, stop_tenant, restart_tenant
CREATE  src/mcp/tools/update.ts        # update_tenant (sync + progress)
CREATE  src/mcp/server.ts              # build McpServer, register tools, mount transport
MODIFY  src/index.ts                   # mount /oauth + /mcp behind config.mcp.enabled
MODIFY  .env.example                   # document nothing new required (reuses JWT_SECRET/GOOGLE_CLIENT_ID)
MODIFY  examples/overwatch.yaml (or docs) # document mcp config section
CREATE  docs/mcp.md                    # operator + client connection guide
```

> **SDK note (read before Phase 3):** Task 2 pins exact package versions and confirms exports. This plan targets the current split-package API documented by the MCP TS SDK: resource-server helpers (`requireBearerAuth`, `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl`, `OAuthTokenVerifier`, `createMcpExpressApp`) from `@modelcontextprotocol/express`, and `McpServer` + transport + tool context (`ctx.mcpReq._meta?.progressToken`, `ctx.mcpReq.notify(...)`) from `@modelcontextprotocol/server`. If the installed version's import paths differ, adjust imports in the affected task; the logic and signatures below stay the same.

---

## Phase 0 — Config & dependencies

### Task 1: MCP config schema + env validation

**Files:**
- Create: `src/config/mcp.ts`
- Modify: `src/config/schema.ts` (add to `OverwatchConfigSchema`, lines 67-81)
- Modify: `src/config/validate.ts` (extend `validateEnvironment`, lines 14-32)
- Test: `src/__tests__/mcpConfig.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/mcpConfig.test.ts
import { describe, it, expect } from 'vitest';
import { McpConfigSchema } from '../config/mcp';

describe('McpConfigSchema', () => {
  it('defaults to disabled with standard TTLs', () => {
    const parsed = McpConfigSchema.parse({});
    expect(parsed.enabled).toBe(false);
    expect(parsed.access_token_ttl).toBe('1h');
    expect(parsed.refresh_token_ttl).toBe('30d');
    expect(parsed.public_url).toBe('');
  });

  it('accepts an enabled config with a public_url', () => {
    const parsed = McpConfigSchema.parse({ enabled: true, public_url: 'https://ow.example.com' });
    expect(parsed.enabled).toBe(true);
    expect(parsed.public_url).toBe('https://ow.example.com');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `D 'npx vitest run src/__tests__/mcpConfig.test.ts'`
Expected: FAIL — cannot find module `../config/mcp`.

- [ ] **Step 3: Create the schema**

```ts
// src/config/mcp.ts
import { z } from 'zod';

// MCP server configuration. The whole feature is opt-in; when `enabled` is false
// no /mcp or /oauth routes mount. `public_url` is the externally reachable base
// URL used as the OAuth issuer and the access-token audience — it MUST be set
// when enabled (validated in validateEnvironment).
export const McpConfigSchema = z.object({
  enabled: z.boolean().default(false).describe('Enable the remote MCP server and its OAuth endpoints'),
  public_url: z.string().default('').describe('Externally reachable base URL (OAuth issuer + token audience), e.g. https://overwatch.example.com'),
  access_token_ttl: z.string().default('1h').describe('Access token lifetime (jsonwebtoken expiresIn syntax)'),
  refresh_token_ttl: z.string().default('30d').describe('Refresh token lifetime (jsonwebtoken expiresIn syntax)'),
});

export type McpConfig = z.infer<typeof McpConfigSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `D 'npx vitest run src/__tests__/mcpConfig.test.ts'`
Expected: PASS (both tests).

- [ ] **Step 5: Wire schema into main config**

In `src/config/schema.ts`, add the import at the top:
```ts
import { McpConfigSchema } from './mcp';
```
Add this field inside `OverwatchConfigSchema` (after `retention:` on line 79, before `data_dir:`):
```ts
  mcp: McpConfigSchema.optional().describe('Remote MCP server + OAuth2 configuration'),
```

- [ ] **Step 6: Write the failing env-validation test**

```ts
// append to src/__tests__/mcpConfig.test.ts
import { validateEnvironment } from '../config/validate';
import type { OverwatchConfig } from '../config/schema';

function baseConfig(overrides: Partial<OverwatchConfig> = {}): OverwatchConfig {
  return {
    project: { name: 'p', prefix: 'p', db_prefix: 'p' },
    database: { type: 'mysql', host: 'db', port: 3306, root_user: 'root', root_password_env: 'MYSQL_ROOT_PASSWORD', container_name: 'db' },
    ...overrides,
  } as OverwatchConfig;
}

describe('validateEnvironment — mcp', () => {
  it('errors when mcp.enabled but public_url is blank', () => {
    process.env.JWT_SECRET = 'x'.repeat(32);
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.MYSQL_ROOT_PASSWORD = 'pw';
    const errors = validateEnvironment(baseConfig({ mcp: { enabled: true, public_url: '', access_token_ttl: '1h', refresh_token_ttl: '30d' } }));
    expect(errors.some(e => e.category === 'mcp' && /public_url/.test(e.message))).toBe(true);
  });

  it('no mcp error when disabled', () => {
    process.env.JWT_SECRET = 'x'.repeat(32);
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.MYSQL_ROOT_PASSWORD = 'pw';
    const errors = validateEnvironment(baseConfig({ mcp: { enabled: false, public_url: '', access_token_ttl: '1h', refresh_token_ttl: '30d' } }));
    expect(errors.some(e => e.category === 'mcp')).toBe(false);
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `D 'npx vitest run src/__tests__/mcpConfig.test.ts'`
Expected: FAIL — the "errors when enabled but blank" case fails (no validation yet).

- [ ] **Step 8: Implement the validation**

In `src/config/validate.ts`, before `return errors;` (line 31) add:
```ts
  // --- MCP ---
  if (config.mcp?.enabled && !config.mcp.public_url) {
    errors.push({ category: 'mcp', message: 'mcp.public_url is required when mcp.enabled is true (used as OAuth issuer + token audience)' });
  }
```

- [ ] **Step 9: Run to verify pass + full build**

Run: `D 'npx vitest run src/__tests__/mcpConfig.test.ts'`
Expected: PASS.
Run: `D 'npx tsc --noEmit'`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/config/mcp.ts src/config/schema.ts src/config/validate.ts src/__tests__/mcpConfig.test.ts
git commit -m "feat(mcp): add mcp config schema and env validation"
```

---

### Task 2: Install MCP SDK + pin exports (spike)

**Files:**
- Modify: `package.json`, `package-lock.json`
- Test: `src/__tests__/mcpSdkSmoke.test.ts`

- [ ] **Step 1: Install the SDK packages**

Run: `D 'npm install @modelcontextprotocol/server @modelcontextprotocol/express @modelcontextprotocol/client'`
Then record the resolved versions:
Run: `D 'node -e "for (const p of [\"@modelcontextprotocol/server\",\"@modelcontextprotocol/express\",\"@modelcontextprotocol/client\"]) console.log(p, require(p+\"/package.json\").version)"'`
Expected: three lines with versions. **Write these versions into a comment at the top of `src/mcp/server.ts` when you create it (Task 11).**

- [ ] **Step 2: Write a smoke test that pins the exports we depend on**

```ts
// src/__tests__/mcpSdkSmoke.test.ts
import { describe, it, expect } from 'vitest';
import * as expressMw from '@modelcontextprotocol/express';
import * as server from '@modelcontextprotocol/server';

describe('MCP SDK exports we depend on exist', () => {
  it('express integration exports', () => {
    expect(typeof expressMw.requireBearerAuth).toBe('function');
    expect(typeof expressMw.mcpAuthMetadataRouter).toBe('function');
    expect(typeof expressMw.getOAuthProtectedResourceMetadataUrl).toBe('function');
  });
  it('server exports McpServer', () => {
    expect(typeof (server as any).McpServer).toBe('function');
  });
});
```

- [ ] **Step 3: Run the smoke test**

Run: `D 'npx vitest run src/__tests__/mcpSdkSmoke.test.ts'`
Expected: PASS. **If an export name differs in the installed version**, fix the test to match the real export and note the corrected name in a comment — these corrected names are what later tasks must import. Do not invent names.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/__tests__/mcpSdkSmoke.test.ts
git commit -m "chore(mcp): add MCP SDK deps and pin required exports"
```

---

## Phase 1 — OAuth primitives

### Task 3: OAuth types + PKCE verification

**Files:**
- Create: `src/oauth/types.ts`
- Create: `src/oauth/pkce.ts`
- Test: `src/__tests__/oauthPkce.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/oauthPkce.test.ts
import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { verifyPkceS256 } from '../oauth/pkce';

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('verifyPkceS256', () => {
  it('accepts a matching verifier', () => {
    const verifier = randomBytes(32).toString('base64url');
    expect(verifyPkceS256(verifier, challengeFor(verifier))).toBe(true);
  });
  it('rejects a non-matching verifier', () => {
    const verifier = randomBytes(32).toString('base64url');
    expect(verifyPkceS256('wrong', challengeFor(verifier))).toBe(false);
  });
  it('rejects empty inputs', () => {
    expect(verifyPkceS256('', '')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `D 'npx vitest run src/__tests__/oauthPkce.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement types + PKCE**

```ts
// src/oauth/types.ts
import { AdminRole } from '../services/users';

export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: string;
}

// Stored only long enough to exchange for a token (~60s, in memory).
export interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;       // S256
  email: string;
  role: AdminRole;
  resource?: string;
  expires_at: number;           // epoch ms
}

// Persisted (hashed) refresh token record.
export interface RefreshTokenRecord {
  token_hash: string;           // sha256 of the opaque token
  client_id: string;
  email: string;
  expires_at: number;           // epoch ms
}
```

```ts
// src/oauth/pkce.ts
import { createHash, timingSafeEqual } from 'crypto';

// RFC 7636 S256: base64url(sha256(verifier)) === stored challenge.
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false;
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `D 'npx vitest run src/__tests__/oauthPkce.test.ts'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/oauth/types.ts src/oauth/pkce.ts src/__tests__/oauthPkce.test.ts
git commit -m "feat(mcp): oauth types and PKCE S256 verification"
```

---

### Task 4: OAuth store (clients, refresh tokens, auth codes)

**Files:**
- Create: `src/oauth/store.ts`
- Test: `src/__tests__/oauthStore.test.ts`

The store persists `clients` and `refreshTokens` to `data/mcp-oauth.json` (atomic write + file lock, mirroring `src/services/users.ts`). Auth codes live in an in-memory `Map` (single-process appliance assumption).

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/oauthStore.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

let tmpDir: string;
vi.mock('../config', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getDataDir: () => tmpDir };
});

import {
  registerClient, getClient,
  putAuthCode, consumeAuthCode,
  saveRefreshToken, consumeRefreshToken,
} from '../oauth/store';

describe('oauth store', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-oauth-'));
  });

  it('registers and reads back a client', async () => {
    const c = await registerClient({ client_name: 'claude', redirect_uris: ['https://c/cb'] });
    expect(c.client_id).toMatch(/.+/);
    const read = await getClient(c.client_id);
    expect(read?.redirect_uris).toEqual(['https://c/cb']);
  });

  it('auth code is single-use', () => {
    putAuthCode({ code: 'abc', client_id: 'c1', redirect_uri: 'https://c/cb', code_challenge: 'ch', email: 'a@b.c', role: 'editor', expires_at: Date.now() + 60_000 });
    expect(consumeAuthCode('abc')?.email).toBe('a@b.c');
    expect(consumeAuthCode('abc')).toBeUndefined(); // already consumed
  });

  it('expired auth code is rejected', () => {
    putAuthCode({ code: 'old', client_id: 'c1', redirect_uri: 'https://c/cb', code_challenge: 'ch', email: 'a@b.c', role: 'editor', expires_at: Date.now() - 1 });
    expect(consumeAuthCode('old')).toBeUndefined();
  });

  it('refresh token rotates: reuse of consumed token is rejected', async () => {
    await saveRefreshToken('tok-1', { client_id: 'c1', email: 'a@b.c', expires_at: Date.now() + 60_000 });
    expect((await consumeRefreshToken('tok-1'))?.email).toBe('a@b.c');
    expect(await consumeRefreshToken('tok-1')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `D 'npx vitest run src/__tests__/oauthStore.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

```ts
// src/oauth/store.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDataDir } from '../config';
import { withFileLock } from '../services/fileLock';
import { writeJsonAtomic } from '../utils/atomicJson';
import { RegisteredClient, AuthCode, RefreshTokenRecord } from './types';
import { AdminRole } from '../services/users';

interface OAuthFile {
  clients: RegisteredClient[];
  refreshTokens: RefreshTokenRecord[];
}

function storeFile(): string {
  return path.join(getDataDir(), 'mcp-oauth.json');
}

async function readFileState(): Promise<OAuthFile> {
  try {
    const raw = await fs.readFile(storeFile(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<OAuthFile>;
    return { clients: parsed.clients ?? [], refreshTokens: parsed.refreshTokens ?? [] };
  } catch (err: any) {
    if (err.code === 'ENOENT') return { clients: [], refreshTokens: [] };
    throw new Error(`mcp-oauth.json is not valid JSON (${err.message}). Refusing to auto-reset.`);
  }
}

async function writeFileState(state: OAuthFile): Promise<void> {
  await writeJsonAtomic(storeFile(), state, { mode: 0o600 });
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---- Clients (persisted) ----
export async function registerClient(input: { client_name?: string; redirect_uris: string[] }): Promise<RegisteredClient> {
  return withFileLock('mcp-oauth', async () => {
    const state = await readFileState();
    const client: RegisteredClient = {
      client_id: crypto.randomUUID(),
      client_name: input.client_name,
      redirect_uris: input.redirect_uris,
      created_at: new Date().toISOString(),
    };
    state.clients.push(client);
    await writeFileState(state);
    return client;
  });
}

export async function getClient(clientId: string): Promise<RegisteredClient | undefined> {
  const state = await readFileState();
  return state.clients.find(c => c.client_id === clientId);
}

// ---- Auth codes (in-memory, single-use, short-lived) ----
const authCodes = new Map<string, AuthCode>();

export function putAuthCode(code: AuthCode): void {
  authCodes.set(code.code, code);
}

export function consumeAuthCode(code: string): AuthCode | undefined {
  const found = authCodes.get(code);
  if (!found) return undefined;
  authCodes.delete(found.code); // single-use
  if (found.expires_at < Date.now()) return undefined;
  return found;
}

// ---- Refresh tokens (persisted hashed, rotating) ----
export async function saveRefreshToken(token: string, rec: Omit<RefreshTokenRecord, 'token_hash'>): Promise<void> {
  return withFileLock('mcp-oauth', async () => {
    const state = await readFileState();
    state.refreshTokens.push({ token_hash: sha256(token), ...rec });
    await writeFileState(state);
  });
}

// Returns the record and removes it (rotation). Expired/unknown -> undefined.
export async function consumeRefreshToken(token: string): Promise<Omit<RefreshTokenRecord, 'token_hash'> | undefined> {
  return withFileLock('mcp-oauth', async () => {
    const state = await readFileState();
    const hash = sha256(token);
    const idx = state.refreshTokens.findIndex(t => t.token_hash === hash);
    if (idx === -1) return undefined;
    const [rec] = state.refreshTokens.splice(idx, 1);
    await writeFileState(state);
    if (rec.expires_at < Date.now()) return undefined;
    const { token_hash, ...rest } = rec;
    return rest;
  });
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await consumeRefreshToken(token); // consuming = revoking
}
```

- [ ] **Step 4: Run to verify pass**

Run: `D 'npx vitest run src/__tests__/oauthStore.test.ts'`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/oauth/store.ts src/__tests__/oauthStore.test.ts
git commit -m "feat(mcp): oauth client + auth-code + refresh-token store"
```

---

### Task 5: Token issuance & verification

**Files:**
- Create: `src/oauth/tokens.ts`
- Test: `src/__tests__/oauthTokens.test.ts`

Access tokens are JWTs signed with `JWT_SECRET` (HS256), carrying `sub`=email, `role`, `iss`=issuer, `aud`=resource, `scope`. The resource (`aud`) is the `/mcp` URL derived from `public_url`. Refresh tokens are opaque random strings persisted via the Task 4 store.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/oauthTokens.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { issueAccessToken, verifyAccessToken, mcpResourceUrl } from '../oauth/tokens';

const ISSUER = 'https://ow.example.com';

describe('access tokens', () => {
  beforeEach(() => { process.env.JWT_SECRET = 'x'.repeat(40); });

  it('round-trips a valid token with role + audience', () => {
    const token = issueAccessToken({ email: 'a@b.c', role: 'editor', issuer: ISSUER, ttl: '1h' });
    const info = verifyAccessToken(token, { issuer: ISSUER });
    expect(info.email).toBe('a@b.c');
    expect(info.role).toBe('editor');
    expect(info.aud).toBe(mcpResourceUrl(ISSUER));
  });

  it('rejects a token with the wrong audience', () => {
    const token = issueAccessToken({ email: 'a@b.c', role: 'editor', issuer: ISSUER, ttl: '1h' });
    expect(() => verifyAccessToken(token, { issuer: 'https://other.example.com' })).toThrow();
  });

  it('rejects a tampered token', () => {
    const token = issueAccessToken({ email: 'a@b.c', role: 'editor', issuer: ISSUER, ttl: '1h' });
    expect(() => verifyAccessToken(token + 'x', { issuer: ISSUER })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `D 'npx vitest run src/__tests__/oauthTokens.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement tokens**

```ts
// src/oauth/tokens.ts
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { AdminRole } from '../services/users';

// The MCP resource identifier is the issuer's /mcp endpoint. Tokens are scoped
// to this audience so they can't be replayed against the 24h web-UI session.
export function mcpResourceUrl(issuer: string): string {
  return new URL('/mcp', issuer).toString();
}

interface AccessClaims {
  sub: string;
  role: AdminRole;
  scope: string;
  iss: string;
  aud: string;
}

export function issueAccessToken(opts: { email: string; role: AdminRole; issuer: string; ttl: string }): string {
  const secret = process.env.JWT_SECRET!;
  const claims: Omit<AccessClaims, 'iss' | 'aud'> = {
    sub: opts.email,
    role: opts.role,
    scope: 'tenants',
  };
  return jwt.sign(claims, secret, {
    algorithm: 'HS256',
    expiresIn: opts.ttl as any,
    issuer: opts.issuer,
    audience: mcpResourceUrl(opts.issuer),
  });
}

export interface VerifiedToken {
  email: string;
  role: AdminRole;
  aud: string;
  scope: string;
}

export function verifyAccessToken(token: string, opts: { issuer: string }): VerifiedToken {
  const secret = process.env.JWT_SECRET!;
  const decoded = jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer: opts.issuer,
    audience: mcpResourceUrl(opts.issuer),
  }) as jwt.JwtPayload & { role: AdminRole; scope: string };
  return {
    email: String(decoded.sub),
    role: decoded.role,
    aud: Array.isArray(decoded.aud) ? decoded.aud[0] : String(decoded.aud),
    scope: decoded.scope,
  };
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `D 'npx vitest run src/__tests__/oauthTokens.test.ts'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/oauth/tokens.ts src/__tests__/oauthTokens.test.ts
git commit -m "feat(mcp): oauth access + refresh token issuance and verification"
```

---

## Phase 2 — OAuth metadata & endpoints

### Task 6: OAuth metadata documents

**Files:**
- Create: `src/oauth/metadata.ts`
- Test: `src/__tests__/oauthMetadata.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/oauthMetadata.test.ts
import { describe, it, expect } from 'vitest';
import { authorizationServerMetadata, protectedResourceMetadata } from '../oauth/metadata';

const ISSUER = 'https://ow.example.com';

describe('oauth metadata', () => {
  it('AS metadata advertises endpoints + PKCE S256', () => {
    const m = authorizationServerMetadata(ISSUER);
    expect(m.issuer).toBe(ISSUER);
    expect(m.authorization_endpoint).toBe('https://ow.example.com/oauth/authorize');
    expect(m.token_endpoint).toBe('https://ow.example.com/oauth/token');
    expect(m.registration_endpoint).toBe('https://ow.example.com/oauth/register');
    expect(m.code_challenge_methods_supported).toContain('S256');
    expect(m.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
  });

  it('protected resource metadata points at the AS', () => {
    const m = protectedResourceMetadata(ISSUER);
    expect(m.resource).toBe('https://ow.example.com/mcp');
    expect(m.authorization_servers).toEqual([ISSUER]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `D 'npx vitest run src/__tests__/oauthMetadata.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement metadata**

```ts
// src/oauth/metadata.ts
import { mcpResourceUrl } from './tokens';

// RFC 8414 Authorization Server Metadata (subset MCP clients consume).
export function authorizationServerMetadata(issuer: string) {
  const u = (p: string) => new URL(p, issuer).toString();
  return {
    issuer,
    authorization_endpoint: u('/oauth/authorize'),
    token_endpoint: u('/oauth/token'),
    registration_endpoint: u('/oauth/register'),
    revocation_endpoint: u('/oauth/revoke'),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], // public clients (PKCE)
  };
}

// RFC 9728 Protected Resource Metadata.
export function protectedResourceMetadata(issuer: string) {
  return {
    resource: mcpResourceUrl(issuer),
    authorization_servers: [issuer],
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `D 'npx vitest run src/__tests__/oauthMetadata.test.ts'`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/oauth/metadata.ts src/__tests__/oauthMetadata.test.ts
git commit -m "feat(mcp): oauth AS + protected-resource metadata documents"
```

---

### Task 7: OAuth routes — `/register` and metadata endpoints

**Files:**
- Create: `src/routes/oauth.ts`
- Test: `src/__tests__/oauthRoutes.register.test.ts`

This task builds the router factory and the dynamic-client-registration + metadata endpoints. `/authorize` and `/token` are added in Tasks 8-9. The factory takes the issuer so it stays pure/testable.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/oauthRoutes.register.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

let tmpDir: string;
vi.mock('../config', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getDataDir: () => tmpDir };
});

import { createOAuthRouter } from '../routes/oauth';

const ISSUER = 'https://ow.example.com';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use(createOAuthRouter({ issuer: ISSUER }));
  return app;
}

describe('oauth /register + metadata', () => {
  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-oauthr-')); });

  it('serves AS metadata', async () => {
    const res = await request(appWith()).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe(ISSUER);
  });

  it('registers a public client', async () => {
    const res = await request(appWith())
      .post('/oauth/register')
      .send({ client_name: 'claude', redirect_uris: ['https://client/cb'] });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/.+/);
    expect(res.body.token_endpoint_auth_method).toBe('none');
  });

  it('rejects registration without redirect_uris', async () => {
    const res = await request(appWith()).post('/oauth/register').send({ client_name: 'x' });
    expect(res.status).toBe(400);
  });
});
```

> Note: `supertest` is a dev dependency to add: `D 'npm install -D supertest @types/supertest'` (do this in Step 2 if not already present).

- [ ] **Step 2: Run to verify failure (install supertest first)**

Run: `D 'npm install -D supertest @types/supertest'`
Run: `D 'npx vitest run src/__tests__/oauthRoutes.register.test.ts'`
Expected: FAIL — `createOAuthRouter` not found.

- [ ] **Step 3: Implement the router (register + metadata only)**

```ts
// src/routes/oauth.ts
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { authorizationServerMetadata, protectedResourceMetadata } from '../oauth/metadata';
import { registerClient } from '../oauth/store';

export interface OAuthRouterOptions {
  issuer: string;
}

export function createOAuthRouter(opts: OAuthRouterOptions): Router {
  const router = Router();
  const { issuer } = opts;

  router.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.json(authorizationServerMetadata(issuer));
  });

  router.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json(protectedResourceMetadata(issuer));
  });

  // RFC 7591 Dynamic Client Registration (public clients only).
  router.post('/oauth/register', asyncHandler(async (req: Request, res: Response) => {
    const { client_name, redirect_uris } = req.body || {};
    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
    }
    if (!redirect_uris.every((u: unknown) => typeof u === 'string' && /^https?:\/\//.test(u))) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be absolute http(s) URLs' });
    }
    const client = await registerClient({ client_name, redirect_uris });
    res.status(201).json({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  }));

  return router;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `D 'npx vitest run src/__tests__/oauthRoutes.register.test.ts'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/oauth.ts src/__tests__/oauthRoutes.register.test.ts package.json package-lock.json
git commit -m "feat(mcp): oauth router with dynamic client registration + metadata"
```

---

### Task 8: `/oauth/authorize` — Google login delegation + code mint

**Files:**
- Modify: `src/routes/oauth.ts`
- Test: `src/__tests__/oauthRoutes.authorize.test.ts`

The authorize endpoint accepts the OAuth request, then needs a verified Google identity. To reuse the existing Google sign-in without building a new HTML login UI, the flow is: `GET /oauth/authorize` validates the OAuth params and renders a minimal login page that runs Google Identity Services and POSTs the Google credential to `POST /oauth/authorize/callback` along with the original (signed) request params. The callback verifies the Google credential (same `OAuth2Client.verifyIdToken` as `routes/auth.ts`), checks `isAdminEmail`, resolves the role, mints a single-use auth code, and 302-redirects to the client `redirect_uri` with `code` + `state`.

To keep request params tamper-proof across the login round-trip, the authorize endpoint packs them into a short-lived signed "request token" (JWT, 10-min, `aud: "mcp-oauth-request"`) embedded in the login page and echoed back by the callback.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/oauthRoutes.authorize.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

let tmpDir: string;
vi.mock('../config', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getDataDir: () => tmpDir };
});

// Mock Google verification + admin lookup.
const verifyIdToken = vi.fn();
vi.mock('google-auth-library', () => ({
  OAuth2Client: class { verifyIdToken = verifyIdToken; },
}));
vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, isAdminEmail: vi.fn(async () => true), getUserRole: vi.fn(async () => 'editor') };
});

import { createOAuthRouter } from '../routes/oauth';
import { registerClient } from '../oauth/store';

const ISSUER = 'https://ow.example.com';
function appWith() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(createOAuthRouter({ issuer: ISSUER }));
  return app;
}

describe('oauth /authorize', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-oautha-'));
    process.env.JWT_SECRET = 'x'.repeat(40);
    process.env.GOOGLE_CLIENT_ID = 'cid';
    verifyIdToken.mockReset();
  });

  it('renders a login page for a valid authorize request', async () => {
    const client = await registerClient({ client_name: 'c', redirect_uris: ['https://client/cb'] });
    const res = await request(appWith()).get('/oauth/authorize').query({
      response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client/cb',
      code_challenge: 'abc', code_challenge_method: 'S256', state: 's1',
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('accounts.google.com/gsi/client'); // GIS script
  });

  it('rejects a redirect_uri that is not registered', async () => {
    const client = await registerClient({ client_name: 'c', redirect_uris: ['https://client/cb'] });
    const res = await request(appWith()).get('/oauth/authorize').query({
      response_type: 'code', client_id: client.client_id, redirect_uri: 'https://evil/cb',
      code_challenge: 'abc', code_challenge_method: 'S256', state: 's1',
    });
    expect(res.status).toBe(400);
  });

  it('callback issues a code and redirects for an admin', async () => {
    const client = await registerClient({ client_name: 'c', redirect_uris: ['https://client/cb'] });
    // First hit authorize to get the signed request token out of the page.
    const page = await request(appWith()).get('/oauth/authorize').query({
      response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client/cb',
      code_challenge: 'abc', code_challenge_method: 'S256', state: 's1',
    });
    const reqToken = /name="request_token" value="([^"]+)"/.exec(page.text)![1];
    verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: 'a@b.c', email_verified: true, name: 'A' }) });

    const res = await request(appWith())
      .post('/oauth/authorize/callback')
      .type('form')
      .send({ request_token: reqToken, credential: 'google-jwt' });

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin + loc.pathname).toBe('https://client/cb');
    expect(loc.searchParams.get('code')).toMatch(/.+/);
    expect(loc.searchParams.get('state')).toBe('s1');
  });

  it('callback denies a non-admin', async () => {
    const users = await import('../services/users');
    (users.isAdminEmail as any).mockResolvedValueOnce(false);
    const client = await registerClient({ client_name: 'c', redirect_uris: ['https://client/cb'] });
    const page = await request(appWith()).get('/oauth/authorize').query({
      response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client/cb',
      code_challenge: 'abc', code_challenge_method: 'S256', state: 's1',
    });
    const reqToken = /name="request_token" value="([^"]+)"/.exec(page.text)![1];
    verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: 'x@y.z', email_verified: true }) });
    const res = await request(appWith())
      .post('/oauth/authorize/callback').type('form')
      .send({ request_token: reqToken, credential: 'google-jwt' });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `D 'npx vitest run src/__tests__/oauthRoutes.authorize.test.ts'`
Expected: FAIL — `/oauth/authorize` not implemented.

- [ ] **Step 3: Implement authorize + callback**

Add to the top of `src/routes/oauth.ts`:
```ts
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { getClient, putAuthCode } from '../oauth/store';
import { isAdminEmail, getUserRole, normaliseRole } from '../services/users';

const REQUEST_TOKEN_AUD = 'mcp-oauth-request';

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  resource?: string;
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function loginPage(requestToken: string, googleClientId: string): string {
  // Minimal Google Identity Services page; posts the credential + request_token
  // back to the callback. No inline handlers beyond the GIS callback global.
  return `<!doctype html><html><head><meta charset="utf-8"><title>Overwatch — Authorize MCP</title>
<script src="https://accounts.google.com/gsi/client" async defer></script></head>
<body>
<h1>Authorize MCP access</h1>
<form id="f" method="POST" action="/oauth/authorize/callback">
  <input type="hidden" name="request_token" value="${htmlEscape(requestToken)}">
  <input type="hidden" name="credential" id="credential">
</form>
<div id="g_id_onload" data-client_id="${htmlEscape(googleClientId)}" data-callback="onCred"></div>
<div class="g_id_signin" data-type="standard"></div>
<script>function onCred(r){document.getElementById('credential').value=r.credential;document.getElementById('f').submit();}</script>
</body></html>`;
}
```

Then add the routes inside `createOAuthRouter`, before `return router;`:
```ts
  const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
  const googleClient = new OAuth2Client(googleClientId);

  // GET /oauth/authorize — validate params, render login page with a signed request token.
  router.get('/oauth/authorize', asyncHandler(async (req: Request, res: Response) => {
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, resource } = req.query as Record<string, string>;
    if (response_type !== 'code') return res.status(400).json({ error: 'unsupported_response_type' });
    if (code_challenge_method !== 'S256' || !code_challenge) return res.status(400).json({ error: 'invalid_request', error_description: 'PKCE S256 required' });
    const client = await getClient(client_id);
    if (!client) return res.status(400).json({ error: 'invalid_client' });
    if (!client.redirect_uris.includes(redirect_uri)) return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri not registered' });

    const params: AuthorizeParams = { client_id, redirect_uri, code_challenge, state, resource };
    const requestToken = jwt.sign(params, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '10m', audience: REQUEST_TOKEN_AUD });
    res.type('html').send(loginPage(requestToken, googleClientId));
  }));

  // POST /oauth/authorize/callback — verify Google credential, check admin, mint code.
  router.post('/oauth/authorize/callback', asyncHandler(async (req: Request, res: Response) => {
    const { request_token, credential } = req.body || {};
    if (!request_token || !credential) return res.status(400).json({ error: 'invalid_request' });

    let params: AuthorizeParams;
    try {
      params = jwt.verify(request_token, process.env.JWT_SECRET!, { algorithms: ['HS256'], audience: REQUEST_TOKEN_AUD }) as AuthorizeParams;
    } catch {
      return res.status(400).json({ error: 'invalid_request', error_description: 'expired or invalid request' });
    }

    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: googleClientId });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.email_verified) return res.status(401).json({ error: 'access_denied', error_description: 'email not verified' });
    const email = payload.email.toLowerCase();
    if (!(await isAdminEmail(email))) {
      return res.status(403).send('<h1>Access denied</h1><p>This Google account is not an Overwatch admin.</p>');
    }
    const role = normaliseRole(await getUserRole(email));

    const code = randomBytes(32).toString('base64url');
    putAuthCode({
      code, client_id: params.client_id, redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge, email, role, resource: params.resource,
      expires_at: Date.now() + 60_000,
    });

    const location = new URL(params.redirect_uri);
    location.searchParams.set('code', code);
    if (params.state) location.searchParams.set('state', params.state);
    res.redirect(302, location.toString());
  }));
```

- [ ] **Step 4: Run to verify pass**

Run: `D 'npx vitest run src/__tests__/oauthRoutes.authorize.test.ts'`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/oauth.ts src/__tests__/oauthRoutes.authorize.test.ts
git commit -m "feat(mcp): oauth authorize endpoint with Google login delegation"
```

---

### Task 9: `/oauth/token` and `/oauth/revoke`

**Files:**
- Modify: `src/routes/oauth.ts`
- Test: `src/__tests__/oauthRoutes.token.test.ts`

Handles `grant_type=authorization_code` (with PKCE verify, admin re-check, issue access+refresh) and `grant_type=refresh_token` (rotate). `/oauth/revoke` invalidates a refresh token.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/oauthRoutes.token.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash, randomBytes } from 'crypto';

let tmpDir: string;
vi.mock('../config', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getDataDir: () => tmpDir };
});
vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, isAdminEmail: vi.fn(async () => true), getUserRole: vi.fn(async () => 'editor') };
});

import { createOAuthRouter } from '../routes/oauth';
import { putAuthCode } from '../oauth/store';
import { verifyAccessToken } from '../oauth/tokens';

const ISSUER = 'https://ow.example.com';
function appWith() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(createOAuthRouter({ issuer: ISSUER }));
  return app;
}

describe('oauth /token', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-oautht-'));
    process.env.JWT_SECRET = 'x'.repeat(40);
  });

  it('exchanges a valid code (PKCE ok) for access + refresh tokens', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    putAuthCode({ code: 'CODE1', client_id: 'c1', redirect_uri: 'https://client/cb', code_challenge: challenge, email: 'a@b.c', role: 'editor', expires_at: Date.now() + 60_000 });

    const res = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE1', client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.refresh_token).toMatch(/.+/);
    const info = verifyAccessToken(res.body.access_token, { issuer: ISSUER });
    expect(info.email).toBe('a@b.c');
    expect(info.role).toBe('editor');
  });

  it('rejects a code with a bad PKCE verifier', async () => {
    const challenge = createHash('sha256').update('right').digest('base64url');
    putAuthCode({ code: 'CODE2', client_id: 'c1', redirect_uri: 'https://client/cb', code_challenge: challenge, email: 'a@b.c', role: 'editor', expires_at: Date.now() + 60_000 });
    const res = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE2', client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: 'wrong',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rotates a refresh token and rejects its reuse', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    putAuthCode({ code: 'CODE3', client_id: 'c1', redirect_uri: 'https://client/cb', code_challenge: challenge, email: 'a@b.c', role: 'editor', expires_at: Date.now() + 60_000 });
    const first = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE3', client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: verifier,
    });
    const rt = first.body.refresh_token;
    const refreshed = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: rt });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(rt); // rotated
    const reused = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: rt });
    expect(reused.status).toBe(400); // old token no longer valid
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `D 'npx vitest run src/__tests__/oauthRoutes.token.test.ts'`
Expected: FAIL — `/oauth/token` not implemented.

- [ ] **Step 3: Implement token + revoke**

Add imports at the top of `src/routes/oauth.ts` (extend existing import lines):
```ts
import { consumeAuthCode, saveRefreshToken, consumeRefreshToken, revokeRefreshToken } from '../oauth/store';
import { issueAccessToken, generateRefreshToken } from '../oauth/tokens';
import { verifyPkceS256 } from '../oauth/pkce';
```
(Adjust the existing `../oauth/store` import so all named imports are merged into one statement.)

Add a TTL option to the router factory and the routes. First extend the interface:
```ts
export interface OAuthRouterOptions {
  issuer: string;
  accessTokenTtl?: string;   // default '1h'
  refreshTokenTtl?: string;  // default '30d'
}
```
Inside `createOAuthRouter`, near the top:
```ts
  const accessTtl = opts.accessTokenTtl ?? '1h';
  const refreshTtl = opts.refreshTokenTtl ?? '30d';
  const refreshTtlMs = parseDurationMs(refreshTtl);
```
Add this helper at module scope (below `htmlEscape`):
```ts
// Minimal duration parser for refresh-token expiry bookkeeping (s/m/h/d).
function parseDurationMs(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!m) return 30 * 24 * 3600 * 1000;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return n * unit;
}
```
Add the routes before `return router;`:
```ts
  router.post('/oauth/token', asyncHandler(async (req: Request, res: Response) => {
    const grant = req.body?.grant_type;

    if (grant === 'authorization_code') {
      const { code, redirect_uri, code_verifier } = req.body;
      const rec = consumeAuthCode(code);
      if (!rec) return res.status(400).json({ error: 'invalid_grant', error_description: 'unknown or expired code' });
      if (rec.redirect_uri !== redirect_uri) return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      if (!verifyPkceS256(code_verifier, rec.code_challenge)) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      // Re-check admin membership at token time (revocation safety).
      if (!(await isAdminEmail(rec.email))) return res.status(400).json({ error: 'invalid_grant', error_description: 'account no longer authorized' });

      const access_token = issueAccessToken({ email: rec.email, role: rec.role, issuer, ttl: accessTtl });
      const refresh_token = generateRefreshToken();
      await saveRefreshToken(refresh_token, { client_id: rec.client_id, email: rec.email, expires_at: Date.now() + refreshTtlMs });
      return res.json({ token_type: 'Bearer', access_token, refresh_token, expires_in: 3600, scope: 'tenants' });
    }

    if (grant === 'refresh_token') {
      const rec = await consumeRefreshToken(req.body?.refresh_token);
      if (!rec) return res.status(400).json({ error: 'invalid_grant', error_description: 'unknown or expired refresh token' });
      if (!(await isAdminEmail(rec.email))) return res.status(400).json({ error: 'invalid_grant', error_description: 'account no longer authorized' });
      const role = normaliseRole(await getUserRole(rec.email));
      const access_token = issueAccessToken({ email: rec.email, role, issuer, ttl: accessTtl });
      const refresh_token = generateRefreshToken(); // rotation
      await saveRefreshToken(refresh_token, { client_id: rec.client_id, email: rec.email, expires_at: Date.now() + refreshTtlMs });
      return res.json({ token_type: 'Bearer', access_token, refresh_token, expires_in: 3600, scope: 'tenants' });
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  }));

  router.post('/oauth/revoke', asyncHandler(async (req: Request, res: Response) => {
    if (req.body?.token) await revokeRefreshToken(req.body.token);
    res.status(200).json({}); // RFC 7009: always 200
  }));
```

- [ ] **Step 4: Run to verify pass**

Run: `D 'npx vitest run src/__tests__/oauthRoutes.token.test.ts'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/oauth.ts src/__tests__/oauthRoutes.token.test.ts
git commit -m "feat(mcp): oauth token + revoke endpoints with PKCE and refresh rotation"
```

---

## Phase 3 — MCP resource server & tools

### Task 10: OAuthTokenVerifier bridge

**Files:**
- Create: `src/mcp/auth.ts`
- Test: `src/__tests__/mcpAuth.test.ts`

The verifier validates the access token, re-resolves the current role from `admin-users.json` (revocation safety), and returns an `AuthInfo`-shaped object whose `extra` carries `{ email, role }`. The exact `AuthInfo` shape is confirmed in Task 2; this returns `{ token, clientId, scopes, extra }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/mcpAuth.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, isAdminEmail: vi.fn(async () => true), getUserRole: vi.fn(async () => 'editor') };
});

import { createTokenVerifier } from '../mcp/auth';
import { issueAccessToken } from '../oauth/tokens';

const ISSUER = 'https://ow.example.com';

describe('createTokenVerifier', () => {
  beforeEach(() => { process.env.JWT_SECRET = 'x'.repeat(40); });

  it('verifies a token and attaches email + current role', async () => {
    const verifier = createTokenVerifier({ issuer: ISSUER });
    const token = issueAccessToken({ email: 'a@b.c', role: 'viewer', issuer: ISSUER, ttl: '1h' });
    const info = await verifier.verifyAccessToken(token);
    expect(info.extra.email).toBe('a@b.c');
    expect(info.extra.role).toBe('editor'); // re-resolved live, not the token's 'viewer'
  });

  it('rejects a token for a removed admin', async () => {
    const users = await import('../services/users');
    (users.isAdminEmail as any).mockResolvedValueOnce(false);
    const verifier = createTokenVerifier({ issuer: ISSUER });
    const token = issueAccessToken({ email: 'gone@b.c', role: 'editor', issuer: ISSUER, ttl: '1h' });
    await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `D 'npx vitest run src/__tests__/mcpAuth.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the verifier**

```ts
// src/mcp/auth.ts
import { verifyAccessToken } from '../oauth/tokens';
import { isAdminEmail, getUserRole, normaliseRole, AdminRole } from '../services/users';

export interface McpAuthExtra {
  email: string;
  role: AdminRole;
}

export interface McpAuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  extra: McpAuthExtra;
}

// Implements the OAuthTokenVerifier contract consumed by requireBearerAuth:
// an object with async verifyAccessToken(token) -> AuthInfo (throws on invalid).
export function createTokenVerifier(opts: { issuer: string }) {
  return {
    async verifyAccessToken(token: string): Promise<McpAuthInfo> {
      const decoded = verifyAccessToken(token, { issuer: opts.issuer });
      // Revocation safety: token may have been minted before removal.
      if (!(await isAdminEmail(decoded.email))) {
        throw new Error('Access revoked');
      }
      const role = normaliseRole(await getUserRole(decoded.email));
      return {
        token,
        clientId: decoded.email,
        scopes: decoded.scope ? decoded.scope.split(' ') : [],
        extra: { email: decoded.email, role },
      };
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `D 'npx vitest run src/__tests__/mcpAuth.test.ts'`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/auth.ts src/__tests__/mcpAuth.test.ts
git commit -m "feat(mcp): bearer-token verifier bridging to admin-users RBAC"
```

---

### Task 11: MCP audit helper + role-guard helper

**Files:**
- Create: `src/mcp/audit.ts`
- Test: `src/__tests__/mcpAudit.test.ts`

`AuditEntry` (in `src/middleware/audit.ts`) has no `source` field, so MCP origin is encoded as `method: 'MCP'` and `path: '/mcp/<tool>'`. We also add a small `requireToolRole` that throws a typed error tools convert into an MCP error result.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/mcpAudit.test.ts
import { describe, it, expect, vi } from 'vitest';

const writeAuditEntry = vi.fn();
vi.mock('../middleware/audit', () => ({ writeAuditEntry: (...a: any[]) => writeAuditEntry(...a) }));

import { writeMcpAudit, requireToolRole, ToolRoleError } from '../mcp/audit';

describe('mcp audit + role guard', () => {
  it('writes an audit entry tagged as MCP', () => {
    writeMcpAudit({ email: 'a@b.c', tool: 'update_tenant', args: { appId: 'x', tenantId: 'y', imageTag: 'v2' }, status: 200 });
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      user: 'a@b.c', method: 'MCP', path: '/mcp/update_tenant', status: 200,
    }));
  });

  it('requireToolRole throws ToolRoleError when role is insufficient', () => {
    expect(() => requireToolRole('viewer', 'editor')).toThrow(ToolRoleError);
  });

  it('requireToolRole passes when role is sufficient', () => {
    expect(() => requireToolRole('admin', 'editor')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `D 'npx vitest run src/__tests__/mcpAudit.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/mcp/audit.ts
import { writeAuditEntry } from '../middleware/audit';
import { AdminRole, can } from '../services/users';

export class ToolRoleError extends Error {
  constructor(public required: AdminRole, public actual: AdminRole) {
    super(`This action requires '${required}' role; yours is '${actual}'.`);
    this.name = 'ToolRoleError';
  }
}

export function requireToolRole(actual: AdminRole, required: AdminRole): void {
  if (!can(actual, required)) throw new ToolRoleError(required, actual);
}

export function writeMcpAudit(entry: { email: string; tool: string; args?: Record<string, unknown>; status: number }): void {
  writeAuditEntry({
    user: entry.email,
    action: entry.tool,
    method: 'MCP',
    path: `/mcp/${entry.tool}`,
    body: entry.args,
    status: entry.status,
    ip: 'mcp',
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `D 'npx vitest run src/__tests__/mcpAudit.test.ts'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/audit.ts src/__tests__/mcpAudit.test.ts
git commit -m "feat(mcp): mcp audit helper and tool role guard"
```

---

### Task 12: Read tools (`list_apps`, `list_tenants`, `get_tenant`)

**Files:**
- Create: `src/mcp/tools/read.ts`
- Test: `src/__tests__/mcpToolsRead.test.ts`

Each tool is exposed as a pure registration function plus an exported handler so we can unit-test the handler without standing up a transport. The handler takes `(args, auth)` where `auth: McpAuthExtra`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/mcpToolsRead.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/app', () => ({ listApps: vi.fn(async () => [{ id: 'app1', name: 'App One' }]) }));
vi.mock('../services/docker', () => ({
  listTenants: vi.fn(async () => [{ appId: 'app1', tenantId: 't1', domain: 'd', version: 'v1', healthy: true, runningContainers: 1, totalContainers: 1, containers: [] }]),
  getTenantInfo: vi.fn(async (a: string, t: string) => a === 'app1' && t === 't1' ? { appId: 'app1', tenantId: 't1', domain: 'd', version: 'v1' } : null),
}));

import { listAppsHandler, listTenantsHandler, getTenantHandler } from '../mcp/tools/read';

const viewer = { email: 'a@b.c', role: 'viewer' as const };

describe('read tools', () => {
  it('list_apps returns apps for a viewer', async () => {
    const r = await listAppsHandler({}, viewer);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.apps[0].id).toBe('app1');
  });

  it('list_tenants filters by appId', async () => {
    const r = await listTenantsHandler({ appId: 'app1' }, viewer);
    expect(r.structuredContent.tenants).toHaveLength(1);
    expect(r.structuredContent.tenants[0].tenantId).toBe('t1');
  });

  it('get_tenant returns null-shaped error for an unknown tenant', async () => {
    const r = await getTenantHandler({ appId: 'app1', tenantId: 'nope' }, viewer);
    expect(r.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `D 'npx vitest run src/__tests__/mcpToolsRead.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement read tools**

```ts
// src/mcp/tools/read.ts
import { z } from 'zod';
import { listApps } from '../../services/app';
import { listTenants, getTenantInfo } from '../../services/docker';
import { requireToolRole } from '../audit';
import { McpAuthExtra } from '../auth';

type ToolResult = { isError?: boolean; content: { type: 'text'; text: string }[]; structuredContent?: any };

function ok(structured: any, text: string): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}
function err(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export const listAppsInput = z.object({});
export async function listAppsHandler(_args: unknown, auth: McpAuthExtra): Promise<ToolResult> {
  requireToolRole(auth.role, 'viewer');
  const apps = await listApps();
  const slim = apps.map(a => ({ id: a.id, name: a.name }));
  return ok({ apps: slim }, `${slim.length} app(s)`);
}

export const listTenantsInput = z.object({ appId: z.string().optional() });
export async function listTenantsHandler(args: z.infer<typeof listTenantsInput>, auth: McpAuthExtra): Promise<ToolResult> {
  requireToolRole(auth.role, 'viewer');
  const all = await listTenants();
  const tenants = args.appId ? all.filter(t => t.appId === args.appId) : all;
  return ok({ tenants }, `${tenants.length} tenant(s)`);
}

export const getTenantInput = z.object({ appId: z.string(), tenantId: z.string() });
export async function getTenantHandler(args: z.infer<typeof getTenantInput>, auth: McpAuthExtra): Promise<ToolResult> {
  requireToolRole(auth.role, 'viewer');
  const info = await getTenantInfo(args.appId, args.tenantId);
  if (!info) return err(`Tenant ${args.appId}/${args.tenantId} not found`);
  return ok(info, `${info.appId}/${info.tenantId} @ ${info.version}`);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `D 'npx vitest run src/__tests__/mcpToolsRead.test.ts'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/read.ts src/__tests__/mcpToolsRead.test.ts
git commit -m "feat(mcp): read tools (list_apps, list_tenants, get_tenant)"
```

---

### Task 13: Lifecycle tools (`start`/`stop`/`restart`)

**Files:**
- Create: `src/mcp/tools/lifecycle.ts`
- Test: `src/__tests__/mcpToolsLifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/mcpToolsLifecycle.test.ts
import { describe, it, expect, vi } from 'vitest';

const startTenant = vi.fn(async () => {});
const stopTenant = vi.fn(async () => {});
const restartTenant = vi.fn(async () => {});
vi.mock('../services/docker', () => ({ startTenant, stopTenant, restartTenant }));
const writeAuditEntry = vi.fn();
vi.mock('../middleware/audit', () => ({ writeAuditEntry: (...a: any[]) => writeAuditEntry(...a) }));

import { startTenantHandler, stopTenantHandler, restartTenantHandler } from '../mcp/tools/lifecycle';

const editor = { email: 'a@b.c', role: 'editor' as const };
const viewer = { email: 'v@b.c', role: 'viewer' as const };

describe('lifecycle tools', () => {
  it('editor can start; service + audit invoked', async () => {
    const r = await startTenantHandler({ appId: 'app1', tenantId: 't1' }, editor);
    expect(r.isError).toBeFalsy();
    expect(startTenant).toHaveBeenCalledWith('app1', 't1');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ method: 'MCP', path: '/mcp/start_tenant' }));
  });

  it('viewer is denied with a tool error', async () => {
    const r = await stopTenantHandler({ appId: 'app1', tenantId: 't1' }, viewer);
    expect(r.isError).toBe(true);
    expect(stopTenant).not.toHaveBeenCalled();
  });

  it('restart surfaces service failure as a tool error', async () => {
    restartTenant.mockRejectedValueOnce(new Error('compose boom'));
    const r = await restartTenantHandler({ appId: 'app1', tenantId: 't1' }, editor);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('compose boom');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `D 'npx vitest run src/__tests__/mcpToolsLifecycle.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement lifecycle tools**

```ts
// src/mcp/tools/lifecycle.ts
import { z } from 'zod';
import { startTenant, stopTenant, restartTenant } from '../../services/docker';
import { requireToolRole, writeMcpAudit, ToolRoleError } from '../audit';
import { McpAuthExtra } from '../auth';

type ToolResult = { isError?: boolean; content: { type: 'text'; text: string }[]; structuredContent?: any };

export const lifecycleInput = z.object({ appId: z.string(), tenantId: z.string() });

function makeLifecycleHandler(tool: string, fn: (appId: string, tenantId: string) => Promise<void>) {
  return async (args: z.infer<typeof lifecycleInput>, auth: McpAuthExtra): Promise<ToolResult> => {
    try {
      requireToolRole(auth.role, 'editor');
    } catch (e) {
      if (e instanceof ToolRoleError) return { isError: true, content: [{ type: 'text', text: e.message }] };
      throw e;
    }
    try {
      await fn(args.appId, args.tenantId);
      writeMcpAudit({ email: auth.email, tool, args, status: 200 });
      return { content: [{ type: 'text', text: `${tool} ok for ${args.appId}/${args.tenantId}` }], structuredContent: { success: true, ...args } };
    } catch (e: any) {
      writeMcpAudit({ email: auth.email, tool, args, status: 500 });
      return { isError: true, content: [{ type: 'text', text: e?.message || String(e) }] };
    }
  };
}

export const startTenantHandler = makeLifecycleHandler('start_tenant', startTenant);
export const stopTenantHandler = makeLifecycleHandler('stop_tenant', stopTenant);
export const restartTenantHandler = makeLifecycleHandler('restart_tenant', restartTenant);
```

- [ ] **Step 4: Run to verify pass**

Run: `D 'npx vitest run src/__tests__/mcpToolsLifecycle.test.ts'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/lifecycle.ts src/__tests__/mcpToolsLifecycle.test.ts
git commit -m "feat(mcp): lifecycle tools (start/stop/restart) with role gate + audit"
```

---

### Task 14: `update_tenant` tool with progress forwarding

**Files:**
- Create: `src/mcp/tools/update.ts`
- Test: `src/__tests__/mcpToolsUpdate.test.ts`

The handler subscribes to `eventBus` `tenant:update:progress` filtered to this `appId`/`tenantId`, forwards each step via an injected `notify` callback, awaits `updateTenant`, and always unsubscribes. `notify` is injected so the unit test can assert on it; the transport wiring (Task 15) passes a real notifier built from the request's `progressToken`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/mcpToolsUpdate.test.ts
import { describe, it, expect, vi } from 'vitest';

const updateTenant = vi.fn();
vi.mock('../services/tenant', () => ({ updateTenant: (...a: any[]) => updateTenant(...a), validateImageTag: () => ({ valid: true }) }));
const writeAuditEntry = vi.fn();
vi.mock('../middleware/audit', () => ({ writeAuditEntry: (...a: any[]) => writeAuditEntry(...a) }));

import { eventBus } from '../services/eventBus';
import { updateTenantHandler } from '../mcp/tools/update';

const editor = { email: 'a@b.c', role: 'editor' as const };
const viewer = { email: 'v@b.c', role: 'viewer' as const };

describe('update_tenant tool', () => {
  it('forwards progress steps and returns success', async () => {
    const notes: any[] = [];
    updateTenant.mockImplementation(async (appId: string, tenantId: string) => {
      eventBus.emit('tenant:update:progress', { appId, tenantId, newTag: 'v2', step: 'pull', status: 'started' });
      eventBus.emit('tenant:update:progress', { appId, tenantId, newTag: 'v2', step: 'done', status: 'completed' });
    });
    const r = await updateTenantHandler({ appId: 'app1', tenantId: 't1', imageTag: 'v2' }, editor, { notify: async (n) => { notes.push(n); } });
    expect(r.isError).toBeFalsy();
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.some(n => n.message?.includes('pull'))).toBe(true);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ path: '/mcp/update_tenant', status: 200 }));
  });

  it('unsubscribes after completion (no listener leak)', async () => {
    updateTenant.mockResolvedValue(undefined);
    const before = eventBus.listenerCount('tenant:update:progress');
    await updateTenantHandler({ appId: 'app1', tenantId: 't1', imageTag: 'v2' }, editor, { notify: async () => {} });
    expect(eventBus.listenerCount('tenant:update:progress')).toBe(before);
  });

  it('viewer is denied', async () => {
    const r = await updateTenantHandler({ appId: 'app1', tenantId: 't1', imageTag: 'v2' }, viewer, { notify: async () => {} });
    expect(r.isError).toBe(true);
    expect(updateTenant).not.toHaveBeenCalled();
  });

  it('returns tool error on update failure', async () => {
    updateTenant.mockRejectedValueOnce(new Error('pull failed'));
    const r = await updateTenantHandler({ appId: 'app1', tenantId: 't1', imageTag: 'v2' }, editor, { notify: async () => {} });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('pull failed');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `D 'npx vitest run src/__tests__/mcpToolsUpdate.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement update tool**

```ts
// src/mcp/tools/update.ts
import { z } from 'zod';
import { updateTenant, validateImageTag } from '../../services/tenant';
import { eventBus } from '../../services/eventBus';
import { requireToolRole, writeMcpAudit, ToolRoleError } from '../audit';
import { McpAuthExtra } from '../auth';
import type { TenantUpdateProgress } from '../../websocket/types';

type ToolResult = { isError?: boolean; content: { type: 'text'; text: string }[]; structuredContent?: any };

export interface ProgressNotification {
  progress: number;
  total?: number;
  message?: string;
}
export interface UpdateToolContext {
  notify: (n: ProgressNotification) => Promise<void>;
}

export const updateTenantInput = z.object({
  appId: z.string(),
  tenantId: z.string(),
  imageTag: z.string(),
});

// Maps the 4 known update steps to a coarse progress fraction for clients that
// render a bar; message carries the human-readable step+status.
const STEP_ORDER: Record<string, number> = { manifest: 1, config: 2, pull: 3, restart: 4, done: 5, failed: 5 };

export async function updateTenantHandler(
  args: z.infer<typeof updateTenantInput>,
  auth: McpAuthExtra,
  ctx: UpdateToolContext,
): Promise<ToolResult> {
  try {
    requireToolRole(auth.role, 'editor');
  } catch (e) {
    if (e instanceof ToolRoleError) return { isError: true, content: [{ type: 'text', text: e.message }] };
    throw e;
  }

  const tag = validateImageTag(args.imageTag);
  if (!tag.valid) return { isError: true, content: [{ type: 'text', text: tag.error || 'invalid image tag' }] };

  const onProgress = (p: TenantUpdateProgress) => {
    if (p.appId !== args.appId || p.tenantId !== args.tenantId) return;
    // Fire-and-forget; notify errors must not break the update.
    void ctx.notify({
      progress: STEP_ORDER[p.step] ?? 0,
      total: 5,
      message: `${p.step}: ${p.status}${p.detail ? ` — ${p.detail}` : ''}`,
    }).catch(() => {});
  };
  eventBus.on('tenant:update:progress', onProgress);

  try {
    await updateTenant(args.appId, args.tenantId, args.imageTag);
    writeMcpAudit({ email: auth.email, tool: 'update_tenant', args, status: 200 });
    return { content: [{ type: 'text', text: `Updated ${args.appId}/${args.tenantId} to ${args.imageTag}` }], structuredContent: { success: true, ...args } };
  } catch (e: any) {
    writeMcpAudit({ email: auth.email, tool: 'update_tenant', args, status: 500 });
    return { isError: true, content: [{ type: 'text', text: e?.message || String(e) }] };
  } finally {
    eventBus.off('tenant:update:progress', onProgress);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `D 'npx vitest run src/__tests__/mcpToolsUpdate.test.ts'`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/update.ts src/__tests__/mcpToolsUpdate.test.ts
git commit -m "feat(mcp): update_tenant tool with progress notifications + audit"
```

---

### Task 15: MCP server assembly + transport, and wire into Express

**Files:**
- Create: `src/mcp/server.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/mcpServerMount.test.ts`

`buildMcpServer()` constructs the `McpServer`, registers all seven tools (translating the `(args, auth, ctx)` handlers into the SDK's `registerTool` callback by reading `auth` from the bearer context and `progressToken` from request metadata), and returns it. `mountMcp(app, opts)` attaches the OAuth router, the protected-resource metadata route, and the `requireBearerAuth`-guarded `/mcp` transport. `src/index.ts` calls `mountMcp` only when `config.mcp.enabled`.

> Use the exact import paths/signatures pinned in Task 2. The code below uses the documented API; adjust import specifiers if Task 2 recorded different ones.

- [ ] **Step 1: Write the failing mount test (auth gating)**

```ts
// src/__tests__/mcpServerMount.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

let tmpDir: string;
vi.mock('../config', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getDataDir: () => tmpDir };
});

import { mountMcp } from '../mcp/server';

const ISSUER = 'https://ow.example.com';

describe('mountMcp', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-mcpmount-'));
    process.env.JWT_SECRET = 'x'.repeat(40);
    process.env.GOOGLE_CLIENT_ID = 'cid';
  });

  it('serves protected-resource metadata without auth', async () => {
    const app = express();
    app.use(express.json());
    mountMcp(app, { issuer: ISSUER, accessTokenTtl: '1h', refreshTokenTtl: '30d' });
    const res = await request(app).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe('https://ow.example.com/mcp');
  });

  it('rejects an unauthenticated /mcp request with 401 + WWW-Authenticate', async () => {
    const app = express();
    app.use(express.json());
    mountMcp(app, { issuer: ISSUER, accessTokenTtl: '1h', refreshTokenTtl: '30d' });
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `D 'npx vitest run src/__tests__/mcpServerMount.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/server.ts`**

```ts
// src/mcp/server.ts
// MCP SDK versions pinned in Task 2 — record them here:
//   @modelcontextprotocol/server  <version>
//   @modelcontextprotocol/express <version>
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import {
  requireBearerAuth,
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/express';
import { createOAuthRouter, OAuthRouterOptions } from '../routes/oauth';
import { createTokenVerifier, McpAuthExtra } from './auth';
import { authorizationServerMetadata, protectedResourceMetadata } from '../oauth/metadata';
import {
  listAppsInput, listAppsHandler,
  listTenantsInput, listTenantsHandler,
  getTenantInput, getTenantHandler,
} from './tools/read';
import { lifecycleInput, startTenantHandler, stopTenantHandler, restartTenantHandler } from './tools/lifecycle';
import { updateTenantInput, updateTenantHandler } from './tools/update';

export interface MountMcpOptions extends OAuthRouterOptions {}

// Pull our auth context out of the SDK's bearer auth info (set by requireBearerAuth).
function authFrom(ctx: any): McpAuthExtra {
  const extra = ctx?.authInfo?.extra ?? ctx?.auth?.extra;
  if (!extra?.email) throw new Error('missing auth context');
  return extra as McpAuthExtra;
}

function makeNotifier(ctx: any) {
  const progressToken = ctx?.mcpReq?._meta?.progressToken ?? ctx?._meta?.progressToken;
  return {
    notify: async (n: { progress: number; total?: number; message?: string }) => {
      if (progressToken === undefined) return;
      const notify = ctx?.mcpReq?.notify ?? ctx?.notify;
      if (!notify) return;
      await notify({ method: 'notifications/progress', params: { progressToken, ...n } });
    },
  };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'overwatch', version: '1' });

  server.registerTool('list_apps', { description: 'List managed apps', inputSchema: listAppsInput },
    async (args: any, ctx: any) => listAppsHandler(args, authFrom(ctx)));
  server.registerTool('list_tenants', { description: 'List tenants (optionally for one app)', inputSchema: listTenantsInput },
    async (args: any, ctx: any) => listTenantsHandler(args, authFrom(ctx)));
  server.registerTool('get_tenant', { description: 'Get a tenant\'s current image tag and details', inputSchema: getTenantInput },
    async (args: any, ctx: any) => getTenantHandler(args, authFrom(ctx)));

  server.registerTool('start_tenant', { description: 'Start a tenant\'s containers', inputSchema: lifecycleInput },
    async (args: any, ctx: any) => startTenantHandler(args, authFrom(ctx)));
  server.registerTool('stop_tenant', { description: 'Stop a tenant\'s containers', inputSchema: lifecycleInput },
    async (args: any, ctx: any) => stopTenantHandler(args, authFrom(ctx)));
  server.registerTool('restart_tenant', { description: 'Restart a tenant\'s containers', inputSchema: lifecycleInput },
    async (args: any, ctx: any) => restartTenantHandler(args, authFrom(ctx)));

  server.registerTool('update_tenant', { description: 'Update a tenant to a new image tag (streams progress)', inputSchema: updateTenantInput },
    async (args: any, ctx: any) => updateTenantHandler(args, authFrom(ctx), makeNotifier(ctx)));

  return server;
}

export function mountMcp(app: Express, opts: MountMcpOptions): void {
  const { issuer } = opts;

  // OAuth endpoints (register/authorize/token/revoke + AS metadata).
  app.use(createOAuthRouter(opts));

  // Protected Resource Metadata (RFC 9728) via the SDK helper, falling back to
  // our own document so the route exists regardless of helper internals.
  const resourceUrl = protectedResourceMetadata(issuer).resource;
  try {
    app.use(mcpAuthMetadataRouter({
      oauthMetadata: authorizationServerMetadata(issuer) as any,
      resourceServerUrl: new URL(resourceUrl),
    } as any));
  } catch {
    app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => res.json(protectedResourceMetadata(issuer)));
  }

  const verifier = createTokenVerifier({ issuer });
  const bearer = requireBearerAuth({
    verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(resourceUrl)),
  } as any);

  const server = buildMcpServer();
  // Connect the McpServer to a Streamable HTTP transport and expose POST/GET /mcp.
  // The express integration's transport handler is mounted behind bearer auth.
  app.post('/mcp', bearer, server.streamableHttpHandler?.() ?? ((req: Request, res: Response) => server.handleHttpRequest(req, res)));
  app.get('/mcp', bearer, server.streamableHttpHandler?.() ?? ((req: Request, res: Response) => server.handleHttpRequest(req, res)));
}
```

> **Task 2 reconciliation:** the exact transport-mount call (`streamableHttpHandler()` vs a `StreamableHTTPServerTransport` you `connect()` and whose `handleRequest` you call) depends on the pinned version. If Step 4 fails on the transport line, replace the two `app.post/get('/mcp', ...)` lines with the version's documented Streamable-HTTP-on-Express snippet, keeping `bearer` as the first handler. The 401/metadata test must still pass.

- [ ] **Step 4: Run to verify pass**

Run: `D 'npx vitest run src/__tests__/mcpServerMount.test.ts'`
Expected: PASS (2 tests). If the transport line throws at mount time, apply the reconciliation note, then re-run.

- [ ] **Step 5: Wire into `src/index.ts`**

Add import near the other route imports (after line 21):
```ts
import { mountMcp } from './mcp/server';
```
Add the mount block after the global routes are registered (after line 135, before the SPA fallback on line 139):
```ts
  // MCP server + OAuth endpoints — opt-in. Mounted before the SPA fallback so
  // /mcp and /oauth/* are matched as API routes, not served the React index.
  if (config.mcp?.enabled) {
    if (!config.mcp.public_url) {
      console.error('[startup] FATAL: mcp.enabled but mcp.public_url is empty');
      process.exit(1);
    }
    mountMcp(app, {
      issuer: config.mcp.public_url,
      accessTokenTtl: config.mcp.access_token_ttl,
      refreshTokenTtl: config.mcp.refresh_token_ttl,
    });
    console.log(`[startup] MCP server mounted at ${config.mcp.public_url}/mcp`);
  }
```

- [ ] **Step 6: Type-check + full test suite + build**

Run: `D 'npx tsc --noEmit'`
Expected: no errors.
Run: `D 'npm test'`
Expected: all tests pass (existing + new).
Run: `D 'npm run build'`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts src/index.ts src/__tests__/mcpServerMount.test.ts
git commit -m "feat(mcp): assemble MCP server, mount transport + OAuth behind config flag"
```

---

## Phase 4 — Docs

### Task 16: Operator + client connection docs and config example

**Files:**
- Create: `docs/mcp.md`
- Modify: `examples/overwatch.yaml` (or the canonical example config; if none, document in `docs/mcp.md` only)
- Modify: `.env.example` (note: no new env vars required)

- [ ] **Step 1: Write `docs/mcp.md`**

Include: what the MCP server exposes (the seven tools + required role per tool), how to enable it (config `mcp` block with `enabled`, `public_url`, TTLs), the requirement that `/mcp` and `/oauth/*` are reachable through Traefik on `public_url`, the OAuth connection flow from a client's perspective (register → authorize via Google → token → call `/mcp`), that only `admin-users.json` admins can authorize and roles gate tools (read=viewer, update/lifecycle=editor), and the single-process assumption for auth codes. Reference the spec.

```md
# Overwatch MCP Server

Overwatch can expose a remote [Model Context Protocol](https://modelcontextprotocol.io)
server so AI clients can manage tenants. It is **disabled by default**.

## Enabling

In `overwatch.yaml`:

```yaml
mcp:
  enabled: true
  public_url: https://overwatch.example.com   # externally reachable base URL
  access_token_ttl: 1h
  refresh_token_ttl: 30d
```

`public_url` is the OAuth issuer and the token audience; `/mcp` and `/oauth/*`
must be reachable at this URL through your reverse proxy. No new environment
variables are needed — the MCP OAuth server reuses `JWT_SECRET` and
`GOOGLE_CLIENT_ID`.

## Tools and required roles

| Tool | Role |
|------|------|
| `list_apps`, `list_tenants`, `get_tenant` | viewer |
| `update_tenant` | editor |
| `start_tenant`, `stop_tenant`, `restart_tenant` | editor |

Authorization reuses `admin-users.json`: only listed admins can sign in, and
their role gates which tools they can call.

## Connecting a client

1. Point your MCP client at `https://overwatch.example.com/mcp`.
2. The client discovers OAuth metadata, dynamically registers, and opens the
   authorize URL — sign in with your Google admin account.
3. The client receives tokens and calls tools. `update_tenant` streams progress.

See `docs/superpowers/specs/2026-06-01-overwatch-mcp-oauth-design.md` for design details.
```

- [ ] **Step 2: Add the `mcp` block to the example config (if one exists)**

If `examples/overwatch.yaml` exists, append a commented `mcp:` block mirroring the doc. If no example config file exists, skip this step (documented in `docs/mcp.md`).

- [ ] **Step 3: Verify docs build / links**

Run: `D 'test -f docs/mcp.md && echo OK'`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add docs/mcp.md examples/overwatch.yaml .env.example
git commit -m "docs(mcp): operator guide and config example for the MCP server"
```

---

## Final verification

- [ ] **Run the full preflight gate (build + type-check + tests) in Docker:**

Run: `D 'npm run build && npx tsc --noEmit && npm test'`
Expected: build succeeds, no type errors, all tests pass.

- [ ] **Manual smoke (optional, requires a running instance):** enable `mcp` in a dev config, start the server, and confirm:
  - `GET /.well-known/oauth-protected-resource` returns the resource doc.
  - `POST /mcp` without a token returns 401 with `WWW-Authenticate`.
  - A real MCP client can register, authorize via Google, and call `list_apps`.

---

## Notes & deviations from the spec

- **Audit `source` field:** the spec calls for `source: "mcp"`. `AuditEntry` has no such field, so MCP origin is encoded as `method: 'MCP'` + `path: '/mcp/<tool>'` (Task 11). Functionally equivalent for filtering; noted here so a reviewer isn't surprised.
- **Authorize login UI:** resolved Open Question — a minimal dedicated login page served by `/oauth/authorize` runs Google Identity Services (rather than reusing the React `LoginPage`), because the OAuth round-trip needs a server-rendered page carrying the signed request token. CSP already allows `accounts.google.com` (see `src/index.ts:97`).
- **Request integrity across login:** authorize params are carried through the Google login round-trip in a 10-minute signed request-token JWT (`aud: mcp-oauth-request`), so they can't be tampered with before the code is minted.
- **GSI script has no SRI (intentional):** the login page loads `https://accounts.google.com/gsi/client` without a `integrity=` hash. Google ships this as a versionless, frequently-updated script and does not publish a stable hash; pinning one would break sign-in. The existing React `LoginPage` (`ui/src/pages/LoginPage.tsx`) loads it the same way, and CSP restricts `script-src` to `'self' https://accounts.google.com` (`src/index.ts:97`). Accepted risk; do not add SRI to this tag.
```
