import { gzipSync } from 'node:zlib';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { NodeHttpClient, readBoundedHttpBody } from './http-client.js';

function incoming(headers: Record<string, string> = {}): { message: IncomingMessage; stream: PassThrough } {
  const stream = new PassThrough();
  const message = stream as unknown as IncomingMessage;
  Object.defineProperty(message, 'headers', { value: headers, configurable: true });
  Object.defineProperty(message, 'statusCode', { value: 200, configurable: true });
  return { message, stream };
}

describe('NodeHttpClient hard limits', () => {
  it('rejects missing and non-public pinned addresses before opening a socket', async () => {
    const client = new NodeHttpClient();
    const base = { url: new URL('https://example.com/'), maxResponseBytes: 100 };
    await expect(client.request(base)).rejects.toMatchObject({ kind: 'web_dns_check_failed' });
    await expect(client.request({ ...base, resolvedAddress: '127.0.0.1' }))
      .rejects.toMatchObject({ kind: 'web_ssrf_blocked' });
  });

  it('enforces the wire-byte limit on an identity response', async () => {
    const { message, stream } = incoming({ 'content-type': 'text/plain' });
    const pending = readBoundedHttpBody(message, 4, 100);
    stream.end('12345');
    await expect(pending).rejects.toMatchObject({ kind: 'web_response_too_large' });
  });

  it('enforces decompressed bytes independently of compressed wire bytes', async () => {
    const compressed = gzipSync(Buffer.alloc(10_000, 65));
    const { message, stream } = incoming({ 'content-encoding': 'gzip' });
    const pending = readBoundedHttpBody(message, compressed.length + 10, 1_000);
    stream.end(compressed);
    await expect(pending).rejects.toMatchObject({ kind: 'web_response_too_large' });
  });

  it('returns separate wire and decompressed counts for bounded gzip', async () => {
    const body = Buffer.from('bounded compressed public response');
    const compressed = gzipSync(body);
    const { message, stream } = incoming({ 'content-encoding': 'gzip' });
    const pending = readBoundedHttpBody(message, compressed.length, body.length);
    stream.end(compressed);
    await expect(pending).resolves.toMatchObject({
      body,
      bytesReceived: compressed.length,
      decompressedBytes: body.length,
    });
  });

  it('rejects unsupported content encodings through the stable error boundary', async () => {
    const { message, stream } = incoming({ 'content-encoding': 'fixture-unsupported' });
    const pending = readBoundedHttpBody(message, 100, 100);
    stream.end('public response');

    await expect(pending).rejects.toMatchObject({
      kind: 'web_content_unsupported',
      retryable: false,
      message: 'HTTP content encoding is unsupported',
    });
  });
});
