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
