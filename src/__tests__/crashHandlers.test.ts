import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fatalHandler } from '../utils/crashHandlers';

describe('fatalHandler', () => {
  it('logs the event name and the stack, then exits non-zero', () => {
    const log = vi.fn();
    const exit = vi.fn();
    const err = new Error('boom');
    fatalHandler('uncaughtException', { log, exit })(err);
    const out = log.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('uncaughtException');
    expect(out).toContain(err.stack!);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('describes a rejection reason that is not an Error', () => {
    const log = vi.fn();
    const exit = vi.fn();
    fatalHandler('unhandledRejection', { log, exit })({ code: 'X' });
    const out = log.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('unhandledRejection');
    expect(out).toContain("code: 'X'");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('still exits when logging itself throws', () => {
    const exit = vi.fn();
    fatalHandler('uncaughtException', { log: () => { throw new Error('EPIPE'); }, exit })(new Error('boom'));
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('installCrashHandlers in a real process', () => {
  const root = path.join(__dirname, '..', '..');
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs');

  async function run(body: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-crash-'));
    const script = path.join(dir, 'crash.ts');
    const mod = path.join(root, 'src', 'utils', 'crashHandlers.ts');
    await fs.writeFile(script, `import { installCrashHandlers } from ${JSON.stringify(mod)};\ninstallCrashHandlers();\n${body}\n`);
    try {
      return spawnSync(process.execPath, ['--import', tsx, script], { encoding: 'utf8', timeout: 15_000 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it('an uncaught exception is logged with its event and stack and exits 1', async () => {
    const r = await run("setTimeout(() => { throw new Error('kaboom-sync'); }, 0);");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[fatal] uncaughtException');
    expect(r.stderr).toContain('kaboom-sync');
    expect(r.stderr).toMatch(/at .*crash\.ts/);
  });

  it('an unhandled rejection is logged with its event and exits 1', async () => {
    const r = await run("Promise.reject(new Error('kaboom-async'));");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[fatal] unhandledRejection');
    expect(r.stderr).toContain('kaboom-async');
  });
});
