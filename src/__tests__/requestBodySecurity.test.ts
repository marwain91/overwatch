import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('compressed request body handling', () => {
  it('survives trailing garbage after a compressed JSON body and continues serving requests', () => {
    // Run in a child: vulnerable body-parser versions raise an uncaught decoder
    // error after parsing, which must fail this test without killing Vitest.
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const http = require('node:http');
      const { gzipSync } = require('node:zlib');
      const express = require('express');
      const app = express();
      app.use(express.json({ limit: '1mb' }));
      app.post('/json', (req, res) => res.json(req.body));
      app.get('/health', (req, res) => res.send('ok'));
      app.use((err, req, res, next) => res.status(400).send('invalid body'));
      const server = app.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        const send = (path, body) => new Promise((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port, path,
            method: body ? 'POST' : 'GET', headers: body ? {
              'Content-Type': 'application/json', 'Content-Encoding': 'gzip',
              'Content-Length': body.length,
            } : {},
          }, res => {
            let text = '';
            res.on('data', chunk => text += chunk);
            res.on('end', () => resolve({ status: res.statusCode, text }));
          });
          req.on('error', reject);
          req.end(body);
        });
        try {
          const valid = gzipSync(Buffer.from('{"ok":true}'));
          assert.deepEqual(await send('/json', valid), { status: 200, text: '{"ok":true}' });
          await send('/json', Buffer.concat([valid, Buffer.from('trailing garbage')]));
          await new Promise(resolve => setTimeout(resolve, 100));
          assert.deepEqual(await send('/health'), { status: 200, text: 'ok' });
          server.close();
        } catch (err) {
          console.error(err);
          process.exit(1);
        }
      });
    `], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
