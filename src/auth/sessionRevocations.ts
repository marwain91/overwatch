import * as path from 'path';
import { promises as fsp } from 'fs';
import { getDataDir } from '../config';
import { withFileLock } from '../services/fileLock';
import { readJsonStrict, writeJsonAtomic } from '../utils/atomicJson';

// Web sessions revoked by logout, by jti, until the token would have expired
// anyway. Checked on every authenticated request and WebSocket re-check.
interface RevocationFile {
  revoked: Record<string, number>; // jti -> token exp (epoch seconds)
}

function storeFile(): string {
  return path.join(getDataDir(), 'revoked-sessions.json');
}

// Parsed file cached under its stat signature (atomic writes change the inode).
let cache: { file: string; sig: string; revoked: Record<string, number> } | undefined;
let reportedSig: string | undefined;

async function readRevoked(): Promise<Record<string, number>> {
  const file = storeFile();
  let sig: string;
  try {
    const st = await fsp.stat(file);
    sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (cache?.file === file && cache.sig === sig) return cache.revoked;
  const parsed = await readJsonStrict<Partial<RevocationFile>>(file);
  const revoked = parsed && typeof parsed.revoked === 'object' && parsed.revoked ? parsed.revoked : {};
  cache = { file, sig, revoked };
  return revoked;
}

/**
 * Logout is defense in depth on top of the 24 h token expiry, so an
 * unreadable store must not lock every admin out: it is reported loudly
 * and treated as empty (the behaviour before logout revoked sessions).
 */
export async function isSessionRevoked(jti: string): Promise<boolean> {
  try {
    return Object.prototype.hasOwnProperty.call(await readRevoked(), jti);
  } catch (err: any) {
    const sig = String(err?.message || err);
    if (reportedSig !== sig) {
      reportedSig = sig;
      console.error(`[auth] Cannot read ${storeFile()}; logged-out sessions are NOT being rejected: ${sig}`);
    }
    return false;
  }
}

export async function revokeSession(jti: string, exp: number): Promise<void> {
  await withFileLock('revoked-sessions', async () => {
    const now = Math.floor(Date.now() / 1000);
    const revoked: Record<string, number> = {};
    for (const [id, e] of Object.entries(await readRevoked())) if (e > now) revoked[id] = e;
    if (exp > now) revoked[jti] = exp;
    await writeJsonAtomic(storeFile(), { revoked } satisfies RevocationFile, { mode: 0o600 });
  });
}
