import { describe, it, expect, afterEach } from 'vitest';

import { isValidWebhookUrl } from '../routes/monitoring';

const prev = process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK;
afterEach(() => {
  if (prev === undefined) delete process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK;
  else process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK = prev;
});

describe('v1.3.18 isValidWebhookUrl — SSRF blocklist', () => {
  it('accepts ordinary public https URLs', () => {
    expect(isValidWebhookUrl('https://hooks.slack.com/services/XXX')).toBeNull();
    expect(isValidWebhookUrl('http://example.com/webhook')).toBeNull();
  });

  it('rejects non-http(s) schemes', () => {
    expect(isValidWebhookUrl('file:///etc/passwd')).toMatch(/http/i);
    expect(isValidWebhookUrl('gopher://internal/')).toMatch(/http/i);
  });

  it('rejects loopback', () => {
    expect(isValidWebhookUrl('http://localhost/x')).toMatch(/localhost/i);
    expect(isValidWebhookUrl('http://127.0.0.1/x')).toMatch(/loopback/i);
    expect(isValidWebhookUrl('http://127.5.6.7/x')).toMatch(/loopback/i);
    expect(isValidWebhookUrl('http://[::1]/x')).toMatch(/IPv6 loopback/i);
  });

  it('rejects cloud metadata endpoint', () => {
    expect(isValidWebhookUrl('http://169.254.169.254/latest/meta-data/'))
      .toMatch(/link-local|metadata/i);
  });

  it('rejects RFC1918 private ranges', () => {
    expect(isValidWebhookUrl('http://10.0.0.1/')).toMatch(/10\/8/);
    expect(isValidWebhookUrl('http://172.16.5.5/')).toMatch(/172\.16/);
    expect(isValidWebhookUrl('http://172.31.255.255/')).toMatch(/172\.16/);
    expect(isValidWebhookUrl('http://192.168.1.1/')).toMatch(/192\.168/);
  });

  it('allows borderline 172 ranges that are public', () => {
    expect(isValidWebhookUrl('http://172.15.0.1/')).toBeNull();
    expect(isValidWebhookUrl('http://172.32.0.1/')).toBeNull();
  });

  it('rejects IPv6 link-local and unique-local', () => {
    expect(isValidWebhookUrl('http://[fe80::1]/')).toMatch(/link-local/i);
    expect(isValidWebhookUrl('http://[fc00::1]/')).toMatch(/unique-local/i);
    expect(isValidWebhookUrl('http://[fd12:3456::1]/')).toMatch(/unique-local/i);
  });

  it('rejects multicast and 0.0.0.0', () => {
    expect(isValidWebhookUrl('http://224.0.0.1/')).toMatch(/multicast|reserved/i);
    // 0.0.0.0 is caught by the explicit loopback/wildcard branch — any refusal is fine.
    expect(isValidWebhookUrl('http://0.0.0.0/')).not.toBeNull();
  });

  it('OVERWATCH_ALLOW_PRIVATE_WEBHOOK=1 reinstates private targets (on-prem collector case)', () => {
    process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK = '1';
    expect(isValidWebhookUrl('http://10.0.0.1/internal')).toBeNull();
    // Scheme guard still applies even with the escape hatch.
    expect(isValidWebhookUrl('file:///etc/passwd')).toMatch(/http/i);
  });

  it('rejects invalid URLs', () => {
    expect(isValidWebhookUrl('not a url')).toMatch(/invalid/i);
    expect(isValidWebhookUrl('')).toMatch(/invalid/i);
  });
});
