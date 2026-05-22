import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;
let deployDir: string;
let dockerLog: string;
let fakeBinDir: string;
let preloadPath: string;

const cliEntry = path.resolve(__dirname, '..', 'cli.ts');

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const raw = spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      DEPLOY_DIR: deployDir,
      OVERWATCH_CONFIG: path.join(deployDir, 'overwatch', 'overwatch.yaml'),
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH || ''}`,
      OVERWATCH_DOCKER_LOG: dockerLog,
      ...extraEnv,
    },
  });
  return { ...raw, stdout: stripAnsi(raw.stdout ?? ''), stderr: stripAnsi(raw.stderr ?? '') };
}

async function readDockerLog(): Promise<string> {
  try {
    return await fs.readFile(dockerLog, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-cli-help-'));
  deployDir = path.join(tmpRoot, 'deploy');
  fakeBinDir = path.join(tmpRoot, 'bin');
  dockerLog = path.join(tmpRoot, 'docker.log');
  preloadPath = path.join(tmpRoot, 'block-https.cjs');

  await fs.mkdir(path.join(deployDir, 'infrastructure'), { recursive: true });
  await fs.mkdir(path.join(deployDir, 'overwatch'), { recursive: true });
  await fs.mkdir(fakeBinDir, { recursive: true });
  await fs.writeFile(path.join(deployDir, 'overwatch', 'overwatch.yaml'), 'project:\n  prefix: test\n');
  await fs.writeFile(path.join(deployDir, 'overwatch', 'docker-compose.yml'), `
services:
  overwatch:
    image: ghcr.io/marwain91/overwatch:1.2.3
`);
  await fs.writeFile(path.join(fakeBinDir, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$OVERWATCH_DOCKER_LOG"
exit 43
`);
  await fs.chmod(path.join(fakeBinDir, 'docker'), 0o755);
  await fs.writeFile(preloadPath, `
const https = require('https');
https.get = () => {
  throw new Error('unexpected HTTPS request');
};
`);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('overwatch CLI help', () => {
  it('prints update help without pulling images', async () => {
    const proc = runCli(['update', '--help']);

    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('Usage: overwatch update');
    expect(proc.stdout).toContain('--self-update');
    expect(proc.stdout).not.toContain('Pulling');
    expect(proc.stdout).not.toContain('Checking current version');
    expect(await readDockerLog()).toBe('');
  });

  it('prints self-update help without checking GitHub releases', () => {
    const proc = runCli(['self-update', '--help'], {
      NODE_OPTIONS: `--require=${preloadPath}`,
    });

    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('Usage: overwatch self-update');
    expect(proc.stdout).toContain('--check');
    expect(proc.stdout).not.toContain('Checking for updates');
    expect(proc.stderr).toBe('');
  });

  it('prints lifecycle help without invoking docker compose', async () => {
    const proc = runCli(['start', '--help']);

    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('Usage: overwatch start');
    expect(proc.stdout).not.toContain('Starting infrastructure');
    expect(await readDockerLog()).toBe('');
  });
});
