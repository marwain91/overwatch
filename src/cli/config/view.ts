import { loadConfig, loadRawConfig, resolveEnvValue } from '../../config/loader';
import { header, BOLD, DIM, CYAN, YELLOW, NC, WHITE } from './utils';

const SECRET_PATTERNS = ['password', 'secret', 'token', 'key'];

function isSecret(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_PATTERNS.some(p => lower.includes(p));
}

function hasEnvRef(value: string): boolean {
  return typeof value === 'string' && /\$\{[^}]+\}/.test(value);
}

function formatValue(value: unknown, key: string, raw: boolean): string {
  if (value === null || value === undefined) return `${DIM}(not set)${NC}`;
  if (typeof value === 'boolean') return value ? `${CYAN}true${NC}` : `${DIM}false${NC}`;
  if (typeof value === 'number') return `${CYAN}${value}${NC}`;

  const strVal = String(value);
  if (typeof value === 'string' && hasEnvRef(strVal) && !raw) {
    const resolved = resolveEnvValue(strVal);
    const display = isSecret(key) ? '****' : resolved;
    return `${YELLOW}${strVal}${NC} ${DIM}=> ${display}${NC}`;
  }

  if (typeof value === 'string' && isSecret(key)) {
    return `${DIM}****${NC}`;
  }

  return `${WHITE}${strVal}${NC}`;
}

function printTree(
  obj: Record<string, unknown>,
  rawObj: Record<string, unknown> | undefined,
  prefix: string,
  raw: boolean,
): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (Array.isArray(value)) {
      const inRaw = rawObj && key in rawObj;
      const tag = inRaw ? '' : ` ${DIM}(default)${NC}`;
      console.log(`  ${BOLD}${path}${NC}:${tag}`);
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item === 'object' && item !== null) {
          console.log(`    ${DIM}[${i}]${NC}`);
          printTree(
            item as Record<string, unknown>,
            rawObj && Array.isArray(rawObj[key]) ? (rawObj[key] as any[])[i] : undefined,
            `${path}[${i}]`,
            raw,
          );
        } else {
          console.log(`    ${DIM}[${i}]${NC} ${formatValue(item, key, raw)}`);
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      const inRaw = rawObj && key in rawObj;
      const tag = inRaw ? '' : ` ${DIM}(default)${NC}`;
      console.log(`  ${BOLD}${path}${NC}:${tag}`);
      printTree(
        value as Record<string, unknown>,
        rawObj && typeof rawObj[key] === 'object' && rawObj[key] !== null
          ? rawObj[key] as Record<string, unknown>
          : undefined,
        path,
        raw,
      );
    } else {
      const inRaw = rawObj && key in rawObj;
      const defaultTag = inRaw ? '' : ` ${DIM}(default)${NC}`;
      console.log(`  ${DIM}${path}${NC} = ${formatValue(value, key, raw)}${defaultTag}`);
    }
  }
}

export async function runConfigView(args: string[]): Promise<void> {
  const rawFlag = args.includes('--raw');
  const jsonFlag = args.includes('--json');
  const section = args.find(a => !a.startsWith('--'));

  const config = loadConfig() as Record<string, unknown>;
  let rawConfig: Record<string, unknown> | undefined;
  try {
    rawConfig = loadRawConfig();
  } catch {
    // Raw config unavailable — treat everything as explicit
    rawConfig = config;
  }

  let viewData = config;
  let viewRaw = rawConfig;

  if (section) {
    if (!(section in config)) {
      console.error(`\nUnknown section: ${section}`);
      console.error(`Available sections: ${Object.keys(config).join(', ')}\n`);
      process.exit(1);
    }
    const sectionValue = config[section];
    if (typeof sectionValue !== 'object' || sectionValue === null) {
      // Scalar top-level value
      if (jsonFlag) {
        console.log(JSON.stringify({ [section]: sectionValue }, null, 2));
      } else {
        header(`Config: ${section}`);
        console.log(`  ${DIM}${section}${NC} = ${formatValue(sectionValue, section, rawFlag)}`);
      }
      console.log('');
      return;
    }
    viewData = { [section]: sectionValue };
    viewRaw = rawConfig ? { [section]: rawConfig[section] } : viewData;
  }

  if (jsonFlag) {
    console.log(JSON.stringify(section ? config[section] : config, null, 2));
    return;
  }

  header(section ? `Config: ${section}` : 'Configuration');
  printTree(viewData, viewRaw, '', rawFlag);
  console.log('');
}
