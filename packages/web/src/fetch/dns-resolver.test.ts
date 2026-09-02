import { describe, expect, it, vi } from 'vitest';
import { validatePublicUrl } from './url-policy.js';
import { CLOUDFLARE_DOH_ENDPOINT, CloudflareDohResolver } from './dns-resolver.js';

describe('explicit Cloudflare DoH resolver', () => {
  it('uses fixed POST wire-format requests, returns A/AAAA answers and honors TTL cache', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(CLOUDFLARE_DOH_ENDPOINT);
      expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
      expect(new Headers(init?.headers).get('content-type')).toBe('application/dns-message');
      expect(String(input)).not.toContain('example.com');
      const query = Buffer.from(init?.body as Uint8Array);
      const type = query.readUInt16BE(query.length - 4);
      return dnsResponse(query, type === 1
        ? [{ type: 1, ttl: 60, data: Buffer.from([93, 184, 216, 34]) }]
        : [{ type: 28, ttl: 120, data: ipv6('2606:2800:220:1:248:1893:25c8:1946') }]);
    });
    let now = 1_000;
    const resolver = new CloudflareDohResolver({ fetchFn, now: () => now });

    await expect(resolver.resolve('example.com')).resolves.toEqual([
      '93.184.216.34',
      '2606:2800:220:1:248:1893:25c8:1946',
    ]);
    await expect(resolver.resolve('example.com')).resolves.toHaveLength(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    now += 61_000;
    await resolver.resolve('example.com');
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('keeps private DoH answers subject to the same SSRF hard deny', async () => {
    const resolver = new CloudflareDohResolver({
      fetchFn: vi.fn(async (_input, init) => {
        const query = Buffer.from(init?.body as Uint8Array);
        const type = query.readUInt16BE(query.length - 4);
        return dnsResponse(query, type === 1
          ? [{ type: 1, ttl: 60, data: Buffer.from([127, 0, 0, 1]) }]
          : []);
      }),
    });

    await expect(validatePublicUrl('https://example.com/', { resolveHost: resolver.resolve }))
      .rejects.toMatchObject({ kind: 'web_ssrf_blocked' });
  });

  it('fails closed on redirects, oversized bodies and mismatched transactions', async () => {
    const redirected = new CloudflareDohResolver({
      fetchFn: vi.fn(async () => new Response(null, { status: 302 })),
    });
    await expect(redirected.resolve('example.com')).rejects.toMatchObject({ kind: 'web_dns_check_failed' });

    const oversized = new CloudflareDohResolver({
      maxResponseBytes: 4_096,
      fetchFn: vi.fn(async () => new Response(new Uint8Array(4_097), {
        headers: { 'content-type': 'application/dns-message' },
      })),
    });
    await expect(oversized.resolve('example.com')).rejects.toMatchObject({ kind: 'web_dns_check_failed' });

    const mismatched = new CloudflareDohResolver({
      fetchFn: vi.fn(async (_input, init) => {
        const query = Buffer.from(init?.body as Uint8Array);
        const response = Buffer.from(await dnsResponse(query, []).arrayBuffer());
        response.writeUInt16BE((query.readUInt16BE(0) + 1) & 0xffff, 0);
        return new Response(response, { headers: { 'content-type': 'application/dns-message' } });
      }),
    });
    await expect(mismatched.resolve('example.com')).rejects.toMatchObject({ kind: 'web_dns_check_failed' });
  });
});

interface AnswerRecord {
  readonly type: number;
  readonly ttl: number;
  readonly data: Buffer;
}

function dnsResponse(query: Buffer, answers: readonly AnswerRecord[]): Response {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  const records = answers.map((answer) => {
    const record = Buffer.alloc(12 + answer.data.length);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(answer.type, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(answer.ttl, 6);
    record.writeUInt16BE(answer.data.length, 10);
    answer.data.copy(record, 12);
    return record;
  });
  return new Response(Buffer.concat([header, query.subarray(12), ...records]), {
    headers: { 'content-type': 'application/dns-message' },
  });
}

function ipv6(address: string): Buffer {
  const groups = address.split(':').map((group) => Number.parseInt(group, 16));
  const result = Buffer.alloc(16);
  groups.forEach((group, index) => result.writeUInt16BE(group, index * 2));
  return result;
}
