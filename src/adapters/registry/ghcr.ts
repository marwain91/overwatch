import { RegistryAdapter, RegistryAdapterConfig } from './types';
import { dockerLogin } from './login';
import { validateRegistryUrl } from './urlValidation';
import { isRegistryImageName } from '../../models/app';
import { ValidationError } from '../../utils/httpErrors';
import { RegistryAuth, RegistryHttpError, listRepositoryTags, sortTagsForDisplay } from '../../services/registry';

/**
 * GitHub Container Registry adapter.
 *
 * Pulls and tag listing both need only `read:packages`. Tags come from the
 * registry itself (`/v2/<image>/tags/list`), not from the source repository,
 * so the token needs no access to code. A tag is listed only when every
 * service image of the app has it.
 *
 * Auth: a classic PAT is the bearer for docker login and tag listing. GHCR
 * accepts neither fine-grained PATs nor GitHub App installation tokens for
 * private packages (App auth was removed in v1.6.7, see models/app.ts).
 * Without a token, tags of public packages are listed anonymously.
 */
export class GHCRAdapter implements RegistryAdapter {
  private config: RegistryAdapterConfig;

  constructor(config: RegistryAdapterConfig) {
    this.config = config;
  }

  hasCredentials(): boolean {
    return !!this.config.token;
  }

  async login(): Promise<void> {
    const token = this.config.token;

    if (!token) {
      console.log('GHCR auth not configured, skipping registry login');
      return;
    }

    try {
      console.log('Authenticating with GitHub Container Registry...');
      const username = this.config.username || 'x-access-token';

      await dockerLogin(this.config.url, username, token);

      console.log(`Successfully logged in to ${this.config.url}`);
    } catch (error) {
      console.error('Failed to login to GHCR:', error);
      throw error;
    }
  }

  async getImageTags(images: string[]): Promise<string[]> {
    const names = [...new Set(images)];
    if (names.length === 0) {
      throw new Error('No service images to list GHCR tags for');
    }
    // Image names go into the token scope and the tags/list path, so they get
    // the same check as `repository` before any request is made.
    const invalid = names.filter((name) => !isRegistryImageName(name));
    if (invalid.length > 0) {
      throw new ValidationError(
        `Refusing to list tags: service image ${invalid.map((n) => JSON.stringify(n)).join(', ')} is not a registry path ` +
        '(letters, digits, ".", "_" and "-", separated by "/")',
      );
    }
    // The host is passed on as is, never re-derived from an image reference.
    const [host, ...urlPath] = this.config.url.split('/');
    // ghcr.io itself is trusted; only validate an operator-supplied host.
    if (host.toLowerCase() !== 'ghcr.io') {
      await validateRegistryUrl(this.config.url);
    }

    const auth = this.config.token
      ? { user: this.config.username || 'x-access-token', token: this.config.token }
      : null;
    const perImage = await Promise.all(
      names.map((name) => this.listTags(host, [...urlPath, this.config.repository, name].join('/'), auth)),
    );
    const [first, ...rest] = perImage.map((tags) => new Set(tags));
    const pattern = this.config.tagPattern;
    const common = [...first].filter((tag) => rest.every((tags) => tags.has(tag)) && (!pattern || pattern.test(tag)));
    return sortTagsForDisplay(common);
  }

  private async listTags(host: string, repo: string, auth: RegistryAuth | null): Promise<string[]> {
    const image = `${host}/${repo}`;
    try {
      return await listRepositoryTags(host, repo, auth);
    } catch (error) {
      if (error instanceof RegistryHttpError && (error.status === 401 || error.status === 403)) {
        throw new Error(
          auth
            ? `GHCR denied access to ${image} (HTTP ${error.status}). GHCR_TOKEN (or the configured token_env) ` +
              `needs the 'read:packages' scope and read access to the package.`
            : `GHCR denied access to ${image} (HTTP ${error.status}) without a token. No registry token is configured: ` +
              `set the app's token_env (e.g. GHCR_TOKEN) to a classic PAT with 'read:packages'. ` +
              'Only public packages can be listed without one.',
        );
      }
      if (error instanceof RegistryHttpError && error.status === 404) {
        throw new Error(`GHCR package ${image} not found (HTTP 404), or not accessible to the configured credentials.`);
      }
      throw error;
    }
  }

  getImageRef(service: string, tag: string): string {
    return `${this.config.url}/${this.config.repository}/${service}:${tag}`;
  }

  getType(): string {
    return 'ghcr';
  }
}
