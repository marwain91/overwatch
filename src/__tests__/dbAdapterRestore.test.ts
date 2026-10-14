import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});
vi.mock('pg', () => ({ Pool: class { on() {} end = vi.fn(async () => {}); } }));
vi.mock('mysql2/promise', () => ({ default: { createPool: vi.fn(() => ({ end: vi.fn(async () => {}) })) } }));

import { MySQLAdapter } from '../adapters/database/mysql';
import { PostgresAdapter } from '../adapters/database/postgres';
import type { DatabaseAdapterConfig } from '../adapters/database/types';

let tmpDir: string;
let sqlFile: string;

function cfg(type: 'mariadb' | 'postgres'): DatabaseAdapterConfig {
  return { type, host: 'db', port: 1, rootUser: 'root', rootPassword: 'x', containerName: 'dbc', dbPrefix: 'p' };
}

/** A client process that writes `stderr` and exits with `code`. */
function failingProc(stderr: string, code: number) {
  const proc: any = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  setImmediate(() => { proc.stderr.write(stderr); proc.stderr.end(); setImmediate(() => proc.emit('close', code)); });
  return proc;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-restore-'));
  sqlFile = path.join(tmpDir, 'in.sql');
  await fs.writeFile(sqlFile, 'select 1;');
  spawnMock.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe.each([
  ['mysql', () => new MySQLAdapter(cfg('mariadb'))],
  ['postgres', () => new PostgresAdapter(cfg('postgres'))],
] as const)('%s restoreDatabase failure message', (_name, make) => {
  it('keeps only the last 2 KB of stderr', async () => {
    const noise = 'NOISE-LINE\n'.repeat(5000);
    spawnMock.mockImplementation(() => failingProc(`${noise}FATAL: the real reason`, 1));
    const err = (await make().restoreDatabase('t1', sqlFile).then(() => null, (e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('FATAL: the real reason');
    expect(err.message.length).toBeLessThan(2048 + 200);
  });

  it('passes a short stderr through unchanged', async () => {
    spawnMock.mockImplementation(() => failingProc('ERROR 1045: access denied', 1));
    await expect(make().restoreDatabase('t1', sqlFile)).rejects.toThrow('ERROR 1045: access denied');
  });
});
