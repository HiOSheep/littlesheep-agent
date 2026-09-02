import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';
import { WebRetrievalError, webError } from '../errors.js';
import { isBlockedIp } from './url-policy.js';

export interface HttpRequest {
  readonly url: URL;
  /** Checked address; when present the socket is pinned to this IP. */
  readonly resolvedAddress?: string;
  readonly signal?: AbortSignal;
  readonly maxResponseBytes: number;
  readonly maxDecompressedBytes?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly bytesReceived: number;
  readonly decompressedBytes: number;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

/** Minimal Node HTTP client with fixed headers, bounded bodies and IP pinning. */
export class NodeHttpClient implements HttpClient {
  async request(input: HttpRequest): Promise<HttpResponse> {
    const address = input.resolvedAddress;
    if (!address) {
      throw webError('web_dns_check_failed', 'HTTP request requires a previously checked address', { retryable: false });
    }
    if (isBlockedIp(address)) {
      throw webError('web_ssrf_blocked', 'HTTP request address is not public', { retryable: false });
    }
    const transport = input.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {
      accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.1',
      'accept-encoding': 'gzip, br, deflate',
      'user-agent': 'LittleSheep/0.1 (+https://github.com/littlesheep)',
    };
    // Preserve virtual-host routing while connecting to the checked IP. The
    // caller cannot inject headers into this client; only package-owned values
    // reach it.
    headers.host = input.url.host;

    const options: RequestOptions = {
      protocol: input.url.protocol,
      hostname: address,
      port: input.url.port ? Number(input.url.port) : undefined,
      path: `${input.url.pathname}${input.url.search}`,
      method: 'GET',
      headers,
      agent: false,
      ...(input.url.protocol === 'https:' ? { servername: input.url.hostname } : {}),
    };

    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      let request: ReturnType<typeof transport> | undefined;

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        request?.destroy();
        reject(error);
      };
      const succeed = (response: HttpResponse): void => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      const abort = (): void => {
        fail(webError('web_fetch_cancelled', 'network request was cancelled', { retryable: false }));
      };
      if (input.signal?.aborted) {
        abort();
        return;
      }

      request = transport(options, (response) => {
        const contentLength = parseContentLength(response.headers);
        if (contentLength !== undefined && contentLength > input.maxResponseBytes) {
          fail(webError('web_response_too_large', 'HTTP response exceeds the configured size limit', { retryable: false }));
          response.resume();
          return;
        }
        void readBoundedHttpBody(response, input.maxResponseBytes, input.maxDecompressedBytes ?? input.maxResponseBytes)
          .then((body) => succeed({
            status: response.statusCode ?? 0,
            headers: normalizeHeaders(response.headers),
            ...body,
          }))
          .catch(fail);
      });
      request.once('error', (error) => fail(mapHttpError(error)));
      input.signal?.addEventListener('abort', abort, { once: true });
      request.once('close', () => input.signal?.removeEventListener('abort', abort));
      request.end();
    });
  }
}

export async function readBoundedHttpBody(
  response: IncomingMessage,
  maxResponseBytes: number,
  maxDecompressedBytes: number,
): Promise<Pick<HttpResponse, 'body' | 'bytesReceived' | 'decompressedBytes'>> {
  const encoding = headerValue(response.headers, 'content-encoding')?.toLowerCase().split(',')[0]?.trim();
  return new Promise((resolve, reject) => {
    let settled = false;
    let rawBytes = 0;
    let decompressedBytes = 0;
    const chunks: Buffer[] = [];
    let responseStream: NodeJS.ReadableStream = response;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      destroyStream(responseStream);
      if (responseStream !== response) response.destroy();
      reject(mapHttpError(error));
    };
    try {
      responseStream = decompressor(response, encoding);
    } catch (error) {
      // Unsupported encodings are expected input failures. Keep the response
      // flowing/closed and route the error through the same stable boundary as
      // stream and socket failures instead of throwing from the HTTP callback.
      response.resume();
      fail(error);
      return;
    }
    response.on('data', (chunk: Buffer | string) => {
      rawBytes += Buffer.byteLength(chunk);
      if (rawBytes > maxResponseBytes) {
        fail(webError('web_response_too_large', 'HTTP response exceeds the configured size limit', { retryable: false }));
      }
    });
    response.once('error', fail);
    responseStream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      decompressedBytes += buffer.length;
      if (decompressedBytes > maxDecompressedBytes) {
        fail(webError('web_response_too_large', 'decompressed HTTP response exceeds the configured size limit', { retryable: false }));
        return;
      }
      chunks.push(buffer);
    });
    responseStream.once('error', fail);
    responseStream.once('end', () => {
      if (settled) return;
      settled = true;
      resolve({ body: Buffer.concat(chunks), bytesReceived: rawBytes, decompressedBytes });
    });
  });
}

function decompressor(response: IncomingMessage, encoding: string | undefined): NodeJS.ReadableStream {
  if (!encoding || encoding === 'identity') return response;
  if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(createGunzip());
  if (encoding === 'deflate') return response.pipe(createInflate());
  if (encoding === 'br') return response.pipe(createBrotliDecompress());
  throw webError('web_content_unsupported', 'HTTP content encoding is unsupported', { retryable: false });
}

function destroyStream(stream: NodeJS.ReadableStream | undefined): void {
  if (stream && 'destroy' in stream && typeof stream.destroy === 'function') {
    stream.destroy();
  }
}

function parseContentLength(headers: IncomingHttpHeaders): number | undefined {
  const value = headerValue(headers, 'content-length');
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) result[name.toLowerCase()] = value.join(', ');
    else if (value !== undefined) result[name.toLowerCase()] = value;
  }
  return result;
}

function mapHttpError(error: unknown): WebRetrievalError {
  if (error instanceof WebRetrievalError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return webError('web_fetch_cancelled', 'network request was cancelled', { retryable: false });
  }
  // Socket/TLS/parser errors can contain host, IP or response fragments. Only
  // the stable kind crosses the transport boundary.
  return webError('web_provider_unavailable', 'network request failed', { retryable: true });
}
