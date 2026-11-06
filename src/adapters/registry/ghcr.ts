import { RegistryAdapter, RegistryAdapterConfig } from './types';
import { dockerLogin } from './login';
import { validateRegistryUrl } from './urlValidation';
import { RegistryAuth, RegistryHttpError, listImageTags, sortTagsForDisplay } from '../../services/registry';

/**
 * GitHub Container Registry adapter.
 *
 * Pulls and tag listing both need only `read:packages`. Tags come from the
 * registry itself (`/v2/<image>/tags/list`), not from the source repository,
 * so the token needs no access to code. A tag is listed only when every
 * service image of the app has it, so a listed tag can always be pulled.
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

  async getImageTags(images: string[] = []): Promise<string[]> {
    const names = [...new Set(images)];
    if (names.length === 0) {
      throw new Error('No service images to list GHCR tags for');
    }
    // ghcr.io itself is trusted; only validate an operator-supplied host.
    if (this.config.url.split('/')[0].toLowerCase() !== 'ghcr.io') {
      await validateRegistryUrl(this.config.url);
    }

    const auth = this.config.token
      ? { user: this.config.username || 'x-access-token', token: this.config.token }
      : null;
    // GHCR package names are lowercase; docker refuses uppercase references too.
    const perImage = await Promise.all(
      names.map((name) => this.listTags(`${this.config.url}/${this.config.repository}/${name}`.toLowerCase(), auth)),
    );
    const [first, ...rest] = perImage.map((tags) => new Set(tags));
    const pattern = this.config.tagPattern;
    const common = [...first].filter((tag) => rest.every((tags) => tags.has(tag)) && (!pattern || pattern.test(tag)));
    return sortTagsForDisplay(common);
  }

  private async listTags(image: string, auth: RegistryAuth | null): Promise<string[]> {
    try {
      return await listImageTags(image, auth);
    } catch (error) {
      if (error instanceof RegistryHttpError && (error.status === 401 || error.status === 403)) {
        throw new Error(
          `GHCR denied access to ${image} (HTTP ${error.status}). GHCR_TOKEN (or the configured token_env) ` +
          `needs the 'read:packages' scope and read access to the package.`,
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
