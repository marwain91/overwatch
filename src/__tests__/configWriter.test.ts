import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { writeOverwatchConfig, updateOverwatchConfig } from '../config/writer';
import { loadConfig, clearConfigCache } from '../config/loader';
import { ConfigValidationError } from '../config/writer';

// fs/promises exports cannot be spied on; route `open` through a switchable override.
const fsOverride = vi.hoisted(() => ({ open: null as null | ((...a: any[]) => Promise<any>) }));
vi.mock('fs/promises', async (orig) => {
  const actual = await orig<typeof import('fs/promises')>();
  const open = (...a: any[]) => (fsOverride.open ? fsOverride.open(...a) : (actual.open as any)(...a));
  return { ...actual, open, default: { ...actual, open } };
});

let tmpRoot: string;
let configPath: string;
let dataDir: string;

const BASE = {
  project: { name: 'Acme', prefix: 'acme', db_prefix: 'acme' },
  database: { type: 'mariadb', host: 'db', port: 3306, container_name: 'db', root_user_env: 'DB_ROOT_USER', root_password_env: 'DB_ROOT_PW' },
};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-writer-'));
  dataDir = path.join(tmpRoot, 'data');
  configPath = path.join(tmpRoot, 'overwatch.yaml');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(configPath, yaml.dump({ ...BASE, data_dir: dataDir }));
  process.env.OVERWATCH_CONFIG = configPath;
  clearConfigCache();
});

afterEach(async () => {
  delete process.env.OVERWATCH_CONFIG;
  clearConfigCache();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('writeOverwatchConfig', () => {
  it('keeps the inode of the target file (single-file bind mount safe)', async () => {
    const before = fsSync.statSync(configPath).ino;
    await writeOverwatchConfig({ ...BASE, data_dir: dataDir, project: { ...BASE.project, name: 'Renamed' } });
    expect(fsSync.statSync(configPath).ino).toBe(before);
    expect(yaml.load(fsSync.readFileSync(configPath, 'utf-8')) as any).toMatchObject({ project: { name: 'Renamed' } });
  });

  it('refuses an invalid config without touching the file', async () => {
    const original = fsSync.readFileSync(configPath, 'utf-8');
    await expect(writeOverwatchConfig({ project: { name: 'x' } })).rejects.toThrow(/invalid/i);
    expect(fsSync.readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('clears the config cache so the next load sees the new values', async () => {
    expect(loadConfig().project.name).toBe('Acme');
    await writeOverwatchConfig({ ...BASE, data_dir: dataDir, project: { ...BASE.project, name: 'Fresh' } });
    expect(loadConfig().project.name).toBe('Fresh');
  });

  it('leaves no scratch files behind', async () => {
    await writeOverwatchConfig({ ...BASE, data_dir: dataDir });
    const scratch = path.join(dataDir, '.config-tmp');
    const left = fsSync.existsSync(scratch) ? fsSync.readdirSync(scratch) : [];
    expect(left).toEqual([]);
  });

  it('serialises concurrent read-modify-write callers', async () => {
    const n = 8;
    await Promise.all(Array.from({ length: n }, (_, i) =>
      updateOverwatchConfig(raw => {
        raw.project.name = `${raw.project.name}-${i}`;
      }),
    ));
    const name = (yaml.load(fsSync.readFileSync(configPath, 'utf-8')) as any).project.name as string;
    // Every update applied on top of the previous one: no lost writes.
    expect(name.split('-').length).toBe(n + 1);
  });
});

describe('writer edge cases', () => {
  it('does not rewrite the file when the mutation changes nothing', async () => {
    const withComment = `# keep me\n${yaml.dump({ ...BASE, data_dir: dataDir })}`;
    await fs.writeFile(configPath, withComment);
    await updateOverwatchConfig(() => {});
    expect(fsSync.readFileSync(configPath, 'utf-8')).toBe(withComment);
  });

  it('still rewrites when the mutation changes something', async () => {
    await updateOverwatchConfig(raw => { raw.project.name = 'Changed'; });
    expect((yaml.load(fsSync.readFileSync(configPath, 'utf-8')) as any).project.name).toBe('Changed');
  });

  it('exposes per-field issues on a validation failure', async () => {
    const err = await writeOverwatchConfig({ project: { name: 'x' } }).catch(e => e);
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect((err as ConfigValidationError).issues.length).toBeGreaterThan(0);
    expect((err as ConfigValidationError).issues[0]).toEqual({ path: expect.any(String), message: expect.any(String) });
  });

  it('logs a failed post-copy fsync at debug level instead of swallowing it silently', async () => {
    const realOpen = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).open;
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    fsOverride.open = async (p: any, flags: any, mode: any) => {
      if (String(p) === configPath && flags === 'r+') throw Object.assign(new Error('EPERM nope'), { code: 'EPERM' });
      return realOpen(p, flags, mode);
    };
    try {
      await writeOverwatchConfig({ ...BASE, data_dir: dataDir, project: { ...BASE.project, name: 'Fsync' } });
    } finally {
      fsOverride.open = null;
    }
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('[config-writer]'));
    debug.mockRestore();
    expect((yaml.load(fsSync.readFileSync(configPath, 'utf-8')) as any).project.name).toBe('Fsync');
  });
});
