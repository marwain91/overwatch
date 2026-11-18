import * as yaml from 'js-yaml';

// Preserve numeric colon-separated strings such as UID:GID and short port
// mappings. js-yaml 5 quotes valid YAML 1.1 numbers, but no longer quotes every
// look-alike that older Compose readers may interpret differently.
const quoteColonNumbers: yaml.ScalarStyleRule = layout => {
  if (layout.style === yaml.SCALAR_STYLE.PLAIN && /^\d+(?::\d+)+$/.test(layout.node.value)) {
    layout.style = yaml.SCALAR_STYLE.DOUBLE_QUOTED;
  }
};

export const composeYamlOptions: yaml.DumpOptions = {
  noRefs: true,
  quoteStyle: 'double',
  scalarStyleRules: [quoteColonNumbers, ...Object.values(yaml.DEFAULT_SCALAR_STYLE_RULES)],
};
