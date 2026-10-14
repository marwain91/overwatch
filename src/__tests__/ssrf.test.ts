import { describe, it, expect, afterEach, vi } from 'vitest';
import dns from 'dns';
import { isPrivateAddress, assertPublicUrl } from '../utils/ssrf';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OVERWATCH_TEST_ALLOW_PRIVATE;
});

function resolveTo(...addresses: string[]) {
  return vi.spyOn(dns.promises, 'lookup').mockResolvedValue(
    addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 })) as any,
  );
}

describe('isPrivateAddress', () => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.5.6.7',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '198.18.0.1',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', '0::1', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a00:1',
    '::7f00:1', '::127.0.0.1', '::a9fe:a9fe', '::10.0.0.1', '::ffff:0:7f00:1', '::ffff:0:127.0.0.1',
    '2002:7f00:1::', '2002:a9fe:a9fe::1', '2002:c0a8:101::', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001::1',
    '[::1]', 'fe80::1%eth0', 'not-an-ip', '',
  ];
  const allowed = [
    '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1',
    '169.253.0.1', '223.255.255.255', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::808:808', '::ffff:0:8.8.8.8', '2002:808:808::1', '2001:db9::1',
  ];
  it.each(blocked)('blocks %s', ip => expect(isPrivateAddress(ip)).toBe(true));
  it.each(allowed)('allows %s', ip => expect(isPrivateAddress(ip)).toBe(false));
});

describe('assertPublicUrl', () => {
  it('accepts a public hostname', async () => {
    resolveTo('93.184.216.34');
    await expect(assertPublicUrl('https://example.com/hook')).resolves.toEqual(['93.184.216.34']);
  });

  it('rejects a host whose AAAA record is private even when the A record is public', async () => {
    resolveTo('93.184.216.34', 'fd00::1');
    await expect(assertPublicUrl('https://rebind.example.com/')).rejects.toThrow(/private/);
  });

  it('rejects a host whose A record is private', async () => {
    resolveTo('10.0.0.5');
    await expect(assertPublicUrl('https://internal.example.com/')).rejects.toThrow(/private/);
  });

  it('rejects private IP literals without a lookup', async () => {
    const lookup = resolveTo('93.184.216.34');
    await expect(assertPublicUrl('http://169.254.169.254/latest/')).rejects.toThrow(/private/);
    await expect(assertPublicUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/private/);
    await expect(assertPublicUrl('http://[fd12::1]/')).rejects.toThrow(/private/);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects internal hostnames and non-http schemes', async () => {
    resolveTo('93.184.216.34');
    await expect(assertPublicUrl('http://localhost/x')).rejects.toThrow(/private|internal/);
    await expect(assertPublicUrl('http://metadata.google.internal/')).rejects.toThrow(/private|internal/);
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/http/);
    await expect(assertPublicUrl('not a url')).rejects.toThrow(/Invalid/);
    await expect(assertPublicUrl('')).rejects.toThrow(/Invalid/);
    await expect(assertPublicUrl('http://localhost./x')).rejects.toThrow(/private|internal/);
    await expect(assertPublicUrl('http://foo.internal./x')).rejects.toThrow(/private|internal/);
    // Every trailing dot is an absolute-name marker, not just the first.
    await expect(assertPublicUrl('http://localhost../x')).rejects.toThrow(/private|internal/);
    await expect(assertPublicUrl('http://foo.internal.../x')).rejects.toThrow(/private|internal/);
  });

  it('fails closed when the name does not resolve', async () => {
    vi.spyOn(dns.promises, 'lookup').mockRejectedValue(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
    await expect(assertPublicUrl('https://nx.example.com/')).rejects.toThrow(/resolve/);
  });

  it('honours the named opt-out env but still enforces the scheme', async () => {
    process.env.OVERWATCH_TEST_ALLOW_PRIVATE = '1';
    const opts = { allowPrivateEnv: 'OVERWATCH_TEST_ALLOW_PRIVATE' };
    resolveTo('10.0.0.5');
    await expect(assertPublicUrl('http://10.0.0.1/x', opts)).resolves.toEqual(['10.0.0.1']);
    await expect(assertPublicUrl('http://intranet.example.com/', opts)).resolves.toEqual(['10.0.0.5']);
    await expect(assertPublicUrl('file:///etc/passwd', opts)).rejects.toThrow(/http/);
    delete process.env.OVERWATCH_TEST_ALLOW_PRIVATE;
    await expect(assertPublicUrl('http://10.0.0.1/x', opts)).rejects.toThrow(/private/);
  });
});
