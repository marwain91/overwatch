import * as path from 'path';
import * as crypto from 'crypto';
import { promises as fsp } from 'fs';
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

// The store is read on every authorize, token and refresh call. The parsed
// file is cached under its stat signature; an atomic write renames a new
// inode into place, so any write (ours or the CLI's) changes the signature.
let cache: { file: string; sig: string; state: OAuthFile } | undefined;

const signature = (st: { ino: number; size: number; mtimeMs: number }) => `${st.ino}:${st.size}:${st.mtimeMs}`;

// Shared, read-only view. Callers that change the store use readMutableState.
async function readFileState(): Promise<OAuthFile> {
  const file = storeFile();
  let sig: string;
  try {
    sig = signature(await fsp.stat(file));
  } catch (err: any) {
    if (err.code === 'ENOENT') return { clients: [], refreshTokens: [] };
    throw err;
  }
  if (cache?.file === file && cache.sig === sig) return cache.state;
  try {
    const parsed = await readJsonStrict<Partial<OAuthFile>>(file);
    const state = { clients: parsed.clients ?? [], refreshTokens: parsed.refreshTokens ?? [] };
    cache = { file, sig, state };
    return state;
  } catch (err: any) {
    if (err.code === 'ENOENT') return { clients: [], refreshTokens: [] };
    throw err; // readJsonStrict already formats the JSON-parse error message
  }
}

// A private copy to modify under the 'mcp-oauth' lock: a failed write must not
// leave the change in the cached view.
async function readMutableState(): Promise<OAuthFile> {
  return structuredClone(await readFileState());
}

async function writeFileState(state: OAuthFile): Promise<void> {
  const file = storeFile();
  await writeJsonAtomic(file, state, { mode: 0o600 });
  cache = { file, sig: signature(await fsp.stat(file)), state: structuredClone(state) };
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---- Clients (persisted) ----
export const MAX_CLIENTS = 200;
export const CLIENT_IDLE_MS = 90 * 24 * 3600 * 1000;
// Clients that never completed an authorization expire quickly so unauthenticated
// registrations can't squat the cap.
export const UNUSED_CLIENT_TTL_MS = 24 * 3600 * 1000;
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
  const keep = state.clients.filter(c =>
    now - lastActivityMs(c) <= (c.last_used_at ? CLIENT_IDLE_MS : UNUSED_CLIENT_TTL_MS));
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
    const state = await readMutableState();
    pruneIdleClients(state, Date.now());
    if (state.clients.length >= MAX_CLIENTS) {
      // Evict the oldest never-used client; refuse only when every client has been used.
      let oldest = -1;
      state.clients.forEach((c, i) => {
        if (!c.last_used_at && (oldest === -1 || lastActivityMs(c) < lastActivityMs(state.clients[oldest]))) oldest = i;
      });
      if (oldest === -1) throw new ClientLimitError();
      const [gone] = state.clients.splice(oldest, 1);
      state.refreshTokens = state.refreshTokens.filter(t => t.client_id !== gone.client_id);
    }
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
  const found = (await readFileState()).clients.find(c => c.client_id === clientId);
  return found && structuredClone(found); // never hand out the cached object
}

const touchDue = (c: RegisteredClient | undefined): c is RegisteredClient =>
  !!c && !(c.last_used_at && Date.now() - lastActivityMs(c) < TOUCH_INTERVAL_MS);

