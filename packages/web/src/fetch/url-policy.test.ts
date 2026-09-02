import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeHttpUrl,
  isBlockedIp,
  normalizeHostname,
  validatePublicUrl,
} from './url-policy.js';

describe('public URL policy', () => {
  it('canonicalizes host casing, trailing dots and fragments before DNS', async () => {
    const resolveHost = vi.fn(async () => ['93.184.216.34']);
    const result = await validatePublicUrl('HTTPS://Example.COM./path?q=1#fragment', { resolveHost });

    expect(normalizeHostname(result.url.hostname)).toBe('example.com');
    expect(result.url.hash).toBe('');
    expect(result.address).toBe('93.184.216.34');
    expect(resolveHost).toHaveBeenCalledWith('example.com');
  });

  it.each([
    '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254',
    '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '::1', 'fc00::1', 'fe80::1', 'fec0::1', '2001:db8::1', '4000::1', '::ffff:127.0.0.1',
  ])('blocks non-public address %s', (address) => {
    expect(isBlockedIp(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows globally routable address %s',
    (address) => expect(isBlockedIp(address)).toBe(false),
  );

  it('fails closed when any DNS answer is private', async () => {
    await expect(validatePublicUrl('https://example.com', {
      resolveHost: async () => ['93.184.216.34', '127.0.0.1'],
    })).rejects.toMatchObject({ kind: 'web_ssrf_blocked' });
  });

  it('fails closed when a resolver mixes a public and malformed address', async () => {
    await expect(validatePublicUrl('https://example.com', {
      resolveHost: async () => ['93.184.216.34', 'not-an-ip'],
    })).rejects.toMatchObject({ kind: 'web_dns_check_failed' });
  });

  it('maps resolver failures to a generic error without retaining hostname details', async () => {
    const caught = await validatePublicUrl('https://secret-subdomain.example/path?token=value', {
      resolveHost: async () => { throw new Error('ENOTFOUND secret-subdomain.example'); },
    }).catch((error: unknown) => error);
    expect(caught).toMatchObject({ kind: 'web_dns_check_failed' });
    expect(String(caught)).not.toContain('secret-subdomain');
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it.each([
    'file:///etc/passwd',
    'https://user:password@example.com/',
    'https://localhost/',
    'https://metadata.google.internal/',
    'https://example.com/a path',
  ])('rejects dangerous URL %s', async (url) => {
    await expect(validatePublicUrl(url, { resolveHost: async () => ['93.184.216.34'] }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^web_/u) });
  });

  it('enforces allow and block domains after hostname normalization', async () => {
    const resolveHost = async (): Promise<readonly string[]> => ['93.184.216.34'];
    await expect(validatePublicUrl('https://Sub.Example.COM./', {
      policy: { mode: 'configured_allowlist', allowDomains: ['example.com'], blockDomains: [] },
      resolveHost,
    })).resolves.toMatchObject({ hostname: 'sub.example.com' });
    await expect(validatePublicUrl('https://blocked.example.com/', {
      policy: { mode: 'public_anonymous', allowDomains: [], blockDomains: ['example.com'] },
      resolveHost,
    })).rejects.toMatchObject({ kind: 'web_ssrf_blocked' });
  });

  it('rejects malformed inputs before invoking DNS', async () => {
    const resolveHost = vi.fn(async () => ['93.184.216.34']);
    expect(() => canonicalizeHttpUrl(' https://example.com/has space ')).toThrow();
    await expect(validatePublicUrl('javascript:alert(1)', { resolveHost }))
      .rejects.toMatchObject({ kind: 'web_scheme_blocked' });
    expect(resolveHost).not.toHaveBeenCalled();
  });
});
