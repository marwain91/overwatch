import { ZodType, ZodObject, ZodArray, ZodDefault, ZodOptional, ZodEnum, ZodNumber, ZodString, ZodBoolean, ZodRecord } from 'zod';
import { OverwatchConfigSchema } from '../../config/schema';
import { header, BOLD, DIM, CYAN, NC } from './utils';

interface FieldDoc {
  path: string;
  type: string;
  required: boolean;
  defaultValue?: unknown;
  description?: string;
}

function getZodType(schema: ZodType): { type: string; required: boolean; defaultValue?: unknown; description?: string; inner?: ZodType } {
  const def = (schema as any)._def;
  const description = def.description;

  if (schema instanceof ZodDefault) {
    const inner = getZodType(def.innerType);
    const defaultValue = def.defaultValue();
    return { ...inner, required: false, defaultValue, description: description || inner.description };
  }

  if (schema instanceof ZodOptional) {
    const inner = getZodType(def.innerType);
    return { ...inner, required: false, description: description || inner.description };
  }

  if (schema instanceof ZodEnum) {
    const values = def.values.join('|');
    return { type: `enum(${values})`, required: true, description };
  }

  if (schema instanceof ZodString) {
    return { type: 'string', required: true, description };
  }

  if (schema instanceof ZodNumber) {
    return { type: 'number', required: true, description };
  }

  if (schema instanceof ZodBoolean) {
    return { type: 'boolean', required: true, description };
  }

  if (schema instanceof ZodRecord) {
    return { type: 'record<string, string>', required: true, description };
  }

  if (schema instanceof ZodArray) {
    const itemType = getZodType(def.type);
    if (def.type instanceof ZodObject) {
      return { type: 'array<object>', required: true, description, inner: def.type };
    }
    return { type: `array<${itemType.type}>`, required: true, description };
  }

  if (schema instanceof ZodObject) {
    return { type: 'object', required: true, description, inner: schema };
  }

  return { type: 'unknown', required: true, description };
}

function walkSchema(schema: ZodType, prefix: string, docs: FieldDoc[]): void {
  const info = getZodType(schema);

  if (info.inner && info.inner instanceof ZodObject) {
    const shape = (info.inner as any)._def.shape();
    for (const [key, value] of Object.entries(shape)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const fieldInfo = getZodType(value as ZodType);

      if (fieldInfo.inner && fieldInfo.inner instanceof ZodObject) {
        // Nested object — recurse
        if (fieldInfo.description) {
          docs.push({
            path,
            type: fieldInfo.type,
            required: fieldInfo.required,
            defaultValue: fieldInfo.defaultValue,
            description: fieldInfo.description,
          });
        }
        walkSchema(fieldInfo.inner, path, docs);
      } else if (fieldInfo.type === 'array<object>' && fieldInfo.inner) {
        docs.push({
          path: `${path}[]`,
          type: 'array<object>',
          required: fieldInfo.required,
          defaultValue: fieldInfo.defaultValue,
          description: fieldInfo.description,
        });
        walkSchema(fieldInfo.inner, `${path}[]`, docs);
      } else {
        docs.push({
          path,
          type: fieldInfo.type,
          required: fieldInfo.required,
          defaultValue: fieldInfo.defaultValue,
          description: fieldInfo.description,
        });
      }
    }
  } else if (schema instanceof ZodObject) {
    const shape = (schema as any)._def.shape();
    for (const [key, value] of Object.entries(shape)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const fieldInfo = getZodType(value as ZodType);

      if (fieldInfo.inner && fieldInfo.inner instanceof ZodObject) {
        if (fieldInfo.description) {
          docs.push({
            path,
            type: fieldInfo.type,
            required: fieldInfo.required,
            defaultValue: fieldInfo.defaultValue,
            description: fieldInfo.description,
          });
        }
        walkSchema(fieldInfo.inner, path, docs);
      } else if (fieldInfo.type === 'array<object>' && fieldInfo.inner) {
        docs.push({
          path: `${path}[]`,
          type: 'array<object>',
          required: fieldInfo.required,
          defaultValue: fieldInfo.defaultValue,
          description: fieldInfo.description,
        });
        walkSchema(fieldInfo.inner, `${path}[]`, docs);
      } else {
        docs.push({
          path,
          type: fieldInfo.type,
          required: fieldInfo.required,
          defaultValue: fieldInfo.defaultValue,
          description: fieldInfo.description,
        });
      }
    }
  }
}

function formatDefault(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

export async function runConfigDocs(args: string[]): Promise<void> {
  const section = args.find(a => !a.startsWith('--'));

  const docs: FieldDoc[] = [];
  walkSchema(OverwatchConfigSchema, '', docs);

  let filtered = docs;
  if (section) {
    filtered = docs.filter(d => d.path.startsWith(`${section}.`) || d.path.startsWith(`${section}[`));
    if (filtered.length === 0) {
      const topLevelKeys = [...new Set(docs.map(d => d.path.split('.')[0].replace(/\[\]$/, '')))];
      console.error(`\nUnknown section: ${section}`);
      console.error(`Available sections: ${topLevelKeys.join(', ')}\n`);
      process.exit(1);
    }
  }

  header(section ? `Config Docs: ${section}` : 'Configuration Reference');

  let lastTopLevel = '';
  for (const field of filtered) {
    const topLevel = field.path.split('.')[0].replace(/\[\]$/, '');
    if (topLevel !== lastTopLevel) {
      if (lastTopLevel) console.log('');
      console.log(`  ${BOLD}${CYAN}${topLevel}${NC}`);
      lastTopLevel = topLevel;
    }

    console.log('');
    console.log(`  ${BOLD}${field.path}${NC}`);
    console.log(`    Type:     ${field.type}`);
    console.log(`    Required: ${field.required ? 'yes' : 'no'}`);
    if (field.defaultValue !== undefined) {
      console.log(`    Default:  ${formatDefault(field.defaultValue)}`);
    }
    if (field.description) {
      console.log(`    ${DIM}${field.description}${NC}`);
    }
  }

  console.log('');
}
