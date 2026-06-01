import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDataDir } from '../config';
import { withFileLock } from '../services/fileLock';
import { writeJsonAtomic } from '../utils/atomicJson';
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
