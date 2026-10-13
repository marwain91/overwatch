import { describe, it, expect, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../services/app');
  vi.doUnmock('../services/docker');
});

describe('startDockerEventListener', () => {
  it('retries instead of leaving an unhandled rejection when listing apps fails', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const listApps = vi.fn()
      .mockRejectedValueOnce(new Error('apps.d file caught mid-write'))
      .mockResolvedValue([]);
    const getEvents = vi.fn();
    vi.doMock('../services/app', () => ({ listApps }));
    vi.doMock('../services/docker', () => ({
      docker: { getEvents },
      getManagedContainerNamePattern: () => /^$/,
    }));

    const { startDockerEventListener, stopDockerEventListener } = await import('../services/dockerEvents');
    startDockerEventListener();
    await vi.advanceTimersByTimeAsync(5000);

    expect(listApps).toHaveBeenCalledTimes(2);
    expect(getEvents).toHaveBeenCalledTimes(1);
    stopDockerEventListener();
  });
});

function ev(name: string, action = 'die', labels: Record<string, string> = {}) {
  return JSON.stringify({
    Action: action,
    time: 1700000000,
    Actor: { ID: 'abcdef1234567890', Attributes: { name, ...labels } },
  });
}

async function setup(apps: Array<{ id: string }> = [{ id: 'finalio' }]) {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const streams: PassThrough[] = [];
  const getEvents = vi.fn((_opts: unknown, cb: (e: Error | null, s?: PassThrough) => void) => {
    const s = new PassThrough();
    streams.push(s);
    cb(null, s);
  });
  const listApps = vi.fn(async () => apps);
  vi.doMock('../services/app', () => ({ listApps }));
  vi.doMock('../services/docker', () => ({
    docker: { getEvents },
    getManagedContainerNamePattern: (ids: string[]) => new RegExp(`^/?(${ids.join('|')})-[a-z0-9-]+-[a-z0-9-]+(?:-\\d+)?$`),
  }));
  const { eventBus } = await import('../services/eventBus');
  const seen: any[] = [];
  const listener = (e: any) => seen.push(e);
  eventBus.on('container:event', listener);
  const mod = await import('../services/dockerEvents');
  mod.startDockerEventListener();
  await vi.advanceTimersByTimeAsync(0);
  return { mod, streams, seen, listApps, getEvents, off: () => eventBus.off('container:event', listener) };
}

describe('docker event stream framing', () => {
  it('reassembles an event split across chunks and parses several events in one chunk', async () => {
    const { mod, streams, seen, off } = await setup();
    const a = ev('finalio-t1-web');
    const b = ev('finalio-t2-web', 'start');
    streams[0].write(a.slice(0, 20));
    streams[0].write(a.slice(20) + '\n' + b + '\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.map(e => [e.containerName, e.action])).toEqual([
      ['finalio-t1-web', 'die'],
      ['finalio-t2-web', 'start'],
    ]);
    off();
    mod.stopDockerEventListener();
  });

  it('keeps an incomplete trailing line until its newline arrives', async () => {
    const { mod, streams, seen, off } = await setup();
    streams[0].write(ev('finalio-t1-web'));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(0);
    streams[0].write('\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    off();
    mod.stopDockerEventListener();
  });
});

describe('docker event acceptance', () => {
  it('accepts the managed label even when the name does not match the pattern, and falls back to the pattern', async () => {
    const { mod, streams, seen, off } = await setup();
    streams[0].write(ev('customer-portal-t1-web-api', 'die', { 'com.overwatch.managed': 'true' }) + '\n');
    streams[0].write(ev('finalio-t1-web') + '\n');
    streams[0].write(ev('postgres-unrelated') + '\n');
    streams[0].write(ev('other-t1-web', 'die', { 'com.overwatch.managed': 'false' }) + '\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.map(e => e.containerName)).toEqual(['customer-portal-t1-web-api', 'finalio-t1-web']);
    off();
    mod.stopDockerEventListener();
  });

  it('rebuilds the fallback pattern from a fresh app list at most every 60s and on reconnect', async () => {
    const { mod, streams, seen, listApps, off } = await setup();
    expect(listApps).toHaveBeenCalledTimes(1);

    listApps.mockResolvedValue([{ id: 'newapp' }] as any);
    streams[0].write(ev('newapp-t1-web') + '\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(listApps).toHaveBeenCalledTimes(1); // inside the 60s window
    expect(seen).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(61_000);
    streams[0].write(ev('newapp-t1-web') + '\n');
    await vi.advanceTimersByTimeAsync(0);
    streams[0].write(ev('newapp-t1-web') + '\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(listApps).toHaveBeenCalledTimes(2); // refreshed once, not per event
    expect(seen).toHaveLength(2);

    streams[0].end();
    await vi.advanceTimersByTimeAsync(5000);
    expect(listApps).toHaveBeenCalledTimes(3); // reconnect re-lists apps
    off();
    mod.stopDockerEventListener();
  });
});
