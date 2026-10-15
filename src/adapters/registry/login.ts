import { DockerCommandError, runDocker } from '../../utils/runDocker';

/** Bound on one `docker login`, and on each AWS CLI call ECR makes. */
export const REGISTRY_LOGIN_TIMEOUT_MS = 60_000;

/**
 * The login could not run, or its result could not be stored: no AWS CLI or no
 * AWS credentials for ECR, or a read-only docker config (the host's
 * `/root/.docker` mounted `:ro` when Overwatch runs as root). Pulls then use
 * whatever docker credentials already exist, as they did before.
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
