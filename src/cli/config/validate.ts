import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { OverwatchConfigSchema } from '../../config/schema';
import { validateEnvironment } from '../../config/validate';
import { loadConfig, findConfigPath } from '../../config/loader';
import { header, success, fail, info, BOLD, DIM, GREEN, RED, NC } from './utils';

function getConfigPath(): string {
  return findConfigPath();
}

function deepDiff(
  current: Record<string, unknown>,
  defaults: Record<string, unknown>,
  prefix = '',
): Array<{ path: string; value: unknown; defaultValue: unknown }> {
  const diffs: Array<{ path: string; value: unknown; defaultValue: unknown }> = [];

  for (const [key, value] of Object.entries(current)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const defaultValue = defaults[key];

    if (typeof value === 'object' && value !== null && !Array.isArray(value) &&
        typeof defaultValue === 'object' && defaultValue !== null && !Array.isArray(defaultValue)) {
      diffs.push(...deepDiff(
        value as Record<string, unknown>,
        defaultValue as Record<string, unknown>,
        fullPath,
      ));
    } else if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
      diffs.push({ path: fullPath, value, defaultValue });
    }
  }

  return diffs;
}

export async function runConfigValidate(args: string[]): Promise<void> {
  const diffFlag = args.includes('--diff');

  header('Configuration Validation');

  let passed = 0;
  let failed = 0;

  // Check 1: Config file exists
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    success(`Config file found: ${configPath}`);
    passed++;
  } else {
    fail(`Config file not found: ${configPath}`);
    info('Create one with "overwatch init" or create overwatch.yaml manually.');
    failed++;
    console.log('');
    showSummary(passed, failed);
    return;
  }

  // Check 2: YAML syntax
  let rawData: unknown;
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    rawData = yaml.load(content);
    success('YAML syntax is valid');
    passed++;
  } catch (err: any) {
    fail(`YAML syntax error: ${err.message}`);
    failed++;
    console.log('');
    showSummary(passed, failed);
    return;
  }

  // Check 3: Schema validation
  const parseResult = OverwatchConfigSchema.safeParse(rawData);
  if (parseResult.success) {
    success('Schema validation passed');
    passed++;
  } else {
    fail('Schema validation failed:');
    for (const err of parseResult.error.errors) {
      console.log(`    ${RED}${err.path.join('.')}:${NC} ${err.message}`);
    }
    failed++;
    console.log('');
    showSummary(passed, failed);
    return;
  }

  // Check 4: Environment variables
  const config = parseResult.data;
  const envErrors = validateEnvironment(config);
  if (envErrors.length === 0) {
    success('Environment variables are set');
    passed++;
  } else {
    fail(`Missing environment variables (${envErrors.length}):`);
    for (const err of envErrors) {
      console.log(`    ${RED}[${err.category}]${NC} ${err.message}`);
    }
    failed++;
  }

  console.log('');
  showSummary(passed, failed);

  // --diff: show customizations vs defaults
  if (diffFlag && parseResult.success) {
    showDiff(rawData as Record<string, unknown>, parseResult.data);
  }
}

function showSummary(passed: number, failed: number): void {
  const total = passed + failed;
  if (failed === 0) {
    console.log(`  ${GREEN}${BOLD}All ${total} checks passed${NC}`);
  } else {
    console.log(`  ${passed}/${total} checks passed, ${RED}${failed} failed${NC}`);
  }
  console.log('');
}

function showDiff(rawData: Record<string, unknown>, parsedConfig: Record<string, unknown>): void {
  // Build a "defaults-only" config by parsing an empty-ish object
  // We compare the parsed config (with defaults applied) against raw data
  header('Customizations vs Defaults');

  const parsed = parsedConfig as Record<string, unknown>;
  const raw = rawData as Record<string, unknown>;

  // Walk through parsed config, show what's in raw (customized) vs only in parsed (defaulted)
  const customized: Array<{ path: string; value: unknown }> = [];
  const defaulted: Array<{ path: string; value: unknown }> = [];

  function walk(parsedObj: Record<string, unknown>, rawObj: Record<string, unknown> | undefined, prefix: string) {
    for (const [key, value] of Object.entries(parsedObj)) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      const inRaw = rawObj && key in rawObj;

      if (Array.isArray(value)) {
        if (inRaw) customized.push({ path: fullPath, value: `[${value.length} items]` });
        else defaulted.push({ path: fullPath, value: `[${value.length} items]` });
      } else if (typeof value === 'object' && value !== null) {
        walk(
          value as Record<string, unknown>,
          inRaw && typeof rawObj![key] === 'object' && rawObj![key] !== null
            ? rawObj![key] as Record<string, unknown>
            : undefined,
          fullPath,
        );
      } else {
        if (inRaw) customized.push({ path: fullPath, value });
        else defaulted.push({ path: fullPath, value });
      }
    }
  }

  walk(parsed, raw, '');

  if (customized.length > 0) {
    console.log(`  ${BOLD}Customized (${customized.length}):${NC}`);
    for (const item of customized) {
      console.log(`    ${GREEN}+${NC} ${item.path} = ${item.value}`);
    }
    console.log('');
  }

  if (defaulted.length > 0) {
    console.log(`  ${BOLD}Defaults (${defaulted.length}):${NC}`);
    for (const item of defaulted) {
      console.log(`    ${DIM}  ${item.path} = ${item.value}${NC}`);
    }
    console.log('');
  }
}
