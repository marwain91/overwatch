import { describe, it, expect, afterEach, vi } from 'vitest';

afterEach(() => { vi.resetModules(); });

describe('R4 runDocker — error classification (unit, no subprocess)', () => {
  // Avoid actually spawning `docker` — CI runners (alpine node image) don't have
  // the docker CLI and hit vitest's timeout before ENOENT propagates.
  it('SIGTERM / SIGKILL → timeout', async () => {
    const { classifyError } = await import('../utils/runDocker');
    expect(classifyError('', null, 'SIGTERM')).toBe('timeout');
    expect(classifyError('', null, 'SIGKILL')).toBe('timeout');
  });

  it('"Cannot connect to the Docker daemon" → daemon_unreachable', async () => {
    const { classifyError } = await import('../utils/runDocker');
    expect(classifyError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock.', 1, null))
      .toBe('daemon_unreachable');
  });

  it('"No such container" → unknown_container', async () => {
    const { classifyError } = await import('../utils/runDocker');
    expect(classifyError('Error: No such container: acme-daktela-web', 1, null))
      .toBe('unknown_container');
  });

  it('exit 126 / "permission denied" → permission', async () => {
    const { classifyError } = await import('../utils/runDocker');
    expect(classifyError('', 126, null)).toBe('permission');
    expect(classifyError('permission denied while trying to connect', 1, null)).toBe('permission');
  });

  it('exit 127 / "not found" → cli_missing', async () => {
    const { classifyError } = await import('../utils/runDocker');
    expect(classifyError('', 127, null)).toBe('cli_missing');
    expect(classifyError('sh: docker: not found', 127, null)).toBe('cli_missing');
  });

  it('anything else → unknown', async () => {
    const { classifyError } = await import('../utils/runDocker');
    expect(classifyError('some generic failure', 1, null)).toBe('unknown');
  });
});

