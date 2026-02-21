import inquirer from 'inquirer';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

// ─── Types ──────────────────────────────────────────────────────────────────────

interface DnsProviderDef {
  label: string;
  envVars: { name: string; label: string; secret?: boolean }[];
}

interface RegistryDef {
  label: string;
  url: string;
  authType: 'token' | 'basic' | 'aws_iam';
  envVars: { envName: string; configKey: string; label: string; secret?: boolean }[];
}

interface InitConfig {
  // Project
  projectName: string;
  projectPrefix: string;
  deployDir: string;
  domain: string;
  // Database
  dbType: 'mariadb' | 'postgres';
  dbPassword: string;
  // Registry
  registryType: 'ghcr' | 'dockerhub' | 'ecr' | 'custom';
  registryUrl: string;
  registryRepo: string;
  registryAuthType: 'token' | 'basic' | 'aws_iam';
  registryEnvVars: { envName: string; configKey: string; value: string }[];
  // SSL / DNS
  dnsProvider: string;
  dnsEnvVars: { name: string; value: string }[];
  adminEmail: string;
  // Overwatch access
  overwatchDomain: string;
  googleClientId: string;
  allowedAdminEmails: string;
  // Secrets
  jwtSecret: string;
  // Backup
  backupEnabled: boolean;
  s3Endpoint: string;
  s3Bucket: string;
  s3AccessKey: string;
  s3SecretKey: string;
  resticPassword: string;
  backupSchedule: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

const DNS_PROVIDERS: Record<string, DnsProviderDef> = {
  cloudflare: {
    label: 'Cloudflare',
    envVars: [{ name: 'CF_DNS_API_TOKEN', label: 'Cloudflare API token', secret: true }],
  },
  digitalocean: {
    label: 'DigitalOcean',
    envVars: [{ name: 'DO_AUTH_TOKEN', label: 'DigitalOcean API token', secret: true }],
  },
  hetzner: {
    label: 'Hetzner',
    envVars: [{ name: 'HETZNER_API_KEY', label: 'Hetzner DNS API key', secret: true }],
  },
  route53: {
    label: 'AWS Route 53',
    envVars: [
      { name: 'AWS_ACCESS_KEY_ID', label: 'AWS access key ID' },
      { name: 'AWS_SECRET_ACCESS_KEY', label: 'AWS secret access key', secret: true },
      { name: 'AWS_REGION', label: 'AWS region (e.g. us-east-1)' },
      { name: 'AWS_HOSTED_ZONE_ID', label: 'Route 53 hosted zone ID' },
    ],
  },
};

const REGISTRY_TYPES: Record<string, RegistryDef> = {
  ghcr: {
    label: 'GitHub Container Registry',
    url: 'ghcr.io',
    authType: 'token',
    envVars: [
      { envName: 'GHCR_TOKEN', configKey: 'token_env', label: 'GitHub personal access token (with read:packages)', secret: true },
    ],
  },
  dockerhub: {
    label: 'Docker Hub',
    url: 'docker.io',
    authType: 'basic',
    envVars: [
      { envName: 'DOCKER_USERNAME', configKey: 'username_env', label: 'Docker Hub username' },
      { envName: 'DOCKER_PASSWORD', configKey: 'token_env', label: 'Docker Hub password or access token', secret: true },
    ],
  },
  ecr: {
    label: 'AWS ECR',
    url: '',
    authType: 'aws_iam',
    envVars: [
      { envName: 'AWS_ACCESS_KEY_ID', configKey: 'username_env', label: 'AWS access key ID' },
      { envName: 'AWS_SECRET_ACCESS_KEY', configKey: 'token_env', label: 'AWS secret access key', secret: true },
      { envName: 'AWS_REGION', configKey: 'aws_region_env', label: 'AWS region (e.g. us-east-1)' },
    ],
  },
  custom: {
    label: 'Custom Registry',
    url: '',
    authType: 'basic',
    envVars: [
      { envName: 'REGISTRY_USERNAME', configKey: 'username_env', label: 'Registry username' },
      { envName: 'REGISTRY_PASSWORD', configKey: 'token_env', label: 'Registry password or token', secret: true },
    ],
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────────

function header(title: string): void {
  const bar = '━'.repeat(Math.max(0, 48 - title.length));
  console.log('');
  console.log(`${CYAN}━━━ ${title} ${bar}${NC}`);
  console.log('');
}

function success(msg: string): void {
  console.log(`  ${GREEN}✓${NC} ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ${YELLOW}!${NC} ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ${RED}✗${NC} ${msg}`);
}

function info(msg: string): void {
  console.log(`  ${DIM}${msg}${NC}`);
}

function generateSecret(length: number): string {
  return crypto.randomBytes(Math.ceil(length * 0.75)).toString('base64url').slice(0, length);
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function writeFileSafe(filePath: string, content: string): Promise<boolean> {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing === content) {
      info(`Unchanged ${path.basename(filePath)}`);
      return true;
    }
    const { overwrite } = await inquirer.prompt([{
      type: 'confirm',
      name: 'overwrite',
      message: `${path.basename(filePath)} already exists. Overwrite?`,
      default: false,
    }]);
    if (!overwrite) {
      warn(`Skipped ${path.basename(filePath)}`);
      return false;
    }
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  success(`Created ${path.basename(filePath)}`);
  return true;
}

// ─── Step 1: Prerequisites ──────────────────────────────────────────────────────

async function checkPrerequisites(): Promise<void> {
  console.log(`${DIM}Checking prerequisites...${NC}`);
  console.log('');

  if (commandExists('docker')) {
    success('Docker is installed');
  } else {
    warn('Docker not found (needed to start services)');
  }

  try {
    execSync('docker compose version', { stdio: 'pipe' });
    success('Docker Compose is available');
  } catch {
    warn('Docker Compose not found (needed to start services)');
  }

  // Check docker connectivity
  try {
    execSync('docker ps', { stdio: 'pipe' });
  } catch {
    warn('Cannot connect to Docker daemon');
  }

  console.log('');
}

// ─── Step 2: Project Basics ─────────────────────────────────────────────────────

async function collectProjectBasics(): Promise<Pick<InitConfig, 'projectName' | 'projectPrefix' | 'deployDir' | 'domain'>> {
  header('Step 1: Project Basics');

  const { projectName } = await inquirer.prompt([{
    type: 'input',
    name: 'projectName',
    message: 'Project name (display name):',
    default: 'MyApp',
  }]);

  const defaultPrefix = projectName.toLowerCase().replace(/[^a-z0-9]/g, '');

  const { projectPrefix } = await inquirer.prompt([{
    type: 'input',
    name: 'projectPrefix',
    message: 'Project prefix (for containers & databases):',
    default: defaultPrefix,
    validate: (input: string) => /^[a-z][a-z0-9]*$/.test(input) || 'Lowercase, starts with letter, alphanumeric only',
  }]);

  const { deployDir } = await inquirer.prompt([{
    type: 'input',
    name: 'deployDir',
    message: 'Deploy directory:',
    default: `/opt/${projectPrefix}/deploy`,
  }]);

  const { domain } = await inquirer.prompt([{
    type: 'input',
    name: 'domain',
    message: 'Domain (e.g. example.com):',
    validate: (input: string) => input.includes('.') || 'Enter a valid domain',
  }]);

  return { projectName, projectPrefix, deployDir, domain };
}

// ─── Step 3: Database ───────────────────────────────────────────────────────────

async function collectDatabase(): Promise<Pick<InitConfig, 'dbType' | 'dbPassword'>> {
  header('Step 2: Database');

  const { dbType } = await inquirer.prompt([{
    type: 'list',
    name: 'dbType',
    message: 'Database type:',
    choices: [
      { name: 'MariaDB', value: 'mariadb' },
      { name: 'PostgreSQL', value: 'postgres' },
    ],
    default: 'mariadb',
  }]);

  const { useGenerated } = await inquirer.prompt([{
    type: 'confirm',
    name: 'useGenerated',
    message: 'Generate a random root password?',
    default: true,
  }]);

  let dbPassword: string;
  if (useGenerated) {
    dbPassword = generateSecret(32);
    info('Password generated (will be saved to .env files)');
  } else {
    const { password } = await inquirer.prompt([{
      type: 'password',
      name: 'password',
      message: 'Database root password:',
      mask: '*',
      validate: (input: string) => input.length >= 8 || 'Password must be at least 8 characters',
    }]);
    dbPassword = password;
  }

  return { dbType, dbPassword };
}

// ─── Step 4: Registry ───────────────────────────────────────────────────────────

async function collectRegistry(): Promise<Pick<InitConfig, 'registryType' | 'registryUrl' | 'registryRepo' | 'registryAuthType' | 'registryEnvVars'>> {
  header('Step 3: Container Registry');

  const { registryType } = await inquirer.prompt([{
    type: 'list',
    name: 'registryType',
    message: 'Registry type:',
    choices: Object.entries(REGISTRY_TYPES).map(([value, def]) => ({
      name: def.label,
      value,
    })),
    default: 'ghcr',
  }]);

  const registryDef = REGISTRY_TYPES[registryType];
  let registryUrl = registryDef.url;

  if (!registryUrl) {
    const { url } = await inquirer.prompt([{
      type: 'input',
      name: 'url',
      message: 'Registry URL:',
      validate: (input: string) => input.length > 0 || 'Required',
    }]);
    registryUrl = url;
  }

  const { registryRepo } = await inquirer.prompt([{
    type: 'input',
    name: 'registryRepo',
    message: 'Repository path (e.g. myorg/myapp):',
    validate: (input: string) => input.includes('/') || 'Use format: org/repo',
  }]);

  const registryEnvVars: InitConfig['registryEnvVars'] = [];
  for (const envVar of registryDef.envVars) {
    const { value } = await inquirer.prompt([{
      type: envVar.secret ? 'password' : 'input',
      name: 'value',
      message: `${envVar.label}:`,
      mask: envVar.secret ? '*' : undefined,
      validate: (input: string) => input.length > 0 || 'Required',
    }]);
    registryEnvVars.push({ envName: envVar.envName, configKey: envVar.configKey, value });
  }

  return {
    registryType: registryType as InitConfig['registryType'],
    registryUrl,
    registryRepo,
    registryAuthType: registryDef.authType,
    registryEnvVars,
  };
}

// ─── Step 5: SSL / Reverse Proxy ────────────────────────────────────────────────

async function collectSsl(domain: string): Promise<Pick<InitConfig, 'dnsProvider' | 'dnsEnvVars' | 'adminEmail'>> {
  header('Step 4: SSL & Reverse Proxy');

  info('Traefik will handle SSL via DNS challenge for wildcard certificates.');
  console.log('');

  const { dnsProvider } = await inquirer.prompt([{
    type: 'list',
    name: 'dnsProvider',
    message: 'DNS provider:',
    choices: [
      ...Object.entries(DNS_PROVIDERS).map(([value, def]) => ({
        name: def.label,
        value,
      })),
      { name: 'Other', value: 'other' },
    ],
    default: 'cloudflare',
  }]);

  const dnsEnvVars: InitConfig['dnsEnvVars'] = [];
  let actualProvider = dnsProvider;

  if (dnsProvider === 'other') {
    const { providerName } = await inquirer.prompt([{
      type: 'input',
      name: 'providerName',
      message: 'Traefik DNS provider name (see doc.traefik.io/traefik/https/acme/#providers):',
      validate: (input: string) => input.length > 0 || 'Required',
    }]);
    actualProvider = providerName;

    const { envName } = await inquirer.prompt([{
      type: 'input',
      name: 'envName',
      message: 'Environment variable name for API token:',
      validate: (input: string) => /^[A-Z_]+$/.test(input) || 'Use UPPER_SNAKE_CASE',
    }]);
    const { envValue } = await inquirer.prompt([{
      type: 'password',
      name: 'envValue',
      message: `${envName}:`,
      mask: '*',
    }]);
    dnsEnvVars.push({ name: envName, value: envValue });
  } else {
    const providerDef = DNS_PROVIDERS[dnsProvider];
    for (const envDef of providerDef.envVars) {
      const { value } = await inquirer.prompt([{
        type: envDef.secret ? 'password' : 'input',
        name: 'value',
        message: `${envDef.label}:`,
        mask: envDef.secret ? '*' : undefined,
        validate: (input: string) => input.length > 0 || 'Required',
      }]);
      dnsEnvVars.push({ name: envDef.name, value });
    }
  }

  const { adminEmail } = await inquirer.prompt([{
    type: 'input',
    name: 'adminEmail',
    message: 'Admin email (for Let\'s Encrypt notifications):',
    validate: (input: string) => input.includes('@') || 'Enter a valid email',
  }]);

  return { dnsProvider: actualProvider, dnsEnvVars, adminEmail };
}

// ─── Step 6: Overwatch Access ───────────────────────────────────────────────────

async function collectAccess(domain: string): Promise<Pick<InitConfig, 'overwatchDomain' | 'googleClientId' | 'allowedAdminEmails' | 'jwtSecret'>> {
  header('Step 5: Overwatch Access');

  const { overwatchDomain } = await inquirer.prompt([{
    type: 'input',
    name: 'overwatchDomain',
    message: 'Overwatch subdomain:',
    default: `overwatch.${domain}`,
  }]);

  const { googleClientId } = await inquirer.prompt([{
    type: 'input',
    name: 'googleClientId',
    message: 'Google OAuth Client ID:',
    validate: (input: string) => input.includes('.apps.googleusercontent.com') || input.length > 10 || 'Enter a valid Google Client ID',
  }]);

  const { allowedAdminEmails } = await inquirer.prompt([{
    type: 'input',
    name: 'allowedAdminEmails',
    message: 'Admin email(s) for initial access (comma-separated):',
    validate: (input: string) => input.includes('@') || 'Enter at least one email',
  }]);

  const jwtSecret = generateSecret(64);

  return { overwatchDomain, googleClientId, allowedAdminEmails, jwtSecret };
}

// ─── Step 7: Backup ─────────────────────────────────────────────────────────────

async function collectBackup(): Promise<Pick<InitConfig, 'backupEnabled' | 's3Endpoint' | 's3Bucket' | 's3AccessKey' | 's3SecretKey' | 'resticPassword' | 'backupSchedule'>> {
  header('Step 6: Backups');

  const defaults = {
    backupEnabled: false,
    s3Endpoint: '',
    s3Bucket: '',
    s3AccessKey: '',
    s3SecretKey: '',
    resticPassword: '',
    backupSchedule: '0 2 * * *',
  };

  const { backupEnabled } = await inquirer.prompt([{
    type: 'confirm',
    name: 'backupEnabled',
    message: 'Enable automatic backups (S3-compatible storage)?',
    default: true,
  }]);

  if (!backupEnabled) {
    return { ...defaults, backupEnabled: false };
  }

  const { s3Endpoint } = await inquirer.prompt([{
    type: 'input',
    name: 's3Endpoint',
    message: 'S3 endpoint URL (e.g. https://s3.us-east-1.amazonaws.com or R2 URL):',
    validate: (input: string) => input.startsWith('https://') || input.startsWith('http://') || 'Must start with https:// or http://',
  }]);

  const { s3Bucket } = await inquirer.prompt([{
    type: 'input',
    name: 's3Bucket',
    message: 'S3 bucket name:',
    validate: (input: string) => input.length > 0 || 'Required',
  }]);

  const { s3AccessKey } = await inquirer.prompt([{
    type: 'input',
    name: 's3AccessKey',
    message: 'S3 access key ID:',
    validate: (input: string) => input.length > 0 || 'Required',
  }]);

  const { s3SecretKey } = await inquirer.prompt([{
    type: 'password',
    name: 's3SecretKey',
    message: 'S3 secret access key:',
    mask: '*',
    validate: (input: string) => input.length > 0 || 'Required',
  }]);

  const resticPassword = generateSecret(32);
  info('Restic encryption password generated (will be saved to .env)');

  const { backupSchedule } = await inquirer.prompt([{
    type: 'input',
    name: 'backupSchedule',
    message: 'Backup schedule (cron expression):',
    default: '0 2 * * *',
  }]);

  return { backupEnabled, s3Endpoint, s3Bucket, s3AccessKey, s3SecretKey, resticPassword, backupSchedule };
}

// ─── Summary ────────────────────────────────────────────────────────────────────

async function showSummary(config: InitConfig): Promise<boolean> {
  header('Summary');

  const registryDef = REGISTRY_TYPES[config.registryType];

  console.log(`  ${BOLD}Project:${NC}    ${config.projectName} (${config.projectPrefix})`);
  console.log(`  ${BOLD}Domain:${NC}     ${config.domain}`);
  console.log(`  ${BOLD}Deploy to:${NC}  ${config.deployDir}`);
  console.log(`  ${BOLD}Database:${NC}   ${config.dbType === 'mariadb' ? 'MariaDB' : 'PostgreSQL'}`);
  console.log(`  ${BOLD}Registry:${NC}   ${registryDef?.label || config.registryType} (${config.registryRepo})`);
  console.log(`  ${BOLD}DNS:${NC}        ${config.dnsProvider}`);
  console.log(`  ${BOLD}Overwatch:${NC}  https://${config.overwatchDomain}`);
  console.log(`  ${BOLD}Backup:${NC}     ${config.backupEnabled ? `Enabled (${config.backupSchedule})` : 'Disabled'}`);
  console.log('');
  console.log(`  ${DIM}Files to generate:${NC}`);
  console.log(`    ${config.deployDir}/infrastructure/docker-compose.yml`);
  console.log(`    ${config.deployDir}/infrastructure/.env`);
  console.log(`    ${config.deployDir}/overwatch/docker-compose.yml`);
  console.log(`    ${config.deployDir}/overwatch/overwatch.yaml`);
  console.log(`    ${config.deployDir}/overwatch/.env`);
  console.log(`    ${config.deployDir}/overwatch/data/*.json`);
  console.log('');

  const { confirmed } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirmed',
    message: 'Proceed with setup?',
    default: true,
  }]);

