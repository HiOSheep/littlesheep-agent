// Resolves public hostnames through the selected system or fixed Cloudflare DoH path.
// It keeps DNS answers bounded and leaves every address subject to the shared SSRF policy.
import { randomInt } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { NetworkReadPolicy } from '@littlesheep/types';
import { webError } from '../errors.js';
import type { UrlValidationOptions } from './url-policy.js';

export const CLOUDFLARE_DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const CLOUDFLARE_DOH_ADDRESSES = ['1.1.1.1', '1.0.0.1'] as const;

export interface CloudflareDohResolverOptions {
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

interface CachedAddresses {
  readonly addresses: readonly string[];
  readonly expiresAt: number;
}

interface ParsedDnsAnswer {
  readonly addresses: readonly string[];
  readonly ttlSeconds: number;
}

interface DnsRecord {
  readonly name: string;
  readonly type: number;
  readonly ttl: number;
  readonly data?: string;
}

/** Fixed-endpoint DoH resolver for explicit Fake-IP compatibility mode. */
export class CloudflareDohResolver {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly customFetch?: typeof fetch;
  private readonly cache = new Map<string, CachedAddresses>();

  constructor(options: CloudflareDohResolverOptions = {}) {
    this.customFetch = options.fetchFn;
    this.now = options.now ?? Date.now;
    this.timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 5_000, 10_000));
    this.maxResponseBytes = Math.max(4_096, Math.min(options.maxResponseBytes ?? 64 * 1024, 256 * 1024));
  }

  readonly resolve: NonNullable<UrlValidationOptions['resolveHost']> = async (hostname, signal) => {
    const normalized = normalizeDnsName(hostname);
    const cached = this.cache.get(normalized);
    const now = this.now();
    if (cached && cached.expiresAt > now) return cached.addresses;
    if (cached) this.cache.delete(normalized);

    const [ipv4, ipv6] = await Promise.all([
      this.query(normalized, 1, signal),
      this.query(normalized, 28, signal),
    ]);
    const addresses = [...new Set([...ipv4.addresses, ...ipv6.addresses])];
    if (addresses.length === 0) {
      throw webError('web_dns_check_failed', 'trusted DNS returned no addresses', { retryable: true });
    }
    const ttlSeconds = Math.max(1, Math.min(ipv4.ttlSeconds, ipv6.ttlSeconds, 300));
    this.cache.set(normalized, {
      addresses,
      expiresAt: now + ttlSeconds * 1_000,
    });
    return addresses;
  };

  clear(): void {
    this.cache.clear();
  }

  private async query(hostname: string, queryType: 1 | 28, parentSignal?: AbortSignal): Promise<ParsedDnsAnswer> {
    const transactionId = randomInt(0, 65_536);
    const query = buildDnsQuery(hostname, queryType, transactionId);
    const timeout = linkedTimeout(parentSignal, this.timeoutMs);
    try {
      const response = this.customFetch
        ? await this.customFetch(CLOUDFLARE_DOH_ENDPOINT, {
            method: 'POST',
            headers: {
              accept: 'application/dns-message',
              'content-type': 'application/dns-message',
              'user-agent': 'LittleSheep/0.1',
            },
            body: query,
            redirect: 'error',
            signal: timeout.signal,
          })
        : await requestFixedDoh(query, timeout.signal, this.maxResponseBytes);
      if (!response.ok) {
        throw webError('web_dns_check_failed', 'trusted DNS request failed', { retryable: response.status >= 500 });
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('application/dns-message')) {
        throw webError('web_dns_check_failed', 'trusted DNS returned an unsupported response', { retryable: false });
      }
      const body = await readBoundedResponse(response, this.maxResponseBytes);
      return parseDnsResponse(body, hostname, queryType, transactionId);
    } catch (error) {
      if (parentSignal?.aborted) throw error;
      if (error && typeof error === 'object' && 'kind' in error) throw error;
      throw webError('web_dns_check_failed', 'trusted DNS resolution failed', { retryable: true });
    } finally {
      timeout.dispose();
    }
  }
}

