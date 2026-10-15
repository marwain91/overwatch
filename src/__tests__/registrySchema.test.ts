import { describe, it, expect } from 'vitest';
import { AppRegistryAuthSchema, AppRegistrySchema, registryFieldErrors } from '../models/app';

describe('AppRegistryAuthSchema — supported types', () => {
  it('accepts type=token with token_env', () => {
    const result = AppRegistryAuthSchema.safeParse({
      type: 'token',
      token_env: 'GHCR_TOKEN',
    });
    expect(result.success).toBe(true);
  });

  it('accepts type=basic with username_env + token_env', () => {
    const result = AppRegistryAuthSchema.safeParse({
      type: 'basic',
      username_env: 'REG_USERNAME',
      token_env: 'REG_PASSWORD',
    });
    expect(result.success).toBe(true);
  });

  it('accepts type=aws_iam with aws_region_env', () => {
    const result = AppRegistryAuthSchema.safeParse({
      type: 'aws_iam',
      aws_region_env: 'AWS_REGION',
    });
    expect(result.success).toBe(true);
  });

  it('rejects the removed github_app type (v1.6.7+)', () => {
    const result = AppRegistryAuthSchema.safeParse({
      type: 'github_app',
      app_id_env: 'X',
      installation_id_env: 'Y',
      private_key_env: 'Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('AppRegistrySchema — gitlab type', () => {
  const validAuth = { type: 'token' as const, token_env: 'GITLAB_TOKEN' };

  it('accepts type=gitlab without api_url (SaaS)', () => {
    const result = AppRegistrySchema.safeParse({
      type: 'gitlab',
      url: 'registry.gitlab.com',
      repository: 'mygroup/myproject',
      auth: validAuth,
    });
    expect(result.success).toBe(true);
  });

  it('accepts type=gitlab with api_url (self-hosted)', () => {
    const result = AppRegistrySchema.safeParse({
      type: 'gitlab',
      url: 'registry.acme.com:5050',
      api_url: 'https://gitlab.acme.com',
      repository: 'group/sub/project',
      auth: validAuth,
    });
    expect(result.success).toBe(true);
  });

  it('round-trips api_url through the schema', () => {
    const result = AppRegistrySchema.parse({
      type: 'gitlab',
      url: 'registry.gitlab.com',
      api_url: 'https://gitlab.example.com',
      repository: 'g/p',
      auth: validAuth,
    });
    expect(result.api_url).toBe('https://gitlab.example.com');
  });

  it('still accepts the legacy ghcr shape without api_url', () => {
    const result = AppRegistrySchema.safeParse({
      type: 'ghcr',
      url: 'ghcr.io',
      repository: 'org/repo',
      auth: validAuth,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.api_url).toBeUndefined();
    }
  });
});

// url, repository and api_url reach `docker login/pull/create` as arguments and
// image references, and the registry APIs as URL parts. The schema only trims
// them; registryFieldErrors holds the formats, checked on write and before use.
describe('registryFieldErrors — field formats', () => {
  const auth = { type: 'token' as const, token_env: 'GHCR_TOKEN' };
  const registry = (over: Record<string, unknown>) => ({ type: 'ghcr', url: 'ghcr.io', repository: 'org/repo', auth, ...over });
  const ok = (over: Record<string, unknown>) => {
    const parsed = AppRegistrySchema.safeParse(registry(over));
    return parsed.success && registryFieldErrors(parsed.data).length === 0;
  };

  it.each([
    'ghcr.io', 'registry.gitlab.com', 'registry.acme.com:5050', 'docker.io', 'index.docker.io', 'quay.io',
    '123456789012.dkr.ecr.us-east-1.amazonaws.com', 'europe-west1-docker.pkg.dev', 'myacr.azurecr.io',
    'localhost:5000', '10.0.0.5:5000', '[::1]:5000', '[2001:db8::1]', 'registry.acme.com/team',
    'harbor.acme.com:8443/library/sub', 'my_registry.local', 'Registry.Acme.com',
  ])('accepts url %s', (url) => {
    expect(ok({ url })).toBe(true);
  });

  it.each([
    '-H', '--config=/tmp/x', '-', '', ' ', ' -H', 'ghcr .io', 'ghcr.io\nx', 'ghcr\t.io',
    'https://ghcr.io', 'ghcr.io/', 'user@ghcr.io', 'ghcr.io/../x', 'ghcr.io/.x', 'ghcr.io?x', 'ghcr.io#x',
    'ghcr.io:port', 'ghcr.io/-x', 'ghcr.io//x', 'ghcr.io\\x', 'ghcr.io;x', 'ghcr.io\0',
  ])('rejects url %j', (url) => {
    expect(ok({ url })).toBe(false);
  });

  it.each([
    'org/repo', 'group/sub/project', 'marwain91/acme', 'my_org/my.repo-name', 'a/b', 'library', 'team/app_2',
    'org/repo--x', 'org/repo__x', 'team/app',
    // Never pullable, but images built before the move to lowercase embed it in
    // /overwatch/app.json, whose registry block the global one replaces anyway.
    'TheOpenApps/gadgets',
  ])('accepts repository %s', (repository) => {
    expect(ok({ repository })).toBe(true);
  });

  it.each([
    '-x', '--help', 'org/-repo', 'org repo', 'org\trepo', 'org//repo', '/org/repo', 'org/repo/',
    '../etc', 'org/../repo', 'org/.hidden', '', 'org/repo:tag', 'org/repo@sha256:abc', 'org\nrepo', 'org/repo?x',
  ])('rejects repository %j', (repository) => {
    expect(ok({ repository })).toBe(false);
  });

  it.each([
    'https://gitlab.acme.com', 'https://gitlab.acme.com/', 'https://gitlab.acme.com:8443', 'http://gitlab.lan',
    'https://acme.com/gitlab', 'https://[2001:db8::1]:8443',
    // validateRegistryUrl documents bare hosts; such a value never listed tags but must keep loading.
    'gitlab.acme.com',
  ])('accepts api_url %s', (api_url) => {
    expect(ok({ type: 'gitlab', url: 'registry.acme.com:5050', api_url })).toBe(true);
  });

  it.each([
    '-x', '--config', '', 'ftp://gitlab.acme.com', 'file:///etc/passwd', 'https://user:pw@gitlab.acme.com',
    'https://gitlab .acme.com', 'https://gitlab.acme.com/?x=1',
    'https://gitlab.acme.com/#x', 'https://gitlab.acme.com/\nx',
  ])('rejects api_url %j', (api_url) => {
    expect(ok({ type: 'gitlab', url: 'registry.acme.com:5050', api_url })).toBe(false);
  });

  it('trims surrounding whitespace instead of failing a stored definition over it', () => {
    // A pasted trailing space reached docker as part of the image reference, and
    // the URL parser dropped it from api_url, which therefore worked.
    const result = AppRegistrySchema.parse(registry({
      type: 'gitlab', url: ' registry.acme.com:5050\n', repository: 'group/app ', api_url: 'https://gitlab.acme.com ',
    }));
    expect(result.url).toBe('registry.acme.com:5050');
    expect(result.repository).toBe('group/app');
    expect(result.api_url).toBe('https://gitlab.acme.com');
  });

  it('names the field and the expected shape in the error', () => {
    const errors = registryFieldErrors({ url: '--config=/tmp/x', repository: 'org/repo' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^registry\.url: .*ghcr\.io/);
  });

  it('checks only the requested fields', () => {
    const bad = { url: '-H', repository: '-x', api_url: '-y' };
    expect(registryFieldErrors(bad, ['url', 'repository'])).toHaveLength(2);
    expect(registryFieldErrors(bad, ['api_url'])).toEqual([expect.stringMatching(/^registry\.api_url: /)]);
  });

  it('lets the schema load stored values written before the formats existed', () => {
    const legacy = registry({ type: 'gitlab', url: '-H', repository: 'org repo', api_url: 'https://user:pw@gitlab.acme.com' });
    const result = AppRegistrySchema.safeParse(legacy);
    expect(result.success).toBe(true);
    if (result.success) expect(registryFieldErrors(result.data)).toHaveLength(3);
  });
});
