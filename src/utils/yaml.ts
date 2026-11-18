import * as yaml from 'js-yaml';

export * from 'js-yaml';

// js-yaml 5 defaults to YAML 1.2 Core. Preserve the js-yaml 4 configuration
// features used by existing installations, especially anchor merge keys.
const configSchema = yaml.CORE_SCHEMA.withTags(
  yaml.mergeTag, yaml.timestampTag, yaml.binaryTag,
  yaml.omapTag, yaml.pairsTag, yaml.setTag,
);

export function load(input: string, options?: yaml.LoadOptions): unknown {
  return yaml.load(input, { schema: configSchema, ...options });
}