  return confirmed;
}

// ─── Template: infrastructure/docker-compose.yml ────────────────────────────────

function generateInfraCompose(c: InitConfig): string {
  const dnsEnvLines = c.dnsEnvVars
    .map(v => `      ${v.name}: "\${${v.name}}"`)
    .join('\n');

  const isMariadb = c.dbType === 'mariadb';

  const dbService = isMariadb
    ? `  mariadb:
    image: mariadb:11
    container_name: ${c.projectPrefix}-mariadb
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: "\${MYSQL_ROOT_PASSWORD}"
    volumes:
      - mariadb-data:/var/lib/mysql
    networks:
      - ${c.projectPrefix}-network
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 30s
      timeout: 10s
      retries: 3`
    : `  postgres:
    image: postgres:16
    container_name: ${c.projectPrefix}-postgres
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: "\${POSTGRES_PASSWORD}"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - ${c.projectPrefix}-network
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 30s
      timeout: 10s
      retries: 3`;

  const dbVolume = isMariadb ? '  mariadb-data:' : '  postgres-data:';

  return `services:
  traefik:
    image: traefik:v3.3
    container_name: ${c.projectPrefix}-traefik
    restart: unless-stopped
    command:
      - "--api.dashboard=false"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--providers.docker.network=${c.projectPrefix}-network"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.web.http.redirections.entrypoint.to=websecure"
      - "--entrypoints.websecure.address=:443"
      # Wildcard SSL via DNS challenge
      - "--certificatesresolvers.letsencrypt.acme.dnschallenge=true"
      - "--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=${c.dnsProvider}"
      - "--certificatesresolvers.letsencrypt.acme.email=${c.adminEmail}"
      - "--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
      # HTTP challenge for custom tenant domains
      - "--certificatesresolvers.letsencrypt-http.acme.httpchallenge=true"
      - "--certificatesresolvers.letsencrypt-http.acme.httpchallenge.entrypoint=web"
      - "--certificatesresolvers.letsencrypt-http.acme.email=${c.adminEmail}"
      - "--certificatesresolvers.letsencrypt-http.acme.storage=/letsencrypt/acme.json"
    environment:
${dnsEnvLines}
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - letsencrypt:/letsencrypt
    networks:
      - ${c.projectPrefix}-network

${dbService}

networks:
  ${c.projectPrefix}-network:
    name: ${c.projectPrefix}-network

volumes:
  letsencrypt:
${dbVolume}
`;
}

