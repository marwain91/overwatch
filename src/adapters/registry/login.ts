import { DockerCommandError, runDocker } from '../../utils/runDocker';

/** Bound on one `docker login`, and on each AWS CLI call ECR makes. */
export const REGISTRY_LOGIN_TIMEOUT_MS = 60_000;

/** A login is reused this long; ECR's docker credentials expire after 12 h. */
export const REGISTRY_LOGIN_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Docker keeps one credential per registry host, and the docker CLI and
 * compose read it once, when they start. After ensureRegistryLogin returns,
 * the host stays reserved for that credential this long, so the caller's pull
 * starts before another app's credential for the same host replaces it.
 */
export const REGISTRY_LOGIN_HOLD_MS = 60_000;

/**
 * The login could not run, or its result could not be stored: no AWS CLI or no
 * AWS credentials for ECR, or a read-only docker config (the host's
 * `/root/.docker` mounted `:ro` when Overwatch runs as root).
 */
export class RegistryLoginUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryLoginUnavailableError';
  }
}

/**
 * `docker login` with the secret on stdin. `server` undefined means Docker Hub.
 * `--` ends the options, so a server address can never be read as a flag.
 */
export async function dockerLogin(server: string | undefined, username: string, secret: string): Promise<void> {
  const args = ['login', `--username=${username}`, '--password-stdin'];
  if (server !== undefined) args.push('--', server);
  try {
    await runDocker('docker', args, { timeoutMs: REGISTRY_LOGIN_TIMEOUT_MS, input: secret });
  } catch (err) {
    if (err instanceof DockerCommandError && /error saving credentials/i.test(err.stderr)) {
      throw new RegistryLoginUnavailableError(`docker login could not store the credentials (${err.stderr.trim()})`);
    }
    throw err;
  }
}

/** One app's registry login, as the per-host gate sees it. */
export interface RegistryLoginTarget {
  /** Registry host as docker keys stored credentials (no path), lowercased. */
  host: string;
  /** Hash of everything the login uses; equal fingerprints share one login. */
  fingerprint: string;
  /** Who logs in, for messages: "app 'x'". */
  label: string;
  login: () => Promise<void>;
}

interface HostState {
  /** Credential admitted to the host while holders > 0. */
  fingerprint: string | null;
  holders: number;
  waiters: Array<{ fingerprint: string; admit: () => void }>;
  /** Credential docker's config holds for this host, as far as Overwatch knows. */
  stored: { fingerprint: string; at: number } | null;
}

const hosts = new Map<string, HostState>();
// All registry logins live in one docker config file that each `docker login`
// rewrites, so two logins at once, even to different hosts, can lose an entry.
let loginQueue: Promise<unknown> = Promise.resolve();

function hostState(host: string): HostState {
  let state = hosts.get(host);
  if (!state) {
    state = { fingerprint: null, holders: 0, waiters: [], stored: null };
    hosts.set(host, state);
  }
  return state;
}

// Callers with the same credential share a host; different credentials take
// turns, in arrival order (each turn admits every waiter with that credential).
function acquireHost(state: HostState, fingerprint: string): Promise<() => void> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    state.holders--;
    if (state.holders > 0 || state.waiters.length === 0) return;
    const next = state.waiters[0].fingerprint;
    const admitted = state.waiters.filter(w => w.fingerprint === next);
    state.waiters = state.waiters.filter(w => w.fingerprint !== next);
    state.fingerprint = next;
    state.holders += admitted.length;
    for (const w of admitted) w.admit();
  };
  if (state.waiters.length === 0 && (state.holders === 0 || state.fingerprint === fingerprint)) {
    state.fingerprint = fingerprint;
    state.holders++;
    return Promise.resolve(release);
  }
  return new Promise(resolve => state.waiters.push({ fingerprint, admit: () => resolve(release) }));
}

function failureReason(err: unknown): string {
  if (err instanceof DockerCommandError && err.kind !== 'timeout') {
    const lines = err.stderr.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) return lines[lines.length - 1];
  }
  return err instanceof Error ? err.message : String(err);
}

function isFresh(state: HostState, fingerprint: string): boolean {
  const stored = state.stored;
  return !!stored && stored.fingerprint === fingerprint && Date.now() - stored.at < REGISTRY_LOGIN_TTL_MS;
}

// The caller holds the host for target.fingerprint, so no other credential can
// replace a fresh login while this runs.
//
// A failed login never fails the pull. Before per-pull logins only boot logged
// in, and a failure there just warned: pulls ran with whatever docker had (the
// host's mounted credentials, another login, anonymous access to public
// images). The warning names the registry and the reason.
function loginIfNeeded(state: HostState, target: RegistryLoginTarget): Promise<void> {
  if (isFresh(state, target.fingerprint)) return Promise.resolve();
  const run = loginQueue.then(async () => {
    if (isFresh(state, target.fingerprint)) return;
    state.stored = null;
    try {
      await target.login();
    } catch (err) {
      const reason = err instanceof RegistryLoginUnavailableError
        ? `Registry login to ${target.host} skipped for ${target.label}: ${err.message}`
        : `Registry login to ${target.host} failed for ${target.label}: ${failureReason(err)}`;
      console.warn(`[registry] ${reason}. Pulling with the existing docker credentials.`);
      return;
    }
    state.stored = { fingerprint: target.fingerprint, at: Date.now() };
  });
  loginQueue = run.catch(() => undefined);
  return run;
}

/** Log in unless a fresh login with this credential exists, then run `fn` while holding the host. */
export async function runWithRegistryLogin<T>(target: RegistryLoginTarget, fn: () => Promise<T>): Promise<T> {
  const state = hostState(target.host);
  const release = await acquireHost(state, target.fingerprint);
  try {
    await loginIfNeeded(state, target);
    return await fn();
  } finally {
    release();
  }
}

/** Log in if needed, then keep the host for this credential for REGISTRY_LOGIN_HOLD_MS. */
export async function holdRegistryLogin(target: RegistryLoginTarget): Promise<void> {
  const state = hostState(target.host);
  const release = await acquireHost(state, target.fingerprint);
  try {
    await loginIfNeeded(state, target);
  } catch (err) {
    release();
    throw err;
  }
  setTimeout(release, REGISTRY_LOGIN_HOLD_MS).unref();
}