// Records that a client was used so active clients are not pruned.
export async function touchClient(clientId: string): Promise<void> {
  // Usually a no-op (at most one write a day): decide from the cached view
  // before taking the lock.
  if (!touchDue((await readFileState()).clients.find(x => x.client_id === clientId))) return;
  return withFileLock('mcp-oauth', async () => {
    const state = await readMutableState();
    const c = state.clients.find(x => x.client_id === clientId);
    if (!touchDue(c)) return;
    c.last_used_at = new Date().toISOString();
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
// A rotated-out token presented again means the family leaked; the whole
// family is revoked. A replay within the grace window is a client racing
// itself (parallel refreshes) and is only refused.
export const REFRESH_REUSE_GRACE_MS = 10_000;
const MAX_ROTATED_REMEMBERED = 5;

export type RefreshGrant = Omit<RefreshTokenRecord, 'token_hash'>;
export type RefreshRedemption =
  | { ok: true; record: RefreshGrant }
  | { ok: false; reason: 'unknown' | 'expired' }
  | { ok: false; reason: 'reused'; family_id: string; client_id: string; email: string };

export async function saveRefreshToken(token: string, rec: RefreshGrant): Promise<void> {
  return withFileLock('mcp-oauth', async () => {
    const state = await readMutableState();
    state.refreshTokens.push({ token_hash: sha256(token), ...rec });
    await writeFileState(state);
  });
}

// Removes the record (rotation) and returns it with its own hash appended to
// `rotated`, ready to be carried into the successor. With expectedClientId,
// a token owned by another client is left untouched so a third party can't
// revoke a session just by presenting its token.
export async function redeemRefreshToken(token: string, expectedClientId?: string): Promise<RefreshRedemption> {
  return withFileLock('mcp-oauth', async () => {
    const state = await readMutableState();
    const hash = sha256(token);
    const now = Date.now();
    const idx = state.refreshTokens.findIndex(t => t.token_hash === hash);
    if (idx === -1) {
      const family = state.refreshTokens.find(t => t.family_id && t.rotated?.some(r => r.token_hash === hash));
      if (!family || (expectedClientId !== undefined && family.client_id !== expectedClientId)) return { ok: false, reason: 'unknown' };
      const rotatedAt = family.rotated!.find(r => r.token_hash === hash)!.at;
      if (now - rotatedAt < REFRESH_REUSE_GRACE_MS) return { ok: false, reason: 'unknown' };
      state.refreshTokens = state.refreshTokens.filter(t => t.family_id !== family.family_id);
      await writeFileState(state);
      return { ok: false, reason: 'reused', family_id: family.family_id!, client_id: family.client_id, email: family.email };
    }
    if (expectedClientId !== undefined && state.refreshTokens[idx].client_id !== expectedClientId) return { ok: false, reason: 'unknown' };
    // Splice + persist unconditionally so an expired token can't be replayed.
    const [rec] = state.refreshTokens.splice(idx, 1);
    await writeFileState(state);
    if (rec.expires_at < now) return { ok: false, reason: 'expired' };
    const { token_hash, rotated, ...rest } = rec;
    return { ok: true, record: { ...rest, rotated: [...(rotated ?? []), { token_hash, at: now }].slice(-MAX_ROTATED_REMEMBERED) } };
  });
}

// Returns the record and removes it (rotation). Expired/unknown/reused -> undefined.
export async function consumeRefreshToken(token: string, expectedClientId?: string): Promise<RefreshGrant | undefined> {
  const r = await redeemRefreshToken(token, expectedClientId);
  return r.ok ? r.record : undefined;
}

// Consuming = revoking. Returns the revoked grant, if the token was live.
export async function revokeRefreshToken(token: string): Promise<RefreshGrant | undefined> {
  return consumeRefreshToken(token);
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
    const state = await readMutableState();
    const tokensBefore = state.refreshTokens.length;
    state.refreshTokens = state.refreshTokens.filter(t => t.expires_at >= now);
    const clients = pruneIdleClients(state, now);
    const refreshTokens = tokensBefore - state.refreshTokens.length;
    if (refreshTokens > 0 || clients > 0) await writeFileState(state);
    return { authCodes: swept, refreshTokens, clients };
  });
}

let sweeper: NodeJS.Timeout | undefined;

export function stopOAuthSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = undefined;
}

export function startOAuthSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    sweepOAuthStore().catch(err => console.error('[oauth] store sweep failed:', err?.message || err));
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
}