// ─── Template: infrastructure/.env ──────────────────────────────────────────────

function generateInfraEnv(c: InitConfig): string {
  const lines: string[] = ['# Infrastructure environment variables', ''];

  // Database password
  if (c.dbType === 'mariadb') {
    lines.push('# MariaDB root password');
    lines.push(`MYSQL_ROOT_PASSWORD=${c.dbPassword}`);
  } else {
    lines.push('# PostgreSQL password');
    lines.push(`POSTGRES_PASSWORD=${c.dbPassword}`);
  }
  lines.push('');

  // DNS provider credentials
  lines.push('# DNS provider credentials (for Traefik SSL)');
  for (const v of c.dnsEnvVars) {
    lines.push(`${v.name}=${v.value}`);
  }
  lines.push('');

  return lines.join('\n');
}

// ─── Template: overwatch/overwatch.yaml ─────────────────────────────────────────

function generateOverwatchYaml(c: InitConfig): string {
  const isMariadb = c.dbType === 'mariadb';
  const dbPasswordEnv = isMariadb ? 'MYSQL_ROOT_PASSWORD' : 'POSTGRES_PASSWORD';
  const dbHost = isMariadb ? `${c.projectPrefix}-mariadb` : `${c.projectPrefix}-postgres`;
  const dbPort = isMariadb ? 3306 : 5432;
  const dbUser = isMariadb ? 'root' : 'postgres';
  const dbContainerName = dbHost;

  // Registry auth block
  const authLines: string[] = [];
  authLines.push(`    type: "${c.registryAuthType}"`);
  for (const ev of c.registryEnvVars) {
    authLines.push(`    ${ev.configKey}: "${ev.envName}"`);
  }

  // Backup block
  let backupBlock = '';
  if (c.backupEnabled) {
    backupBlock = `
backup:
  enabled: true
  schedule: "${c.backupSchedule}"
  provider: "s3"
  s3:
    endpoint_env: "S3_ENDPOINT"
    bucket_env: "S3_BUCKET"
    access_key_env: "S3_ACCESS_KEY"
    secret_key_env: "S3_SECRET_KEY"
  restic_password_env: "RESTIC_PASSWORD"
`;
  }

  return `project:
  name: "${c.projectName}"
  prefix: "${c.projectPrefix}"
  db_prefix: "${c.projectPrefix}"

database:
  type: "${c.dbType}"
  host: "${dbHost}"
  port: ${dbPort}
  root_user: "${dbUser}"
  root_password_env: "${dbPasswordEnv}"
  container_name: "${dbContainerName}"

registry:
  type: "${c.registryType}"
  url: "${c.registryUrl}"
  repository: "${c.registryRepo}"
  auth:
${authLines.join('\n')}

services:
  - name: "backend"
    required: true
    image_suffix: "backend"
    backup:
      enabled: true
      paths:
        - container: "/app/uploads"
          local: "uploads"

  - name: "frontend"
    required: true
    image_suffix: "frontend"

  - name: "migrator"
    is_init_container: true
    image_suffix: "backend"
${backupBlock}
admin_access:
  enabled: true
  url_template: "https://\${domain}/admin-login?token=\${token}"

credentials:
  db_password_length: 32
  jwt_secret_length: 64

networking:
  external_network: "${c.projectPrefix}-network"
  tenants_path: "/app/tenants"
`;
}

