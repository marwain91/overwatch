import { execFile } from 'child_process';

export interface RunDockerOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type DockerErrorKind = 'timeout' | 'cli_missing' | 'daemon_unreachable' | 'unknown_container' | 'permission' | 'unknown';

export class DockerCommandError extends Error {
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
    super(msg);
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
    const child = execFile(command, args, { cwd: opts.cwd, env: opts.env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
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
  });
}