function requestFixedDoh(body: Uint8Array, signal: AbortSignal, maxResponseBytes: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    let addressIndex = 0;
    let settled = false;
    let request: ReturnType<typeof httpsRequest> | undefined;
    const fail = (error: unknown): void => {
      if (settled) return;
      if (addressIndex < CLOUDFLARE_DOH_ADDRESSES.length - 1 && !signal.aborted) {
        addressIndex += 1;
        start();
        return;
      }
      settled = true;
      request?.destroy();
      reject(error);
    };
    const abort = (): void => {
      settled = true;
      request?.destroy();
      reject(new Error('trusted DNS request cancelled'));
    };
    const start = (): void => {
      const address = CLOUDFLARE_DOH_ADDRESSES[addressIndex]!;
      request = httpsRequest({
        protocol: 'https:',
        hostname: address,
        port: 443,
        path: '/dns-query',
        method: 'POST',
        headers: {
          host: 'cloudflare-dns.com',
          accept: 'application/dns-message',
          'content-type': 'application/dns-message',
          'content-length': body.byteLength,
          'user-agent': 'LittleSheep/0.1',
        },
        servername: 'cloudflare-dns.com',
        agent: false,
      }, (response) => {
        void readDohResponse(response, maxResponseBytes)
          .then((result) => {
            if (settled) return;
            settled = true;
            resolve(new Response(result.body, {
              status: response.statusCode ?? 0,
              headers: response.headers as Record<string, string>,
            }));
          })
          .catch(fail);
      });
      request.once('error', fail);
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      request.once('close', () => signal.removeEventListener('abort', abort));
      request.end(Buffer.from(body));
    };
    start();
  });
}

async function readDohResponse(response: IncomingMessage, maxBytes: number): Promise<{ body: Uint8Array }> {
  const contentLength = Number(response.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.resume();
    throw new Error('trusted DNS response exceeded its size limit');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      response.destroy();
      throw new Error('trusted DNS response exceeded its size limit');
    }
    chunks.push(buffer);
  }
  return { body: Buffer.concat(chunks) };
}

export function createPolicyHostResolver(
  policy: Pick<NetworkReadPolicy, 'dnsResolver' | 'fetchTimeoutMs'>,
): UrlValidationOptions['resolveHost'] {
  if ((policy.dnsResolver ?? 'system') !== 'cloudflare_doh') return undefined;
  return new CloudflareDohResolver({ timeoutMs: Math.min(policy.fetchTimeoutMs, 10_000) }).resolve;
}

