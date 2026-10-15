import { execFile } from 'child_process';
import { HttpError } from './httpErrors';

// What the docker CLI and compose need to find the daemon, registry login state
// and their own settings. Nothing else: Overwatch's process env holds operator
// secrets (JWT_SECRET, DB root password, GHCR/R2 tokens), and compose resolves
// `${VAR}` in a tenant's compose file against the env it runs with.
const DOCKER_ENV_KEYS = [
  'PATH', 'HOME', 'LANG', 'LC_ALL',
] as const;

// Explicit allowlist, not a DOCKER_* prefix: DOCKER_PASSWORD, DOCKER_AUTH_CONFIG
// and similar registry credentials may sit in the process env and are not needed
// by the CLI/compose calls Overwatch makes (login state comes from DOCKER_CONFIG).
const DOCKER_CLI_KEYS = new Set([
  'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
  'DOCKER_API_VERSION', 'DOCKER_BUILDKIT', 'DOCKER_DEFAULT_PLATFORM',
  // Not credentials; dropping them would silently turn signature verification off.
  'DOCKER_CONTENT_TRUST', 'DOCKER_CONTENT_TRUST_SERVER',
]);

// Compose tuning only. Selection variables (COMPOSE_PROJECT_NAME, COMPOSE_FILE,
// COMPOSE_PROFILES, COMPOSE_ENV_FILES, COMPOSE_PATH_SEPARATOR,
// COMPOSE_REMOVE_ORPHANS, COMPOSE_IGNORE_ORPHANS) stay out: they would beat the
// per-tenant `.env` values, and with `down`/--remove-orphans could hit other tenants.
const COMPOSE_TUNING_KEYS = new Set([
  'COMPOSE_HTTP_TIMEOUT', 'COMPOSE_COMPATIBILITY', 'COMPOSE_PARALLEL_LIMIT',
  'COMPOSE_ANSI', 'COMPOSE_STATUS_STDOUT', 'COMPOSE_MENU',
]);

/** Allowlisted environment for docker / docker compose child processes. */
export function getDockerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of DOCKER_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (DOCKER_CLI_KEYS.has(key) || COMPOSE_TUNING_KEYS.has(key)) env[key] = value;
  }
  return env;
}

export interface RunDockerOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed (`login --password-stdin`). */
  input?: string;
}

export type DockerErrorKind = 'timeout' | 'cli_missing' | 'daemon_unreachable' | 'unknown_container' | 'permission' | 'unknown';

// The message keeps the CLI's stderr for server-side logs; clients only get the
// fixed per-kind text, since stderr can carry paths and daemon details.
const DOCKER_CLIENT_MESSAGE: Record<DockerErrorKind, string> = {
  timeout: 'Docker command timed out',
  cli_missing: 'Docker CLI is not available',
  daemon_unreachable: 'Cannot connect to the Docker daemon',
  unknown_container: 'Docker container not found',
  permission: 'Docker permission denied',
  unknown: 'Docker command failed',
};

export class DockerCommandError extends HttpError {
  kind: DockerErrorKind;
  stderr: string;
  stdout: string;
  exitCode: number | null;
  command: string;
  args: string[];

  constructor(msg: string, kind: DockerErrorKind, details: {
    stderr: string;
    stdout: string;
    exitCode: number | null;
    command: string;
    args: string[];
  }) {
    super(kind === 'daemon_unreachable' || kind === 'timeout' ? 503 : 502, msg, { expose: true, clientMessage: DOCKER_CLIENT_MESSAGE[kind] });
    this.name = 'DockerCommandError';
    this.kind = kind;
    this.stderr = details.stderr;
    this.stdout = details.stdout;
    this.exitCode = details.exitCode;
    this.command = details.command;
    this.args = details.args;
  }
}

/** Exported for direct unit testing — avoids spawning `docker` on CI runners that lack it. */
export function classifyError(stderr: string, code: number | null, signal: NodeJS.Signals | null): DockerErrorKind {
  if (signal === 'SIGTERM' || signal === 'SIGKILL') return 'timeout';
  const s = stderr.toLowerCase();
  if (s.includes('cannot connect to the docker daemon') || s.includes('is the docker daemon running')) {
    return 'daemon_unreachable';
  }
  if (s.includes('no such container') || s.includes('is not running')) {
    return 'unknown_container';
  }
  if (s.includes('permission denied') || code === 126) {
    return 'permission';
  }
  if (code === 127 || s.includes('not found')) {
    return 'cli_missing';
  }
  return 'unknown';
}

/**
 * Run a docker CLI command with a timeout and structured error classification.
 * Prefer this over direct execFile for any docker/docker-compose shell-out so
 * timeouts are consistent and errors carry a kind you can switch on.
 */
export async function runDocker(
  command: 'docker',
  args: string[],
  opts: RunDockerOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: opts.cwd, env: opts.env ?? getDockerEnv(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const anyErr = err as NodeJS.ErrnoException & { code?: number | string; signal?: NodeJS.Signals };
        const exitCode = typeof anyErr.code === 'number' ? anyErr.code : null;
        const signal = (anyErr.signal as NodeJS.Signals) ?? null;
        const kind = classifyError(String(stderr), exitCode, signal);
        const msg = kind === 'timeout'
          ? `docker ${args[0]}… timed out after ${timeoutMs}ms`
          : `docker ${args.join(' ')} failed (${kind}${exitCode !== null ? `, exit ${exitCode}` : ''}): ${String(stderr).trim() || err.message}`;
        reject(new DockerCommandError(msg, kind, {
          stderr: String(stderr),
          stdout: String(stdout),
          exitCode,
          command,
          args,
        }));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    // Ensure child is killed on external signals — node's timeout does this, but
    // be explicit so callers who set shorter timeouts still get cleanup.
    child.on('error', () => {});
    if (opts.input !== undefined && child.stdin) {
      // The CLI may exit before reading stdin; its exit status reports the failure.
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input);
    }
  });
}
