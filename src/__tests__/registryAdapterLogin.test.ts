import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Adapters log in through runDocker (curated env, timeout); ECR's AWS CLI runs
// through an async execFile. Neither may block the event loop.
const runDockerMock = vi.fn();
vi.mock('../utils/runDocker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/runDocker')>();
  return { ...actual, runDocker: (...a: unknown[]) => runDockerMock(...a) };
});
const execFileMock = vi.fn();
vi.mock('child_process', () => ({ execFile: (...a: unknown[]) => execFileMock(...a) }));

import { GHCRAdapter } from '../adapters/registry/ghcr';
import { GitLabAdapter } from '../adapters/registry/gitlab';
import { DockerHubAdapter } from '../adapters/registry/dockerhub';
import { CustomRegistryAdapter } from '../adapters/registry/custom';
import { ECRAdapter } from '../adapters/registry/ecr';
import { RegistryLoginUnavailableError } from '../adapters/registry/login';
import { DockerCommandError } from '../utils/runDocker';

const SAVED_ENV = { ...process.env };

function awsReplies(handler: (args: string[]) => { stdout?: string; stderr?: string; error?: any }) {
  execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (e: any, so: string, se: string) => void) => {
    const r = handler(args);
    cb(r.error ?? null, r.stdout ?? '', r.stderr ?? '');
    return { on() {} };
  });
}

function awsFailure(stderr: string) {
  return { error: Object.assign(new Error('Command failed'), { code: 255 }), stderr };
}

