import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchNoRedirect } from '../adapters/registry/safeFetch';

export interface ImageRef {
  registry: string;
  repo: string;
}

export interface RegistryAuth {
  user: string;
  token: string;
}

/** Bound on one registry request (token exchange or one tag list page). */
export const REGISTRY_REQUEST_TIMEOUT_MS = 30_000;

/** Pages of 100 tags read before a listing counts as endless. */
export const MAX_TAG_PAGES = 100;

/** A registry answered a token exchange or tag list request with a non-2xx status. */
export class RegistryHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RegistryHttpError';
    this.status = status;
  }
}

/**
 * Parse an image reference like `ghcr.io/ns/name:tag` into `{ registry, repo }`.
 * Mirrors containerd/docker heuristics: the first path segment is treated as a
 * registry host only if it contains `.`, `:`, or equals `localhost`; otherwise
 * it falls back to `docker.io`.
 */
export function parseImageRef(image: string): ImageRef {
  const noTag = image.split('@')[0].replace(/:[^/]+$/, '');
  const firstSlash = noTag.indexOf('/');
  if (firstSlash < 0) {
    return { registry: 'docker.io', repo: `library/${noTag}` };
  }
  const head = noTag.slice(0, firstSlash);
  const rest = noTag.slice(firstSlash + 1);
  if (head.includes('.') || head.includes(':') || head === 'localhost') {
    return { registry: head, repo: rest };
  }
  return { registry: 'docker.io', repo: noTag };
}

/**
 * Read credentials for the given registry from `~/.docker/config.json`.
 * Returns `null` when no entry exists or the file is unreadable/malformed —
 * callers should fall back to anonymous access.
 */
function readRegistryAuth(registry: string): RegistryAuth | null {
  const configPath = path.join(os.homedir(), '.docker', 'config.json');
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
  const entry = parsed?.auths?.[registry]?.auth;
  if (typeof entry !== 'string' || !entry) return null;
  const decoded = Buffer.from(entry, 'base64').toString('utf-8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { user: decoded.slice(0, colon), token: decoded.slice(colon + 1) };
}

async function exchangeToken(registry: string, repo: string, auth: RegistryAuth | null): Promise<string> {
  const url = `https://${registry}/token?scope=repository:${repo}:pull&service=${registry}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (auth) {
    const basic = Buffer.from(`${auth.user}:${auth.token}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  }
  const res = await fetchNoRedirect(url, { headers, signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS) });
  if (!res.ok) {
    throw new RegistryHttpError(`registry token exchange failed (HTTP ${res.status})`, res.status);
  }
  const json = (await res.json()) as { token?: string; access_token?: string };
  const token = json.token || json.access_token;
  if (!token) throw new Error('registry token exchange returned no token');
  return token;
}

function parseNextLink(link: string | null, registry: string): string | null {
  if (!link) return null;
  const match = link.match(/<([^>]+)>\s*;\s*rel="next"/i);
  if (!match) return null;
  const raw = match[1];
  // The Bearer token is sent to this URL: never follow it off the registry's origin.
  // Both sides go through URL so an explicit default port (`:443`) still matches.
  if (/^https?:\/\//i.test(raw)) {
    try {
      if (new URL(raw).origin === new URL(`https://${registry}`).origin) return raw;
    } catch {
      // fall through: an unparsable link counts as foreign
    }
    // Host only: the link's path and query can carry tokens.
    console.warn(`[registry] Ignoring Link: next that points away from ${registry}`);
    return null;
  }
  return `https://${registry}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

/**
 * List all tags for `image` against its registry. `auth` undefined uses the
 * registry's credentials from `~/.docker/config.json`, if any; `null` lists
 * anonymously. See listRepositoryTags.
 */
export async function listImageTags(image: string, auth?: RegistryAuth | null): Promise<string[]> {
  const { registry, repo } = parseImageRef(image);
  return listRepositoryTags(registry, repo, auth === undefined ? readRegistryAuth(registry) : auth);
}

/**
 * List all tags of `repo` on `registry` (a host with optional port), following
 * `Link: next` pagination on the same origin. `auth` goes only to the token
 * endpoint; `null` lists anonymously. Each request times out after
 * REGISTRY_REQUEST_TIMEOUT_MS, and a listing that has not ended after
 * MAX_TAG_PAGES pages, or links back to a page it already read, fails.
 * Credentials are never included in thrown error messages.
 */
export async function listRepositoryTags(registry: string, repo: string, auth: RegistryAuth | null): Promise<string[]> {
  const bearer = await exchangeToken(registry, repo, auth);

  const tags: string[] = [];
  const read = new Set<string>();
  let url: string | null = `https://${registry}/v2/${repo}/tags/list?n=100`;
  while (url) {
    if (read.has(url) || read.size >= MAX_TAG_PAGES) {
      throw new Error(`registry tag list did not end after ${read.size} pages`);
    }
    read.add(url);
    const res: Response = await fetchNoRedirect(url, {
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new RegistryHttpError(`registry tag list failed (HTTP ${res.status})`, res.status);
    const json = (await res.json()) as { tags?: string[] | null };
    if (Array.isArray(json.tags)) tags.push(...json.tags);
    url = parseNextLink(res.headers.get('link'), registry);
  }
  return tags;
}

/**
 * Sort tags for display: `latest` and `main` first, then semver-looking tags
 * descending (newest first), then everything else alphabetically. Stable and
 * tolerant of non-semver inputs.
 */
export function sortTagsForDisplay(tags: string[]): string[] {
  const priority = ['latest', 'main'];
  const priorityIndex = (t: string) => {
    const i = priority.indexOf(t);
    return i < 0 ? priority.length : i;
  };
  const semverParts = (t: string): number[] | null => {
    const m = t.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[.-]([\w.]+))?$/);
    if (!m) return null;
    return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
  };
  return [...tags].sort((a, b) => {
    const pa = priorityIndex(a);
    const pb = priorityIndex(b);
    if (pa !== pb) return pa - pb;
    const sa = semverParts(a);
    const sb = semverParts(b);
    if (sa && sb) {
      for (let i = 0; i < 3; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
      return a.localeCompare(b);
    }
    if (sa) return -1;
    if (sb) return 1;
    return a.localeCompare(b);
  });
}
