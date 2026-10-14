import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let tmpRoot: string;
let configPath: string;
let dataDir: string;
let answers: string[];
let output: string[];

const BASE = {
  project: { name: 'Acme', prefix: 'acme', db_prefix: 'acme' },
  database: { type: 'mariadb', host: 'db', port: 3306, container_name: 'db', root_user_env: 'DB_ROOT_USER', root_password_env: 'DB_ROOT_PW' },
};

vi.mock('inquirer', () => ({
  default: {
    prompt: async (qs: any[]) => {
      const q = qs[0];
      if (q.type === 'confirm') return { [q.name]: true };
      // Answer in order; an unset entry keeps the default.
      const next = answers.shift();
      return { [q.name]: next === undefined || next === '' ? q.default : next };
    },
    Separator: class {},
  },
}));

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-cli-edit-'));
  dataDir = path.join(tmpRoot, 'data');
  configPath = path.join(tmpRoot, 'overwatch.yaml');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(configPath, yaml.dump({ ...BASE, data_dir: dataDir }));
  process.env.OVERWATCH_CONFIG = configPath;
  output = [];
  vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { output.push(a.join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  delete process.env.OVERWATCH_CONFIG;
  const { clearConfigCache } = await import('../config/loader');
  clearConfigCache();
  vi.restoreAllMocks();
  vi.resetModules();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// database fields in order: type (enum), host, port, ...
describe('overwatch config edit', () => {
  it('saves a valid change through the writer', async () => {
    answers = ['Renamed'];
    const { runConfigEdit } = await import('../cli/config/edit');
    await runConfigEdit(['project']);
    expect((yaml.load(await fs.readFile(configPath, 'utf-8')) as any).project.name).toBe('Renamed');
  });

  it('prints coloured per-field validation errors plus the fix hint, leaving the file untouched', async () => {
    const before = await fs.readFile(configPath, 'utf-8');
    answers = ['oracle'];
    const { runConfigEdit } = await import('../cli/config/edit');
    await runConfigEdit(['database']);
    expect(await fs.readFile(configPath, 'utf-8')).toBe(before);
    const text = output.join('\n');
    expect(text).toContain('Validation failed');
    expect(text).toMatch(/\x1b\[31mdatabase\.type:\x1b\[0m/);
    expect(text).toContain('Fix the values and try again');
  });

  it('does not show the fix-the-values hint for an I/O failure', async () => {
    answers = ['Renamed'];
    vi.doMock('../config/writer', async () => {
      const actual = await vi.importActual<any>('../config/writer');
      return { ...actual, writeOverwatchConfig: async () => { throw Object.assign(new Error('EACCES: cannot take lock'), { code: 'EACCES' }); } };
    });
    const { runConfigEdit } = await import('../cli/config/edit');
    await runConfigEdit(['project']);
    vi.doUnmock('../config/writer');
    const text = output.join('\n');
    expect(text).toContain('EACCES');
    expect(text).not.toContain('Fix the values');
    expect(text).toContain('not saved');
  });
});
