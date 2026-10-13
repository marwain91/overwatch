import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { HttpError, ValidationError, NotFoundError, ConflictError } from '../utils/httpErrors';
import { errorHandler } from '../middleware/errorHandler';

describe('httpErrors', () => {
  it('typed errors carry status and are exposed by default', () => {
    const cases: [HttpError, number][] = [
      [new ValidationError('v'), 400],
      [new NotFoundError('n'), 404],
      [new ConflictError('c'), 409],
    ];
    for (const [e, status] of cases) {
      expect(e).toBeInstanceOf(HttpError);
      expect(e).toBeInstanceOf(Error);
      expect(e.status).toBe(status);
      expect(e.expose).toBe(true);
    }
  });

  it('5xx HttpErrors are hidden unless they opt in', () => {
    expect(new HttpError(500, 'x').expose).toBe(false);
    expect(new HttpError(500, 'x', { expose: true }).expose).toBe(true);
  });
});

describe('errorHandler', () => {
  afterEach(() => vi.restoreAllMocks());

  function appThrowing(err: unknown) {
    const app = express();
    app.get('/boom', (_req, _res, next) => next(err));
    app.use(errorHandler);
    return app;
  }

  it('hides the message of unexpected 5xx errors but logs them', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appThrowing(new Error("ENOENT: open '/srv/overwatch/data/secret.json'"))).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(spy).toHaveBeenCalled();
  });

  it('hides non-exposed HttpError 5xx messages', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appThrowing(new HttpError(503, 'db at 10.0.0.5 down'))).get('/boom');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('passes exposed 5xx HttpError messages through', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appThrowing(new HttpError(500, 'compose failed: pull denied', { expose: true }))).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'compose failed: pull denied' });
  });

  it('maps typed 4xx errors to their status and message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [err, status] of [
      [new ValidationError('bad input'), 400],
      [new NotFoundError('missing'), 404],
      [new ConflictError('already there'), 409],
    ] as [HttpError, number][]) {
      const res = await request(appThrowing(err)).get('/boom');
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: err.message });
    }
  });

  it('honours err.status on plain errors (e.g. body-parser) and keeps 4xx messages', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const err: any = new Error('request entity too large');
    err.status = 413;
    const res = await request(appThrowing(err)).get('/boom');
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'request entity too large' });
  });

  it('falls back to 500 for a nonsensical status', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const err: any = new Error('leaky');
    err.status = 'nope';
    const res = await request(appThrowing(err)).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

describe('errorHandler: ZodError and DockerCommandError', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps a ZodError to 400 with a readable field message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { z } = await import('zod');
    const parsed = z.object({ port: z.number() }).safeParse({ port: 'x' });
    const app = express();
    app.get('/boom', (_req, _res, next) => next((parsed as any).error));
    app.use(errorHandler);
    const res = await request(app).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('port');
  });

  it('DockerCommandError carries an exposed status by kind', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { DockerCommandError } = await import('../utils/runDocker');
    const details = { stderr: '', stdout: '', exitCode: 1, command: 'docker', args: [] as string[] };
    const daemon = new DockerCommandError('Cannot connect to the Docker daemon', 'daemon_unreachable', details);
    const other = new DockerCommandError('docker start failed (unknown)', 'unknown', details);
    expect(daemon).toBeInstanceOf(HttpError);
    expect(daemon.kind).toBe('daemon_unreachable');
    for (const [err, status] of [[daemon, 503], [other, 502]] as [Error, number][]) {
      const app = express();
      app.get('/boom', (_req, _res, next) => next(err));
      app.use(errorHandler);
      const res = await request(app).get('/boom');
      expect(res.status).toBe(status);
      expect(res.body.error).toBe(err.message);
    }
  });
});
