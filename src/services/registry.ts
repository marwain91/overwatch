import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ImageRef {
  registry: string;
  repo: string;
}

interface RegistryAuth {
  user: string;
  token: string;
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
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`registry token exchange failed (HTTP ${res.status})`);
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
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${registry}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

/**
 * List all tags for `image` against its registry. Handles anonymous and
 * PAT-authenticated flows (`~/.docker/config.json`) and follows `Link: next`
 * pagination. Credentials are never included in thrown error messages.
 */
export async function listImageTags(image: string): Promise<string[]> {
  const { registry, repo } = parseImageRef(image);
  const auth = readRegistryAuth(registry);
  const bearer = await exchangeToken(registry, repo, auth);

  const tags: string[] = [];
  let url: string | null = `https://${registry}/v2/${repo}/tags/list?n=100`;
  while (url) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`registry tag list failed (HTTP ${res.status})`);
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
