import * as path from 'path';
import * as crypto from 'crypto';
import { getDataDir } from '../config';
import { withFileLock } from '../services/fileLock';
import { writeJsonAtomic, readJsonStrict } from '../utils/atomicJson';
import { RegisteredClient, AuthCode, RefreshTokenRecord } from './types';

interface OAuthFile {
  clients: RegisteredClient[];
  refreshTokens: RefreshTokenRecord[];
}

function storeFile(): string {
  return path.join(getDataDir(), 'mcp-oauth.json');
}

async function readFileState(): Promise<OAuthFile> {
  try {
    const parsed = await readJsonStrict<Partial<OAuthFile>>(storeFile());
    return { clients: parsed.clients ?? [], refreshTokens: parsed.refreshTokens ?? [] };
  } catch (err: any) {
    if (err.code === 'ENOENT') return { clients: [], refreshTokens: [] };
    throw err; // readJsonStrict already formats the JSON-parse error message
  }
}

async function writeFileState(state: OAuthFile): Promise<void> {
  await writeJsonAtomic(storeFile(), state, { mode: 0o600 });
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---- Clients (persisted) ----
export const MAX_CLIENTS = 200;
export const CLIENT_IDLE_MS = 90 * 24 * 3600 * 1000;
const TOUCH_INTERVAL_MS = 24 * 3600 * 1000; // avoid a store write on every request

export class ClientLimitError extends Error {
  constructor() {
    super('too many registered OAuth clients');
    this.name = 'ClientLimitError';
  }
}

function lastActivityMs(c: RegisteredClient): number {
  const t = Date.parse(c.last_used_at ?? c.created_at);
  return Number.isNaN(t) ? 0 : t; // unparseable timestamp -> treat as idle rather than keep forever
}

// Drops clients idle for CLIENT_IDLE_MS plus their refresh tokens. Mutates state.
function pruneIdleClients(state: OAuthFile, now: number): number {
  const keep = state.clients.filter(c => now - lastActivityMs(c) <= CLIENT_IDLE_MS);
  const removed = state.clients.length - keep.length;
  if (removed > 0) {
    const ids = new Set(keep.map(c => c.client_id));
    state.clients = keep;
    state.refreshTokens = state.refreshTokens.filter(t => ids.has(t.client_id));
  }
  return removed;
}

export async function registerClient(input: { client_name?: string; redirect_uris: string[] }): Promise<RegisteredClient> {
  return withFileLock('mcp-oauth', async () => {
    const state = await readFileState();
    pruneIdleClients(state, Date.now());
    if (state.clients.length >= MAX_CLIENTS) throw new ClientLimitError();
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

// Records that a client was used so active clients are not pruned.
export async function touchClient(clientId: string): Promise<void> {
  return withFileLock('mcp-oauth', async () => {
    const state = await readFileState();
    const c = state.clients.find(x => x.client_id === clientId);
    if (!c) return;
    const now = Date.now();
    if (now - lastActivityMs(c) < TOUCH_INTERVAL_MS && c.last_used_at) return;
    c.last_used_at = new Date(now).toISOString();
    await writeFileState(state);
  });
}

// ---- Auth codes (in-memory, single-use, short-lived) ----
const authCodes = new Map<string, AuthCode>();

export function putAuthCode(code: AuthCode): void {
  authCodes.set(code.code, code);
}

// ---- Consent nonces (in-memory, single-use) ----
// A consent token may be redeemed once; otherwise a replayed POST could mint extra codes.
const consentNonces = new Map<string, number>();

export function putConsentNonce(nonce: string, expiresAt: number): void {
  consentNonces.set(nonce, expiresAt);
}

export function consumeConsentNonce(nonce: string): boolean {
  const exp = consentNonces.get(nonce);
  if (exp === undefined) return false;
  consentNonces.delete(nonce);
  return exp >= Date.now();
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
    // Splice + persist unconditionally so an expired token can't be replayed.
    const [rec] = state.refreshTokens.splice(idx, 1);
    await writeFileState(state);
    if (rec.expires_at < Date.now()) return undefined; // consumed but expired
    const { token_hash, ...rest } = rec;
    return rest;
  });
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await consumeRefreshToken(token); // consuming = revoking
}

// ---- Periodic sweep ----
export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

// Removes expired codes/nonces (memory) and expired refresh tokens + idle clients (file).
// Only writes the store when something was removed.
export async function sweepOAuthStore(): Promise<{ authCodes: number; refreshTokens: number; clients: number }> {
  const now = Date.now();
  let swept = 0;
  for (const [k, v] of authCodes) if (v.expires_at < now) { authCodes.delete(k); swept++; }
  for (const [k, exp] of consentNonces) if (exp < now) consentNonces.delete(k);

  return withFileLock('mcp-oauth', async () => {
    const state = await readFileState();
    const tokensBefore = state.refreshTokens.length;
    state.refreshTokens = state.refreshTokens.filter(t => t.expires_at >= now);
    const clients = pruneIdleClients(state, now);
    const refreshTokens = tokensBefore - state.refreshTokens.length;
    if (refreshTokens > 0 || clients > 0) await writeFileState(state);
    return { authCodes: swept, refreshTokens, clients };
  });
}

let sweeper: NodeJS.Timeout | undefined;

export function startOAuthSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    sweepOAuthStore().catch(err => console.error('[oauth] store sweep failed:', err?.message || err));
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
}
