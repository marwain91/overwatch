import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Child processes inherit whatever env they are given, and the server's env
 * holds JWT_SECRET, the DB root password and registry tokens. Server code
 * starts docker through runDocker (allowlisted env, timeouts); the few other
 * spawners build their own allowlisted env. A new spawner must be reviewed
 * and added here, not slip in.
 */
const ALLOWED = new Set([
  'utils/runDocker.ts',            // the docker runner itself
  'adapters/database/base.ts',     // streaming dump/restore clients, allowlisted env
  'adapters/registry/ecr.ts',      // aws CLI, AWS_* allowlist
  'services/backup.ts',            // restic, getResticEnv allowlist
  'services/edgeDeploy.ts',        // operator-only nginx -t/reload; no shell, PATH/LANG only, bounded timeout
  // Host-side CLI: runs as the operator, not inside the server.
  'cli/config/traefik.ts',
  'cli/init.ts',
  'cli/lifecycle.ts',
  'cli/update.ts',
]);

const SRC = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'generated' ? [] : sourceFiles(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

const files = sourceFiles(SRC).map(p => ({ rel: path.relative(SRC, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf-8') }));

describe('child process boundary', () => {
  it('only reviewed modules import child_process', () => {
    const importers = files
      .filter(f => /from ['"](node:)?child_process['"]|require\(['"](node:)?child_process['"]\)/.test(f.text))
      .map(f => f.rel);
    expect(importers.filter(f => !ALLOWED.has(f))).toEqual([]);
  });

  it('no server module hands the whole process env to a child', () => {
    const spreading = files
      .filter(f => !f.rel.startsWith('cli/'))
      .filter(f => f.text.split('\n').some(line => /\.\.\.\s*process\.env\b/.test(line) && !line.trim().startsWith('//')))
      .map(f => f.rel);
    expect(spreading).toEqual([]);
  });
});
