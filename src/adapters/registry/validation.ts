import { AppRegistry, RegistryField, registryFieldErrors } from '../../models/app';
import { ValidationError } from '../../utils/httpErrors';

// The registry formats arrived after definitions were already stored, so they
// are enforced in three places instead of the schema: new values on write,
// stored values with a warning on load, and every value right before docker or
// a registry API sees it.

const PULL_FIELDS: RegistryField[] = ['url', 'repository'];
const ALL_FIELDS: RegistryField[] = ['url', 'repository', 'api_url'];

/**
 * Write path: refuse a registry field whose new value has the wrong format. A
 * field left at its stored value is not re-checked, so an unrelated edit or a
 * manifest sync of an app stored before the formats still goes through.
 */
export function assertRegistryWritable(next: AppRegistry, stored: AppRegistry | undefined, prefix: string): void {
  const changed = ALL_FIELDS.filter(f => !stored || next[f] !== stored[f]);
  const errors = registryFieldErrors(next, changed);
  if (errors.length > 0) throw new ValidationError(`${prefix}: ${errors.join(', ')}`);
}

const warnedStored = new Set<string>();

/** Load path: one warning per app, field and value; the definition still loads. */
export function warnInvalidStoredRegistry(def: { id: string; registry: AppRegistry }): void {
  for (const field of ALL_FIELDS) {
    const [error] = registryFieldErrors(def.registry, [field]);
    const key = `${def.id}:${field}:${def.registry[field]}`;
    if (!error || warnedStored.has(key)) continue;
    warnedStored.add(key);
    console.warn(`[apps] App '${def.id}' has an invalid ${error}. Pulls and tag listing for it are refused until it is fixed.`);
  }
}

/**
 * Use path: refuse the operation when a registry field it passes to docker or
 * a registry API has the wrong format. Pulls need url and repository; tag
 * listing also uses api_url.
 */
export function assertRegistryUsable(app: { id: string; registry: AppRegistry }, operation: 'pull' | 'list tags'): void {
  const errors = registryFieldErrors(app.registry, operation === 'pull' ? PULL_FIELDS : ALL_FIELDS);
  if (errors.length > 0) {
    throw new ValidationError(`Refusing to ${operation} for app '${app.id}', its registry settings are invalid: ${errors.join(', ')}`);
  }
}