// ─── Template: overwatch/docker-compose.yml ─────────────────────────────────────

function generateOverwatchCompose(c: InitConfig): string {
  return `services:
  overwatch:
    image: ghcr.io/marwain91/overwatch:latest
    container_name: ${c.projectPrefix}-overwatch
    restart: unless-stopped
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /root/.docker:/root/.docker:ro
      - ./overwatch.yaml:/app/overwatch.yaml:ro
      - ./data/admin-users.json:/app/data/admin-users.json
      - ./data/env-vars.json:/app/data/env-vars.json
      - ./data/tenant-env-overrides.json:/app/data/tenant-env-overrides.json
      - ./data/audit.log:/app/data/audit.log
      - ../tenants:/app/tenants
      - ../tenant-template:/app/tenant-template:ro
    networks:
      - ${c.projectPrefix}-network
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.overwatch.rule=Host(\`${c.overwatchDomain}\`)"
      - "traefik.http.routers.overwatch.entrypoints=websecure"
      - "traefik.http.routers.overwatch.tls=true"
      - "traefik.http.routers.overwatch.tls.certresolver=letsencrypt"
      - "traefik.http.services.overwatch.loadbalancer.server.port=3002"
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3002/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 512M

networks:
  ${c.projectPrefix}-network:
    external: true
`;
}

