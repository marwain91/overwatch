import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const runDockerMock = vi.fn();
vi.mock('../utils/runDocker', async (orig) => ({
  ...(await orig<typeof import('../utils/runDocker')>()),
  runDocker: (...a: unknown[]) => runDockerMock(...a),
}));

import { ensureExternalVolumes } from '../services/docker';

let dir = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extvol-'));
  runDockerMock.mockReset();
  runDockerMock.mockResolvedValue({ stdout: '', stderr: '' });
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

async function compose(text: string) {
  const p = path.join(dir, 'docker-compose.yml');
  await fs.writeFile(p, text);
  return p;
}

describe('ensureExternalVolumes', () => {
  it('does not create a volume named after the external network', async () => {
    const p = await compose([
      'services:', '  web:', '    image: x', '    networks:', '      - test-network',
      'networks:', '  test-network:', '    external: true', '',
    ].join('\n'));
    await ensureExternalVolumes(p);
    expect(runDockerMock).not.toHaveBeenCalled();
  });

  it('creates only the external volumes, whatever the YAML formatting', async () => {
    const p = await compose([
      'services: {}',
      'networks:', '  test-network:', '    external: true',
      'volumes:', '  shared-data:', '    external: true', '  own:', '    name: own', '',
    ].join('\n'));
    runDockerMock.mockImplementation(async (_c: string, args: string[]) => {
      if (args[1] === 'inspect') throw new Error('missing');
      return { stdout: '', stderr: '' };
    });
    await ensureExternalVolumes(p);
    const created = runDockerMock.mock.calls.filter(c => c[1][1] === 'create').map(c => c[1][2]);
    expect(created).toEqual(['shared-data']);
  });
});