beforeEach(() => {
  runDockerMock.mockReset();
  execFileMock.mockReset();
  runDockerMock.mockResolvedValue({ stdout: 'Login Succeeded', stderr: '' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
  Object.assign(process.env, SAVED_ENV);
});

describe('docker login goes through runDocker with a timeout and the secret on stdin', () => {
  const cases = [
    {
      name: 'ghcr',
      adapter: () => new GHCRAdapter({ type: 'ghcr', url: 'ghcr.io', repository: 'org/repo', token: 'pat_abc' }),
      args: ['login', '--username=x-access-token', '--password-stdin', '--', 'ghcr.io'],
      secret: 'pat_abc',
    },
    {
      name: 'gitlab',
      adapter: () => new GitLabAdapter({ type: 'gitlab', url: 'registry.acme.com:5050', repository: 'g/p', token: 'glpat' }),
      args: ['login', '--username=oauth2', '--password-stdin', '--', 'registry.acme.com:5050'],
      secret: 'glpat',
    },
    {
      name: 'dockerhub',
      adapter: () => new DockerHubAdapter({ type: 'dockerhub', url: 'docker.io', repository: 'org/repo', username: 'bob', token: 'hub' }),
      args: ['login', '--username=bob', '--password-stdin'],
      secret: 'hub',
    },
    {
      name: 'custom',
      adapter: () => new CustomRegistryAdapter({ type: 'custom', url: 'reg.example.com:5000', repository: 'org/repo', username: 'bob', token: 'pw' }),
      args: ['login', '--username=bob', '--password-stdin', '--', 'reg.example.com:5000'],
      secret: 'pw',
    },
  ];

  for (const c of cases) {
    it(`${c.name}: options end before the server address`, async () => {
      await c.adapter().login();
      expect(runDockerMock).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = runDockerMock.mock.calls[0];
      expect(cmd).toBe('docker');
      expect(args).toEqual(c.args);
      expect(opts.input).toBe(c.secret);
      expect(opts.timeoutMs).toBeGreaterThan(0);
      expect(JSON.stringify(args)).not.toContain(c.secret);
    });
  }

  it('reports a docker config that cannot store the login as unavailable, not as a rejected login', async () => {
    runDockerMock.mockRejectedValue(new DockerCommandError('docker login failed', 'unknown', {
      stderr: 'error saving credentials: open /root/.docker/config.json1234: read-only file system\n',
      stdout: '', exitCode: 1, command: 'docker', args: ['login'],
    }));
    const adapter = new GHCRAdapter({ type: 'ghcr', url: 'ghcr.io', repository: 'org/repo', token: 'pat_abc' });
    await expect(adapter.login()).rejects.toBeInstanceOf(RegistryLoginUnavailableError);
  });

  it('refuses to pass a malformed server address to docker login', async () => {
    const adapter = new CustomRegistryAdapter({ type: 'custom', url: '--config=/tmp/x', repository: 'org/repo', username: 'bob', token: 'pw' });
    await expect(adapter.login()).rejects.toThrow(/Refusing docker login: registry\.url/);
    expect(runDockerMock).not.toHaveBeenCalled();
  });

  it('propagates a rejected login', async () => {
    runDockerMock.mockRejectedValue(new DockerCommandError('docker login failed', 'unknown', {
      stderr: 'Error response from daemon: Get "https://ghcr.io/v2/": denied: denied\n',
      stdout: '', exitCode: 1, command: 'docker', args: ['login'],
    }));
    const adapter = new GHCRAdapter({ type: 'ghcr', url: 'ghcr.io', repository: 'org/repo', token: 'pat_abc' });
    const err = await adapter.login().catch(e => e);
    expect(err).toBeInstanceOf(DockerCommandError);
    expect(err).not.toBeInstanceOf(RegistryLoginUnavailableError);
  });
});

describe('hasCredentials', () => {
  it('mirrors what each adapter needs to log in', () => {
    expect(new GHCRAdapter({ type: 'ghcr', url: 'ghcr.io', repository: 'o/r', token: 't' }).hasCredentials()).toBe(true);
    expect(new GHCRAdapter({ type: 'ghcr', url: 'ghcr.io', repository: 'o/r' }).hasCredentials()).toBe(false);
    expect(new GitLabAdapter({ type: 'gitlab', url: 'registry.gitlab.com', repository: 'o/r', token: 't' }).hasCredentials()).toBe(true);
    expect(new GitLabAdapter({ type: 'gitlab', url: 'registry.gitlab.com', repository: 'o/r' }).hasCredentials()).toBe(false);
    expect(new DockerHubAdapter({ type: 'dockerhub', url: 'docker.io', repository: 'o/r', token: 't' }).hasCredentials()).toBe(false);
    expect(new DockerHubAdapter({ type: 'dockerhub', url: 'docker.io', repository: 'o/r', username: 'u', token: 't' }).hasCredentials()).toBe(true);
    expect(new CustomRegistryAdapter({ type: 'custom', url: 'r.io', repository: 'o/r', username: 'u' }).hasCredentials()).toBe(false);
    expect(new CustomRegistryAdapter({ type: 'custom', url: 'r.io', repository: 'o/r', username: 'u', token: 't' }).hasCredentials()).toBe(true);
    // The AWS CLI finds its own credentials (env, profile, instance role).
    expect(new ECRAdapter({ type: 'ecr', url: '1.dkr.ecr.eu-west-1.amazonaws.com', repository: 'o/r' }).hasCredentials()).toBe(true);
  });

  it('skips docker login without credentials', async () => {
    await new GHCRAdapter({ type: 'ghcr', url: 'ghcr.io', repository: 'o/r' }).login();
    await new DockerHubAdapter({ type: 'dockerhub', url: 'docker.io', repository: 'o/r' }).login();
    expect(runDockerMock).not.toHaveBeenCalled();
  });
});

describe('ECR adapter', () => {
  const ecrUrl = '123456789012.dkr.ecr.eu-west-1.amazonaws.com';
  const ecr = (extra: Record<string, unknown> = {}) =>
    new ECRAdapter({ type: 'ecr', url: ecrUrl, repository: 'team/app', awsRegion: 'eu-west-1', ...extra });

  it('login runs the AWS CLI asynchronously with a timeout and an allowlisted env, then pipes the password to docker login', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    process.env.JWT_SECRET = 'jwt-secret';
    process.env.MYSQL_ROOT_PASSWORD = 'root-pw';
    process.env.R2_SECRET_ACCESS_KEY = 'r2';
    awsReplies(() => ({ stdout: 'ecr-password\n' }));

    await ecr().login();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts, cb] = execFileMock.mock.calls[0];
    expect(cmd).toBe('aws');
    expect(args).toEqual(['ecr', 'get-login-password', '--region=eu-west-1']);
    expect(typeof cb).toBe('function');
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.env.AWS_ACCESS_KEY_ID).toBe('AKIA');
    expect(opts.env.AWS_SECRET_ACCESS_KEY).toBe('aws-secret');
    expect(opts.env).not.toHaveProperty('JWT_SECRET');
    expect(opts.env).not.toHaveProperty('MYSQL_ROOT_PASSWORD');
    expect(opts.env).not.toHaveProperty('R2_SECRET_ACCESS_KEY');

    const [, dockerArgs, dockerOpts] = runDockerMock.mock.calls[0];
    expect(dockerArgs).toEqual(['login', '--username=AWS', '--password-stdin', '--', ecrUrl]);
    expect(dockerOpts.input).toBe('ecr-password');
    expect(dockerOpts.timeoutMs).toBeGreaterThan(0);
  });

  it('login without the AWS CLI is unavailable, not a rejected login', async () => {
    awsReplies(() => ({ error: Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' }) }));
    await expect(ecr().login()).rejects.toBeInstanceOf(RegistryLoginUnavailableError);
    expect(runDockerMock).not.toHaveBeenCalled();
  });

  it('login without AWS credentials is unavailable, not a rejected login', async () => {
    awsReplies(() => awsFailure('\nUnable to locate credentials. You can configure credentials by running "aws configure".\n'));
    await expect(ecr().login()).rejects.toBeInstanceOf(RegistryLoginUnavailableError);
  });

  it('login rejected by AWS fails', async () => {
    awsReplies(() => awsFailure('An error occurred (AccessDeniedException) when calling the GetAuthorizationToken operation: denied'));
    const err = await ecr().login().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RegistryLoginUnavailableError);
    expect(err.message).toMatch(/denied access/);
  });

  it('getImageTags runs describe-images asynchronously with a timeout and filters/sorts the tags', async () => {
    awsReplies(() => ({ stdout: JSON.stringify([['v1.2.0', 'latest'], ['v1.10.0'], null]) }));
    const tags = await ecr().getImageTags();
    expect(tags).toEqual(['v1.10.0', 'v1.2.0']);
    const [cmd, args, opts, cb] = execFileMock.mock.calls[0];
    expect(cmd).toBe('aws');
    expect(args).toEqual(expect.arrayContaining(['ecr', 'describe-images', '--repository-name=team/app', '--region=eu-west-1']));
    expect(opts.timeout).toBeGreaterThan(0);
    expect(typeof cb).toBe('function');
  });

  it('getImageTags reports errors like the other adapters instead of returning no tags', async () => {
    awsReplies(() => awsFailure('An error occurred (AccessDeniedException) when calling the DescribeImages operation: User is not authorized'));
    await expect(ecr().getImageTags()).rejects.toThrow(/denied access/);

    awsReplies(() => awsFailure("An error occurred (RepositoryNotFoundException) when calling the DescribeImages operation: The repository with name 'team/app' does not exist"));
    await expect(ecr().getImageTags()).rejects.toThrow(/not found/);

    awsReplies(() => ({ error: Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' }) }));
    await expect(ecr().getImageTags()).rejects.toThrow(/AWS CLI/);

    awsReplies(() => ({ error: Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }) }));
    await expect(ecr().getImageTags()).rejects.toThrow(/timed out/);
  });
});