// ─── Template: overwatch/.env ───────────────────────────────────────────────────

function generateOverwatchEnv(c: InitConfig): string {
  const lines: string[] = ['# Overwatch environment variables', '# Generated by overwatch init', ''];

  // Core
  lines.push('# Core');
  lines.push(`JWT_SECRET=${c.jwtSecret}`);
  lines.push(`GOOGLE_CLIENT_ID=${c.googleClientId}`);
  lines.push('');

  // Database
  lines.push('# Database');
  if (c.dbType === 'mariadb') {
    lines.push(`MYSQL_ROOT_PASSWORD=${c.dbPassword}`);
  } else {
    lines.push(`POSTGRES_PASSWORD=${c.dbPassword}`);
  }
  lines.push('');

  // Registry
  lines.push('# Container Registry');
  for (const ev of c.registryEnvVars) {
    lines.push(`${ev.envName}=${ev.value}`);
  }
  lines.push('');

  // Admin
  lines.push('# Admin access');
  lines.push(`ALLOWED_ADMIN_EMAILS=${c.allowedAdminEmails}`);
  lines.push('');

  // Backup
  if (c.backupEnabled) {
    lines.push('# Backup (S3-compatible storage)');
    lines.push(`S3_ENDPOINT=${c.s3Endpoint}`);
    lines.push(`S3_BUCKET=${c.s3Bucket}`);
    lines.push(`S3_ACCESS_KEY=${c.s3AccessKey}`);
    lines.push(`S3_SECRET_KEY=${c.s3SecretKey}`);
    lines.push(`RESTIC_PASSWORD=${c.resticPassword}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── File Generation ────────────────────────────────────────────────────────────

async function generateFiles(config: InitConfig): Promise<void> {
  header('Generating Files');

  const base = config.deployDir;

  // Create directories
  const dirs = [
    path.join(base, 'infrastructure'),
    path.join(base, 'overwatch', 'data'),
    path.join(base, 'tenants'),
    path.join(base, 'tenant-template'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  success('Created directory structure');

  // Infrastructure
  await writeFileSafe(
    path.join(base, 'infrastructure', 'docker-compose.yml'),
    generateInfraCompose(config),
  );
  await writeFileSafe(
    path.join(base, 'infrastructure', '.env'),
    generateInfraEnv(config),
  );

  // Overwatch
  await writeFileSafe(
    path.join(base, 'overwatch', 'docker-compose.yml'),
    generateOverwatchCompose(config),
  );
  await writeFileSafe(
    path.join(base, 'overwatch', 'overwatch.yaml'),
    generateOverwatchYaml(config),
  );
  await writeFileSafe(
    path.join(base, 'overwatch', '.env'),
    generateOverwatchEnv(config),
  );

  // Data files
  await writeFileSafe(
    path.join(base, 'overwatch', 'data', 'admin-users.json'),
    '[]\n',
  );
  await writeFileSafe(
    path.join(base, 'overwatch', 'data', 'env-vars.json'),
    '[]\n',
  );
  await writeFileSafe(
    path.join(base, 'overwatch', 'data', 'tenant-env-overrides.json'),
    '[]\n',
  );

  // Create audit.log if it doesn't exist
  const auditPath = path.join(base, 'overwatch', 'data', 'audit.log');
  if (!fs.existsSync(auditPath)) {
    fs.writeFileSync(auditPath, '', 'utf-8');
    success('Created audit.log');
  }

  console.log('');
  info('Add your tenant template to:');
  info(`  ${path.join(base, 'tenant-template', 'docker-compose.yml')}`);
}

// ─── Start Services ─────────────────────────────────────────────────────────────

async function startServices(config: InitConfig): Promise<void> {
  header('Starting Services');

  const base = config.deployDir;
  const network = `${config.projectPrefix}-network`;

  try {
    // Create network
    info('Creating Docker network...');
    execSync(`docker network create ${network} 2>/dev/null || true`, { stdio: 'pipe' });
    success(`Network ${network} ready`);

    // Start infrastructure
    info('Starting infrastructure (Traefik + database)...');
    execSync(`docker compose -f ${path.join(base, 'infrastructure', 'docker-compose.yml')} up -d`, {
      stdio: 'inherit',
      cwd: base,
    });
    success('Infrastructure started');

    // Wait for database
    info('Waiting for database to be healthy...');
    const dbContainer = config.dbType === 'mariadb'
      ? `${config.projectPrefix}-mariadb`
      : `${config.projectPrefix}-postgres`;

    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const status = execSync(
          `docker inspect --format='{{.State.Health.Status}}' ${dbContainer}`,
          { stdio: 'pipe' },
        ).toString().trim();
        if (status === 'healthy') {
          healthy = true;
          break;
        }
      } catch {
        // container not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    if (healthy) {
      success('Database is healthy');
    } else {
      warn('Database health check timed out — starting Overwatch anyway');
    }

    // Start Overwatch
    info('Starting Overwatch...');
    execSync(`docker compose -f ${path.join(base, 'overwatch', 'docker-compose.yml')} up -d`, {
      stdio: 'inherit',
      cwd: base,
    });
    success('Overwatch started');

    console.log('');
    console.log(`  ${GREEN}${BOLD}Overwatch is running at https://${config.overwatchDomain}${NC}`);
    console.log('');
    info('It may take a minute for SSL certificates to be issued.');
    info(`Log in with one of: ${config.allowedAdminEmails}`);
    console.log('');
  } catch (error: any) {
    fail(`Failed to start services: ${error.message}`);
    console.log('');
    showNextSteps(config);
  }
}

// ─── Next Steps ─────────────────────────────────────────────────────────────────

function showNextSteps(config: InitConfig): void {
  const base = config.deployDir;
  const network = `${config.projectPrefix}-network`;

  header('Next Steps');

  console.log('  Start the services manually:');
  console.log('');
  console.log(`    ${DIM}# 1. Create the shared network${NC}`);
  console.log(`    docker network create ${network}`);
  console.log('');
  console.log(`    ${DIM}# 2. Start infrastructure${NC}`);
  console.log(`    docker compose -f ${base}/infrastructure/docker-compose.yml up -d`);
  console.log('');
  console.log(`    ${DIM}# 3. Wait for database, then start Overwatch${NC}`);
  console.log(`    docker compose -f ${base}/overwatch/docker-compose.yml up -d`);
  console.log('');
  console.log(`  Then open ${BOLD}https://${config.overwatchDomain}${NC}`);
  console.log('');
}

// ─── Main ───────────────────────────────────────────────────────────────────────

export async function runInit(): Promise<void> {
  console.log('');
  console.log(`${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}`);
  console.log(`${BOLD}${CYAN}║          Overwatch — Project Setup           ║${NC}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}`);
  console.log('');
  console.log('  Set up a complete Overwatch deployment for managing');
  console.log('  multi-tenant containerized applications.');
  console.log('');

  await checkPrerequisites();

  const basics = await collectProjectBasics();
  const db = await collectDatabase();
  const registry = await collectRegistry();
  const ssl = await collectSsl(basics.domain);
  const access = await collectAccess(basics.domain);
  const backup = await collectBackup();

  const config: InitConfig = { ...basics, ...db, ...registry, ...ssl, ...access, ...backup };

  const confirmed = await showSummary(config);
  if (!confirmed) {
    console.log(`\n${YELLOW}Setup cancelled.${NC}\n`);
    return;
  }

  await generateFiles(config);

  const { startNow } = await inquirer.prompt([{
    type: 'confirm',
    name: 'startNow',
    message: 'Start services now?',
    default: false,
  }]);

  if (startNow) {
    await startServices(config);
  } else {
    showNextSteps(config);
  }
}
