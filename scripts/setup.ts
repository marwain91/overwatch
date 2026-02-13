#!/usr/bin/env tsx
/**
 * Overwatch Setup Script
 *
 * Reads overwatch.yaml and generates a .env file with only the
 * environment variables required by your specific configuration.
 *
 * Usage:
 *   npx tsx scripts/setup.ts          # Generate .env (won't overwrite existing)
 *   npx tsx scripts/setup.ts --force  # Overwrite existing .env
 *   npx tsx scripts/setup.ts --check  # Validate existing .env against config
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as crypto from 'crypto';
import { OverwatchConfigSchema, OverwatchConfig } from '../src/config/schema';

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'overwatch.yaml');
const ENV_PATH = path.join(ROOT, '.env');
const DATA_DIR = path.join(ROOT, 'data');

// Colors for terminal output
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

interface EnvEntry {
  key: string;
  description: string;
  required: boolean;
  defaultValue?: string;
  generate?: 'random';
}

function loadOverwatchConfig(): OverwatchConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(red(`Config file not found: ${CONFIG_PATH}`));
    console.error('Create overwatch.yaml first. See examples/ for templates.');
    process.exit(1);
  }

  const raw = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const result = OverwatchConfigSchema.safeParse(raw);

  if (!result.success) {
    console.error(red('Invalid overwatch.yaml:'));
    for (const err of result.error.errors) {
      console.error(`  - ${err.path.join('.')}: ${err.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

function getRequiredEnvVars(config: OverwatchConfig): EnvEntry[] {
  const entries: EnvEntry[] = [];

  // --- Core (always required) ---
  entries.push({
    key: 'JWT_SECRET',
    description: 'Secret for Overwatch admin JWT authentication',
    required: true,
    generate: 'random',
  });
  entries.push({
    key: 'GOOGLE_CLIENT_ID',
    description: 'Google OAuth client ID for admin login',
    required: true,
  });

  // --- Database ---
  const dbType = config.database.type;
  const dbPasswordEnv = config.database.root_password_env;
  entries.push({
    key: dbPasswordEnv,
    description: `Root password for ${dbType} database (host: ${config.database.host})`,
    required: true,
  });

  // --- Registry ---
  const regType = config.registry.type;
  const auth = config.registry.auth;

  switch (regType) {
    case 'ghcr':
      if (auth.token_env) {
        entries.push({
          key: auth.token_env,
          description: 'GitHub personal access token with packages:read scope',
          required: true,
        });
      }
      break;
    case 'dockerhub':
      if (auth.username_env) {
        entries.push({
          key: auth.username_env,
          description: 'Docker Hub username',
          required: true,
        });
      }
      if (auth.token_env) {
        entries.push({
          key: auth.token_env,
          description: 'Docker Hub access token or password',
          required: true,
        });
      }
      break;
    case 'ecr':
      if (auth.username_env) {
        entries.push({
          key: auth.username_env,
          description: 'AWS access key ID for ECR',
          required: true,
        });
      }
      if (auth.token_env) {
        entries.push({
          key: auth.token_env,
          description: 'AWS secret access key for ECR',
          required: true,
        });
      }
      if (auth.aws_region_env) {
        entries.push({
          key: auth.aws_region_env,
          description: 'AWS region for ECR (e.g., us-east-1)',
          required: true,
        });
      }
      break;
    case 'custom':
      if (auth.username_env) {
        entries.push({
          key: auth.username_env,
          description: 'Registry username',
          required: false,
        });
      }
      if (auth.token_env) {
        entries.push({
          key: auth.token_env,
          description: 'Registry token/password',
          required: false,
        });
      }
      break;
  }

  // --- Backup ---
  if (config.backup?.enabled) {
    const backup = config.backup;
    entries.push({
      key: backup.restic_password_env,
      description: 'Restic repository encryption password',
      required: true,
    });

    if (backup.provider === 's3' && backup.s3) {
      const s3 = backup.s3;
      if (s3.endpoint_env) {
        entries.push({
          key: s3.endpoint_env,
          description: 'S3-compatible storage endpoint URL',
          required: true,
        });
      }
      if (s3.bucket_env) {
        entries.push({
          key: s3.bucket_env,
          description: 'S3 bucket name for backups',
          required: true,
        });
      }
      if (s3.access_key_env) {
        entries.push({
          key: s3.access_key_env,
          description: 'S3 access key ID',
          required: true,
        });
      }
      if (s3.secret_key_env) {
        entries.push({
          key: s3.secret_key_env,
          description: 'S3 secret access key',
          required: true,
        });
      }
    }
  }

  return entries;
}

function generateEnvFile(config: OverwatchConfig, entries: EnvEntry[]): string {
  const lines: string[] = [
    `# Overwatch Environment Variables`,
    `# Project: ${config.project.name}`,
    `# Generated by: npx tsx scripts/setup.ts`,
    `# Generated at: ${new Date().toISOString()}`,
    `#`,
    `# This file was generated based on your overwatch.yaml configuration.`,
    `# Fill in the values marked with <FILL_IN> below.`,
    '',
  ];

  let currentCategory = '';

  for (const entry of entries) {
    // Add category headers
    const category = categorize(entry.key, config);
    if (category !== currentCategory) {
      if (currentCategory) lines.push('');
      lines.push(`# === ${category} ===`);
      currentCategory = category;
    }

    lines.push(`# ${entry.description}${entry.required ? '' : ' (optional)'}`);

    let value = '<FILL_IN>';
    if (entry.generate === 'random') {
      value = crypto.randomBytes(32).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 48);
    }

    if (entry.defaultValue) {
      value = entry.defaultValue;
    }

    lines.push(`${entry.key}=${value}`);
  }

  lines.push('');
  return lines.join('\n');
}

function categorize(key: string, config: OverwatchConfig): string {
  if (['JWT_SECRET', 'GOOGLE_CLIENT_ID'].includes(key)) {
    return 'Core';
  }
  if (key === config.database.root_password_env) {
    return `Database (${config.database.type})`;
  }
  if (key === config.backup?.restic_password_env) {
    return 'Backup';
  }
  const s3 = config.backup?.s3;
  if (s3 && [s3.endpoint_env, s3.bucket_env, s3.access_key_env, s3.secret_key_env].includes(key)) {
    return 'Backup';
  }
  return `Registry (${config.registry.type})`;
}

function ensureDataFiles(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`  ${green('Created')} data/`);
  }

  const dataFiles = [
    { file: 'admin-users.json', default: '[]' },
    { file: 'env-vars.json', default: '[]' },
    { file: 'tenant-env-overrides.json', default: '[]' },
    { file: 'audit.log', default: '' },
  ];

  for (const { file, default: defaultContent } of dataFiles) {
    const filePath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, defaultContent);
      console.log(`  ${green('Created')} data/${file}`);
    } else {
      console.log(`  ${dim('Exists')}  data/${file}`);
    }
  }
}

function checkExistingEnv(entries: EnvEntry[]): void {
  if (!fs.existsSync(ENV_PATH)) {
    console.error(red('.env file not found. Run without --check to generate it.'));
    process.exit(1);
  }

  // Parse existing .env
  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  const existing = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      existing.set(trimmed.substring(0, eqIndex), trimmed.substring(eqIndex + 1));
    }
  }

  let hasErrors = false;
  console.log('');
  console.log('Checking environment variables:');
  console.log('');

  for (const entry of entries) {
    const value = existing.get(entry.key);
    if (!value || value === '<FILL_IN>') {
      if (entry.required) {
        console.log(`  ${red('MISSING')}  ${entry.key} — ${entry.description}`);
        hasErrors = true;
      } else {
        console.log(`  ${yellow('EMPTY')}    ${entry.key} — ${entry.description} (optional)`);
      }
    } else {
      console.log(`  ${green('OK')}       ${entry.key}`);
    }
  }

  // Check for unknown vars in .env that aren't in the required list
  const knownKeys = new Set(entries.map(e => e.key));
  const unknownKeys = [...existing.keys()].filter(k => !knownKeys.has(k));
  if (unknownKeys.length > 0) {
    console.log('');
    console.log(yellow('Extra variables in .env (not required by current config):'));
    for (const key of unknownKeys) {
      console.log(`  ${dim('EXTRA')}    ${key}`);
    }
  }

  console.log('');
  if (hasErrors) {
    console.error(red('Some required variables are missing. Fill them in your .env file.'));
    process.exit(1);
  } else {
    console.log(green('All required variables are set.'));
  }
}

// --- Main ---
function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const check = args.includes('--check');

  console.log('');
  console.log(green('Overwatch Setup'));
  console.log('================');
  console.log('');

  // Step 1: Load and validate overwatch.yaml
  console.log(`Reading ${dim('overwatch.yaml')}...`);
  const config = loadOverwatchConfig();
  console.log(`  Project: ${green(config.project.name)}`);
  console.log(`  Database: ${config.database.type} @ ${config.database.host}`);
  console.log(`  Registry: ${config.registry.type} @ ${config.registry.url}/${config.registry.repository}`);
  if (config.backup?.enabled) {
    console.log(`  Backup: ${config.backup.provider}`);
  }
  console.log('');

  // Step 2: Determine required env vars
  const entries = getRequiredEnvVars(config);

  // Check mode
  if (check) {
    checkExistingEnv(entries);
    return;
  }

  // Step 3: Generate .env
  if (fs.existsSync(ENV_PATH) && !force) {
    console.log(yellow('.env already exists. Use --force to overwrite, or --check to validate.'));
    console.log('');
    checkExistingEnv(entries);
    return;
  }

  console.log('Generating .env file...');
  const envContent = generateEnvFile(config, entries);
  fs.writeFileSync(ENV_PATH, envContent);
  console.log(`  ${green('Created')} .env`);
  console.log('');

  // Step 4: Ensure data directory and files exist
  console.log('Ensuring data files...');
  ensureDataFiles();
  console.log('');

  // Step 5: Summary
  const fillCount = entries.filter(e => !e.generate).length;
  console.log(green('Setup complete!'));
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Edit ${dim('.env')} and fill in the ${fillCount} values marked with <FILL_IN>`);
  console.log(`  2. Run ${dim('npx tsx scripts/setup.ts --check')} to validate`);
  console.log(`  3. Run ${dim('docker compose up -d')} to start Overwatch`);
  console.log('');
}

main();
