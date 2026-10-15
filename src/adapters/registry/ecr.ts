import { execFile } from 'child_process';
import { RegistryAdapter, RegistryAdapterConfig } from './types';
import { dockerLogin, REGISTRY_LOGIN_TIMEOUT_MS, RegistryLoginUnavailableError } from './login';

// The AWS CLI needs its own settings and credentials (AWS_*), a home for
// ~/.aws and the proxy settings. Nothing else: Overwatch's env holds operator
// secrets (JWT_SECRET, DB root password, R2 keys).
const AWS_CLI_ENV_KEYS = new Set([
  'PATH', 'HOME', 'LANG', 'LC_ALL',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
]);

/** Allowlisted environment for AWS CLI child processes. */
export function getAwsCliEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (AWS_CLI_ENV_KEYS.has(key) || key.startsWith('AWS_')) env[key] = value;
  }
  env.AWS_PAGER = '';
  return env;
}

function lastLine(text: string): string {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

/**
 * Run the AWS CLI without blocking the event loop. Errors are worded like the
 * other adapters' so the tags route can classify them.
 */
function runAws(args: string[], repository: string): Promise<string> {
  const operation = `aws ${args.slice(0, 2).join(' ')}`;
  return new Promise((resolve, reject) => {
    execFile('aws', args, { env: getAwsCliEnv(), timeout: REGISTRY_LOGIN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        resolve(String(stdout));
        return;
      }
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null };
      const text = String(stderr ?? '');
      if (e.code === 'ENOENT') {
        reject(new RegistryLoginUnavailableError('the AWS CLI (aws) is not installed in the Overwatch container'));
      } else if (e.killed || e.signal === 'SIGTERM' || e.signal === 'SIGKILL') {
        reject(new Error(`${operation} timed out after ${REGISTRY_LOGIN_TIMEOUT_MS}ms`));
      } else if (/unable to locate credentials/i.test(text)) {
        reject(new RegistryLoginUnavailableError('AWS credentials not configured for the AWS CLI'));
      } else if (/RepositoryNotFoundException/.test(text)) {
        reject(new Error(`ECR repository '${repository}' not found (${lastLine(text)})`));
      } else if (/AccessDenied|UnrecognizedClient|ExpiredToken|InvalidSignature|InvalidClientTokenId|not authorized/i.test(text)) {
        reject(new Error(`AWS ECR denied access (${lastLine(text)})`));
      } else {
        reject(new Error(`${operation} failed: ${lastLine(text) || e.message}`));
      }
    });
  });
}

/**
 * AWS Elastic Container Registry adapter
 */
export class ECRAdapter implements RegistryAdapter {
  private config: RegistryAdapterConfig;

  constructor(config: RegistryAdapterConfig) {
    this.config = config;
  }

  // The AWS CLI finds its own credentials (env, profile, instance role).
  hasCredentials(): boolean {
    return true;
  }

  async login(): Promise<void> {
    const region = this.config.awsRegion || 'us-east-1';

    try {
      console.log(`Authenticating with AWS ECR in ${region}...`);

      const password = (await runAws(['ecr', 'get-login-password', `--region=${region}`], this.config.repository)).trim();
      await dockerLogin(this.config.url, 'AWS', password);

      console.log(`Successfully logged in to ${this.config.url}`);
    } catch (error) {
      console.error('Failed to login to ECR:', error);
      throw error;
    }
  }

  async getImageTags(): Promise<string[]> {
    const region = this.config.awsRegion || 'us-east-1';

    const result = await runAws(
      ['ecr', 'describe-images', `--repository-name=${this.config.repository}`, `--region=${region}`, '--query=imageDetails[*].imageTags', '--output=json'],
      this.config.repository,
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      throw new Error('aws ecr describe-images returned output that is not JSON');
    }
    const tags = (Array.isArray(parsed) ? parsed : [])
      .flat()
      .filter((t: unknown): t is string => typeof t === 'string');

    const pattern = this.config.tagPattern || /^v/;
    return tags
      .filter(name => pattern.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  }

  getImageRef(service: string, tag: string): string {
    return `${this.config.url}/${this.config.repository}/${service}:${tag}`;
  }

  getType(): string {
    return 'ecr';
  }
}
