import { describe, it, expect, vi } from 'vitest';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({ execFile: (...a: unknown[]) => execFileMock(...a) }));

import { runDocker } from '../utils/runDocker';

function fakeChild() {
  return { on: vi.fn(), stdin: { on: vi.fn(), end: vi.fn() } };
}

describe('runDocker input', () => {
  it('writes input to stdin and closes it, so a secret never reaches argv', async () => {
    const child = fakeChild();
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: any) => { setImmediate(() => cb(null, '', '')); return child; });
    await runDocker('docker', ['login', '--password-stdin'], { input: 's3cret' });
    expect(child.stdin.end).toHaveBeenCalledWith('s3cret');
    // EPIPE when the CLI exits early must not become an unhandled 'error' event.
    expect(child.stdin.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('leaves stdin alone without input', async () => {
    const child = fakeChild();
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: any) => { setImmediate(() => cb(null, '', '')); return child; });
    await runDocker('docker', ['ps']);
    expect(child.stdin.end).not.toHaveBeenCalled();
  });
});
