import { describe, it, expect, afterEach, vi } from 'vitest';

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
