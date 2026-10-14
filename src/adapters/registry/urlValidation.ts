import { assertPublicUrl } from '../../utils/ssrf';

/**
 * Validate a registry/API URL is not targeting internal/private addresses.
 *
 * Set `OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL=1` to opt out — necessary when
 * Overwatch and the registry/API host share a private network on purpose
 * (self-hosted GitLab/Harbor on a LAN, for example).
 *
 * Accepts either a full URL (`https://gitlab.acme.com:8080`) or a bare host
 * (`gitlab.acme.com`, `registry.lan:5000`).
 */
export async function validateRegistryUrl(url: string): Promise<void> {
  await assertPublicUrl(url.includes('://') ? url : `https://${url}`, {
    allowPrivateEnv: 'OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL',
    label: 'Registry URL',
  });
}