function buildDnsQuery(hostname: string, queryType: 1 | 28, transactionId: number): Uint8Array {
  const labels = normalizeDnsName(hostname).split('.');
  const encodedLabels = labels.map((label) => {
    const bytes = Buffer.from(label, 'ascii');
    if (bytes.length < 1 || bytes.length > 63 || bytes.toString('ascii') !== label) {
      throw webError('web_dns_check_failed', 'DNS hostname cannot be encoded safely', { retryable: false });
    }
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  const question = Buffer.concat([...encodedLabels, Buffer.from([0, 0, queryType, 0, 1])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(transactionId, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, question]);
}

function parseDnsResponse(
  body: Uint8Array,
  hostname: string,
  queryType: 1 | 28,
  transactionId: number,
): ParsedDnsAnswer {
  const buffer = Buffer.from(body);
  if (buffer.length < 12 || buffer.readUInt16BE(0) !== transactionId) return invalidDnsResponse();
  const flags = buffer.readUInt16BE(2);
  if ((flags & 0x8000) === 0 || (flags & 0x0200) !== 0 || (flags & 0x000f) !== 0) return invalidDnsResponse();
  const questionCount = buffer.readUInt16BE(4);
  const answerCount = buffer.readUInt16BE(6);
  const authorityCount = buffer.readUInt16BE(8);
  const additionalCount = buffer.readUInt16BE(10);
  const recordCount = answerCount + authorityCount + additionalCount;
  if (questionCount !== 1 || recordCount > 512) return invalidDnsResponse();

  let offset = 12;
  const questionName = readDnsName(buffer, offset);
  offset = questionName.nextOffset;
  if (offset + 4 > buffer.length) return invalidDnsResponse();
  const responseQueryType = buffer.readUInt16BE(offset);
  const responseQueryClass = buffer.readUInt16BE(offset + 2);
  offset += 4;
  if (questionName.name !== normalizeDnsName(hostname) || responseQueryType !== queryType || responseQueryClass !== 1) {
    return invalidDnsResponse();
  }

  const records: DnsRecord[] = [];
  for (let index = 0; index < recordCount; index += 1) {
    const owner = readDnsName(buffer, offset);
    offset = owner.nextOffset;
    if (offset + 10 > buffer.length) return invalidDnsResponse();
    const type = buffer.readUInt16BE(offset);
    const recordClass = buffer.readUInt16BE(offset + 2);
    const ttl = buffer.readUInt32BE(offset + 4);
    const length = buffer.readUInt16BE(offset + 8);
    const dataOffset = offset + 10;
    const dataEnd = dataOffset + length;
    if (dataEnd > buffer.length) return invalidDnsResponse();
    if (recordClass === 1) {
      if (type === 1) {
        if (length !== 4) return invalidDnsResponse();
        records.push({ name: owner.name, type, ttl, data: [...buffer.subarray(dataOffset, dataEnd)].join('.') });
      } else if (type === 28) {
        if (length !== 16) return invalidDnsResponse();
        records.push({ name: owner.name, type, ttl, data: formatIpv6(buffer.subarray(dataOffset, dataEnd)) });
      } else if (type === 5) {
        const canonical = readDnsName(buffer, dataOffset);
        if (canonical.nextOffset > dataEnd) return invalidDnsResponse();
        records.push({ name: owner.name, type, ttl, data: canonical.name });
      }
    }
    offset = dataEnd;
  }

  const allowedNames = new Set([normalizeDnsName(hostname)]);
  for (let pass = 0; pass < records.length; pass += 1) {
    let changed = false;
    for (const record of records) {
      if (record.type === 5 && record.data && allowedNames.has(record.name) && !allowedNames.has(record.data)) {
        allowedNames.add(record.data);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const selected = records.filter((record) => record.type === queryType && record.data && allowedNames.has(record.name));
  const addresses = selected.map((record) => record.data!).filter((address) => (
    queryType === 1 ? isIP(address) === 4 : isIP(address) === 6
  ));
  if (addresses.length !== selected.length) return invalidDnsResponse();
  const ttlSeconds = selected.length > 0 ? Math.min(...selected.map((record) => record.ttl)) : 300;
  return { addresses, ttlSeconds: Math.max(1, Math.min(ttlSeconds, 300)) };
}

function readDnsName(buffer: Buffer, startOffset: number): { name: string; nextOffset: number } {
  const labels: string[] = [];
  const visited = new Set<number>();
  let offset = startOffset;
  let nextOffset = startOffset;
  let jumped = false;
  for (let steps = 0; steps < 128; steps += 1) {
    if (offset >= buffer.length || visited.has(offset)) return invalidDnsResponse();
    visited.add(offset);
    const length = buffer[offset]!;
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= buffer.length) return invalidDnsResponse();
      const pointer = (length & 0x3f) << 8 | buffer[offset + 1]!;
      if (!jumped) nextOffset = offset + 2;
      jumped = true;
      offset = pointer;
      continue;
    }
    if ((length & 0xc0) !== 0) return invalidDnsResponse();
    offset += 1;
    if (length === 0) {
      if (!jumped) nextOffset = offset;
      const name = labels.join('.').toLowerCase();
      if (!name || name.length > 253) return invalidDnsResponse();
      return { name, nextOffset };
    }
    if (length > 63 || offset + length > buffer.length) return invalidDnsResponse();
    const label = buffer.subarray(offset, offset + length).toString('ascii').toLowerCase();
    if (!/^[a-z0-9_-]+$/u.test(label)) return invalidDnsResponse();
    labels.push(label);
    offset += length;
    if (!jumped) nextOffset = offset;
  }
  return invalidDnsResponse();
}

function formatIpv6(bytes: Buffer): string {
  const groups: string[] = [];
  for (let offset = 0; offset < 16; offset += 2) groups.push(bytes.readUInt16BE(offset).toString(16));
  return groups.join(':');
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw webError('web_dns_check_failed', 'trusted DNS response exceeded its size limit', { retryable: false });
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw webError('web_dns_check_failed', 'trusted DNS response exceeded its size limit', { retryable: false });
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function linkedTimeout(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('trusted DNS timeout')), timeoutMs);
  timeout.unref?.();
  const abort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abort);
    },
  };
}

function normalizeDnsName(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/u, '');
  if (!normalized || normalized.length > 253) {
    throw webError('web_dns_check_failed', 'DNS hostname is invalid', { retryable: false });
  }
  return normalized;
}

function invalidDnsResponse(): never {
  throw webError('web_dns_check_failed', 'trusted DNS returned an invalid response', { retryable: false });
}
