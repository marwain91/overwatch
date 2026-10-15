import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';

let tmpDir: string;
vi.mock('../config', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getDataDir: () => tmpDir };
});

import {
  registerClient, getClient,
  putAuthCode, consumeAuthCode,
  saveRefreshToken, consumeRefreshToken,
  sweepOAuthStore, touchClient, UNUSED_CLIENT_TTL_MS, startOAuthSweeper, stopOAuthSweeper, MAX_CLIENTS, CLIENT_IDLE_MS, ClientLimitError,
  redeemRefreshToken, REFRESH_REUSE_GRACE_MS,
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

  async function seed(state: object) {
    await fs.writeFile(path.join(tmpDir, 'mcp-oauth.json'), JSON.stringify(state));
  }
  async function read() {
    return JSON.parse(await fs.readFile(path.join(tmpDir, 'mcp-oauth.json'), 'utf8'));
  }
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it('sweep drops expired auth codes', async () => {
    putAuthCode({ code: 'dead', client_id: 'c1', redirect_uri: 'https://c/cb', code_challenge: 'ch', email: 'a@b.c', role: 'editor', expires_at: Date.now() - 1 });
    putAuthCode({ code: 'live', client_id: 'c1', redirect_uri: 'https://c/cb', code_challenge: 'ch', email: 'a@b.c', role: 'editor', expires_at: Date.now() + 60_000 });
    const r = await sweepOAuthStore();
    expect(r.authCodes).toBe(1);
    expect(consumeAuthCode('live')?.email).toBe('a@b.c');
  });

  it('sweep removes expired refresh tokens and keeps live ones', async () => {
    await saveRefreshToken('old', { client_id: 'c1', email: 'a@b.c', expires_at: Date.now() - 1000 });
    await saveRefreshToken('new', { client_id: 'c1', email: 'a@b.c', expires_at: Date.now() + 60_000 });
    const r = await sweepOAuthStore();
    expect(r.refreshTokens).toBe(1);
    expect((await read()).refreshTokens).toHaveLength(1);
    expect((await consumeRefreshToken('new'))?.email).toBe('a@b.c');
  });

  it('sweep prunes clients idle for 90 days (and their refresh tokens) but keeps recent ones', async () => {
    await seed({
      clients: [
        { client_id: 'stale', redirect_uris: ['https://c/cb'], created_at: iso(CLIENT_IDLE_MS + 1000) },
        { client_id: 'stale-used-long-ago', redirect_uris: ['https://c/cb'], created_at: iso(CLIENT_IDLE_MS * 2), last_used_at: iso(CLIENT_IDLE_MS + 1000) },
        { client_id: 'fresh-old-created', redirect_uris: ['https://c/cb'], created_at: iso(CLIENT_IDLE_MS * 2), last_used_at: iso(1000) },
        { client_id: 'fresh', redirect_uris: ['https://c/cb'], created_at: iso(1000) },
      ],
      refreshTokens: [{ token_hash: 'h', client_id: 'stale', email: 'a@b.c', expires_at: Date.now() + 60_000 }],
    });
    const r = await sweepOAuthStore();
    expect(r.clients).toBe(2);
    const st = await read();
    expect(st.clients.map((c: any) => c.client_id).sort()).toEqual(['fresh', 'fresh-old-created']);
    expect(st.refreshTokens).toHaveLength(0);
  });

  it('sweep does not create or rewrite the store when nothing changed', async () => {
    await sweepOAuthStore();
    await expect(fs.access(path.join(tmpDir, 'mcp-oauth.json'))).rejects.toThrow();
  });

  it('touchClient refreshes last_used_at so an active client survives pruning', async () => {
    await seed({ clients: [{ client_id: 'a', redirect_uris: ['https://c/cb'], created_at: iso(CLIENT_IDLE_MS + 1000) }], refreshTokens: [] });
    await touchClient('a');
    expect((await sweepOAuthStore()).clients).toBe(0);
    expect((await getClient('a'))?.last_used_at).toBeDefined();
  });

  it('prunes never-used clients after 24h but keeps used ones', async () => {
    await seed({
      clients: [
        { client_id: 'unused-old', redirect_uris: ['https://c/cb'], created_at: iso(UNUSED_CLIENT_TTL_MS + 1000) },
        { client_id: 'unused-new', redirect_uris: ['https://c/cb'], created_at: iso(1000) },
        { client_id: 'used-old', redirect_uris: ['https://c/cb'], created_at: iso(UNUSED_CLIENT_TTL_MS * 5), last_used_at: iso(UNUSED_CLIENT_TTL_MS * 2) },
      ],
      refreshTokens: [],
    });
    expect((await sweepOAuthStore()).clients).toBe(1);
    expect((await read()).clients.map((c: any) => c.client_id).sort()).toEqual(['unused-new', 'used-old']);
  });

  it('at the cap, registration evicts the oldest never-used client', async () => {
    const clients = Array.from({ length: MAX_CLIENTS }, (_, i) => ({
      client_id: `c${i}`, redirect_uris: ['https://c/cb'], created_at: iso(10_000 - i), // c0 oldest
    }));
    clients[5] = { ...clients[5], last_used_at: iso(1) } as any;
    await seed({ clients, refreshTokens: [] });
    const c = await registerClient({ client_name: 'new', redirect_uris: ['https://c/cb'] });
    const ids = (await read()).clients.map((x: any) => x.client_id);
    expect(ids).toHaveLength(MAX_CLIENTS);
    expect(ids).not.toContain('c0');
    expect(ids).toContain('c1');
    expect(ids).toContain('c5');
    expect(ids).toContain(c.client_id);
  });

  it('sweeper can be started and stopped', () => {
    startOAuthSweeper();
    startOAuthSweeper();
    stopOAuthSweeper();
    stopOAuthSweeper();
  });

  it('registerClient prunes idle clients before enforcing the cap', async () => {
    const clients = Array.from({ length: MAX_CLIENTS }, (_, i) => ({
      client_id: `c${i}`, redirect_uris: ['https://c/cb'], created_at: iso(CLIENT_IDLE_MS + 1000), last_used_at: iso(CLIENT_IDLE_MS + 1000),
    }));
    await seed({ clients, refreshTokens: [] });
    const c = await registerClient({ client_name: 'new', redirect_uris: ['https://c/cb'] });
    expect((await read()).clients).toHaveLength(1);
    expect(c.client_id).toMatch(/.+/);
  });

  it('registerClient throws ClientLimitError when full of active clients', async () => {
    const clients = Array.from({ length: MAX_CLIENTS }, (_, i) => ({
      client_id: `c${i}`, redirect_uris: ['https://c/cb'], created_at: iso(1000), last_used_at: iso(1000),
    }));
    await seed({ clients, refreshTokens: [] });
    await expect(registerClient({ client_name: 'new', redirect_uris: ['https://c/cb'] })).rejects.toBeInstanceOf(ClientLimitError);
  });

  describe('refresh token families', () => {
    const sha = (t: string) => createHash('sha256').update(t).digest('hex');
    const live = (token: string, extra: object = {}) => ({
      token_hash: sha(token), client_id: 'c1', email: 'a@b.c', expires_at: Date.now() + 60_000, ...extra,
    });

    it('a rotation carries the family and remembers the rotated-out token', async () => {
      await saveRefreshToken('RT1', { client_id: 'c1', email: 'a@b.c', expires_at: Date.now() + 60_000, family_id: 'F', granted_at: 1 });
      const r = await redeemRefreshToken('RT1', 'c1');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.record.family_id).toBe('F');
      expect(r.record.granted_at).toBe(1);
      expect(r.record.rotated?.map(x => x.token_hash)).toEqual([sha('RT1')]);
    });

    it('presenting an already-rotated token revokes the whole family', async () => {
      await seed({ clients: [], refreshTokens: [
        live('RT2', { family_id: 'F', granted_at: 1, rotated: [{ token_hash: sha('RT1'), at: Date.now() - REFRESH_REUSE_GRACE_MS - 1000 }] }),
        live('OTHER', { family_id: 'G', granted_at: 1 }),
      ] });
      const r = await redeemRefreshToken('RT1', 'c1');
      expect(r).toMatchObject({ ok: false, reason: 'reused', family_id: 'F', email: 'a@b.c', client_id: 'c1' });
      expect(await consumeRefreshToken('RT2', 'c1')).toBeUndefined();
      expect((await consumeRefreshToken('OTHER', 'c1'))?.family_id).toBe('G');
    });

    it('a replay right after the rotation (a client racing itself) is refused without revoking the family', async () => {
      await seed({ clients: [], refreshTokens: [
        live('RT2', { family_id: 'F', granted_at: 1, rotated: [{ token_hash: sha('RT1'), at: Date.now() }] }),
      ] });
      expect(await redeemRefreshToken('RT1', 'c1')).toMatchObject({ ok: false, reason: 'unknown' });
      expect((await consumeRefreshToken('RT2', 'c1'))?.family_id).toBe('F');
    });

    it('a rotated token presented by another client does not revoke the family', async () => {
      await seed({ clients: [], refreshTokens: [
        live('RT2', { family_id: 'F', granted_at: 1, rotated: [{ token_hash: sha('RT1'), at: 0 }] }),
      ] });
      expect(await redeemRefreshToken('RT1', 'evil')).toMatchObject({ ok: false, reason: 'unknown' });
      expect((await consumeRefreshToken('RT2', 'c1'))?.family_id).toBe('F');
    });

    it('keeps only the most recent rotated hashes per family', async () => {
      let rotated: { token_hash: string; at: number }[] | undefined;
      for (let i = 0; i < 8; i++) {
        await saveRefreshToken(`R${i}`, { client_id: 'c1', email: 'a@b.c', expires_at: Date.now() + 60_000, family_id: 'F', granted_at: 1, rotated });
        const r = await redeemRefreshToken(`R${i}`, 'c1');
        if (!r.ok) throw new Error('expected ok');
        rotated = r.record.rotated;
      }
      expect(rotated?.map(x => x.token_hash)).toEqual([3, 4, 5, 6, 7].map(i => sha(`R${i}`)));
    });

    it('a record from before families still works once', async () => {
      await seed({ clients: [], refreshTokens: [live('LEGACY')] });
      const r = await redeemRefreshToken('LEGACY', 'c1');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.record.family_id).toBeUndefined();
      expect(r.record.rotated?.map(x => x.token_hash)).toEqual([sha('LEGACY')]);
      expect(await redeemRefreshToken('LEGACY', 'c1')).toMatchObject({ ok: false });
    });
  });
});
