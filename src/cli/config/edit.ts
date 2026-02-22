import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import inquirer from 'inquirer';
import { loadConfig, loadRawConfig, clearConfigCache } from '../../config/loader';
import { OverwatchConfigSchema } from '../../config/schema';
import { header, success, warn, fail, info, BOLD, DIM, CYAN, GREEN, RED, NC } from './utils';

const EDITABLE_SECTIONS = [
  'project',
  'database',
  'registry',
  'backup',
  'monitoring',
  'credentials',
  'networking',
  'admin_access',
  'tenant_template',
] as const;

const NON_EDITABLE_SECTIONS = ['services', 'alert_rules'] as const;

type EditableSection = typeof EDITABLE_SECTIONS[number];

function getConfigPath(): string {
  return process.env.OVERWATCH_CONFIG || path.join(process.cwd(), 'overwatch.yaml');
}

function flattenObject(obj: Record<string, unknown>, prefix = ''): Array<{ key: string; value: unknown }> {
  const result: Array<{ key: string; value: unknown }> = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.push(...flattenObject(value as Record<string, unknown>, fullKey));
    } else {
      result.push({ key: fullKey, value });
    }
  }
  return result;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function coerceValue(currentValue: unknown, input: string): unknown {
  if (typeof currentValue === 'boolean') {
    return input.toLowerCase() === 'true' || input === '1';
  }
  if (typeof currentValue === 'number') {
    const num = Number(input);
    if (isNaN(num)) return currentValue;
    return num;
  }
  return input;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '(not set)';
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

async function editSection(section: EditableSection, rawConfig: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const config = loadConfig() as Record<string, unknown>;
  const sectionData = config[section];

  if (!sectionData || typeof sectionData !== 'object') {
    info(`Section "${section}" is not configured. Adding new values.`);
  }

  const currentValues = sectionData && typeof sectionData === 'object'
    ? sectionData as Record<string, unknown>
    : {};

  const fields = flattenObject(currentValues);

  if (fields.length === 0) {
    warn(`No editable fields found in "${section}".`);
    return null;
  }

  console.log('');
  console.log(`  ${DIM}Current values for ${BOLD}${section}${NC}${DIM}:${NC}`);
  for (const field of fields) {
    console.log(`    ${field.key} = ${displayValue(field.value)}`);
  }
  console.log('');

  const changes: Record<string, unknown> = {};
  let hasChanges = false;

  for (const field of fields) {
    // Skip arrays and complex objects
    if (Array.isArray(field.value)) {
      continue;
    }

    const currentStr = field.value !== null && field.value !== undefined
      ? String(field.value) : '';

    const { newValue } = await inquirer.prompt([{
      type: 'input',
      name: 'newValue',
      message: `${field.key}:`,
      default: currentStr,
    }]);

    const coerced = coerceValue(field.value, newValue);
    if (String(coerced) !== String(field.value)) {
      changes[field.key] = coerced;
      hasChanges = true;
    }
  }

  if (!hasChanges) {
    info('No changes made.');
    return null;
  }

  // Show diff
  console.log('');
  console.log(`  ${BOLD}Changes:${NC}`);
  for (const [key, newVal] of Object.entries(changes)) {
    const oldVal = fields.find(f => f.key === key)?.value;
    console.log(`    ${key}: ${RED}${displayValue(oldVal)}${NC} => ${GREEN}${displayValue(newVal)}${NC}`);
  }
  console.log('');

  const { confirmed } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirmed',
    message: 'Save these changes?',
    default: true,
  }]);

  if (!confirmed) {
    warn('Changes discarded.');
    return null;
  }

  return changes;
}

export async function runConfigEdit(args: string[]): Promise<void> {
  const sectionArg = args.find(a => !a.startsWith('--')) as EditableSection | undefined;

  let section: EditableSection;

  if (sectionArg) {
    if (NON_EDITABLE_SECTIONS.includes(sectionArg as any)) {
      console.log('');
      warn(`"${sectionArg}" contains complex arrays that are best edited directly in YAML.`);
      info(`Edit your overwatch.yaml file directly for the "${sectionArg}" section.`);
      info('Run "overwatch config docs ' + sectionArg + '" for available options.');
      console.log('');
      return;
    }
    if (!EDITABLE_SECTIONS.includes(sectionArg)) {
      console.error(`\nUnknown section: ${sectionArg}`);
      console.error(`Editable sections: ${EDITABLE_SECTIONS.join(', ')}\n`);
      process.exit(1);
    }
    section = sectionArg;
  } else {
    header('Edit Configuration');

    const { selectedSection } = await inquirer.prompt([{
      type: 'list',
      name: 'selectedSection',
      message: 'Which section would you like to edit?',
      choices: [
        ...EDITABLE_SECTIONS.map(s => ({ name: s, value: s })),
        new inquirer.Separator(),
        { name: `${DIM}services (edit YAML directly)${NC}`, value: '_services', disabled: 'complex array' },
        { name: `${DIM}alert_rules (edit YAML directly)${NC}`, value: '_alert_rules', disabled: 'complex array' },
      ],
    }]);

    section = selectedSection;
  }

  header(`Edit: ${section}`);

  let rawConfig: Record<string, unknown>;
  try {
    rawConfig = loadRawConfig();
  } catch (err: any) {
    fail(err.message);
    return;
  }

  const changes = await editSection(section, rawConfig);

  if (!changes) {
    return;
  }

  // Apply changes to raw config
  if (!rawConfig[section] || typeof rawConfig[section] !== 'object') {
    rawConfig[section] = {};
  }

  for (const [key, value] of Object.entries(changes)) {
    // key is relative to section, e.g. "host" or "auth.type"
    setNestedValue(rawConfig[section] as Record<string, unknown>, key, value);
  }

  // Validate before saving
  const parseResult = OverwatchConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    fail('Validation failed with the new values:');
    for (const err of parseResult.error.errors) {
      console.log(`    ${RED}${err.path.join('.')}:${NC} ${err.message}`);
    }
    console.log('');
    warn('Changes not saved. Fix the values and try again.');
    return;
  }

  // Write config
  const configPath = getConfigPath();
  warn('YAML comments will not be preserved.');

  const yamlContent = yaml.dump(rawConfig, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  });

  fs.writeFileSync(configPath, yamlContent, 'utf-8');
  clearConfigCache();

  success(`Configuration saved to ${configPath}`);
  console.log('');
}
