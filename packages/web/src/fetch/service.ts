import { createHash } from 'node:crypto';
import type { FetchRequest, FetchedDocument, NetworkReadPolicy } from '@littlesheep/types';
import { asWebRetrievalError, WebRetrievalError, webError } from '../errors.js';
import { MemoryWebCache, type WebCache } from '../cache/web-cache.js';
import { extractWebContent } from './extract.js';
import { NodeHttpClient, type HttpClient } from './http-client.js';
import { createPolicyHostResolver } from './dns-resolver.js';
import { hasSensitiveUrlParameters, validatePublicUrl, validateRedirectUrl, type UrlValidationOptions, type ValidatedPublicUrl } from './url-policy.js';

export interface WebFetchServiceOptions {
  readonly policy: Readonly<NetworkReadPolicy>;
  readonly httpClient?: HttpClient;
  readonly resolveHost?: UrlValidationOptions['resolveHost'];
  readonly cache?: WebCache;
  readonly now?: () => Date;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export interface WebFetchResult {
  readonly document: FetchedDocument;
  readonly citationId?: string;
}

/** Bounded anonymous GET service. It owns redirect validation and never sends caller headers/cookies. */
export class WebFetchService {
  private readonly policy: Readonly<NetworkReadPolicy>;
  private readonly httpClient: HttpClient;
  private readonly resolveHost: UrlValidationOptions['resolveHost'];
  private readonly cache?: WebCache;
  private readonly now: () => Date;
  private readonly log?: WebFetchServiceOptions['log'];
  private fetchCount = 0;

  constructor(options: WebFetchServiceOptions) {
    this.policy = options.policy;
    this.httpClient = options.httpClient ?? new NodeHttpClient();
    this.resolveHost = options.resolveHost ?? createPolicyHostResolver(options.policy);
    this.now = options.now ?? (() => new Date());
    this.cache = options.cache ?? (
      options.policy.cacheEnabled
        ? new MemoryWebCache(options.policy.cacheMaxBytes, options.policy.cacheTtlSeconds * 1_000, () => this.now().getTime())
        : undefined
    );
    this.log = options.log;
  }

  async fetch(request: FetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (!this.policy.enabled || this.policy.mode === 'disabled') {
      throw webError('web_disabled', 'public network retrieval is disabled', { retryable: false });
    }
    const maxChars = validateMaxChars(request.maxChars, this.policy.maxExtractedChars);
    let first: ValidatedPublicUrl;
    try {
      first = await validatePublicUrl(request.url, {
        policy: this.policy,
        resolveHost: this.resolveHost,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw webError('web_fetch_cancelled', 'web fetch was cancelled', { retryable: false });
      throw error;
    }
    if (this.fetchCount >= this.policy.maxFetchesPerRun) {
      throw webError('web_partial', 'per-run web fetch quota has been exhausted', { retryable: false });
    }
    this.fetchCount += 1;
    const cacheKey = cacheKeyFor(first.url.toString());
    if (this.cache && !hasSensitiveUrlParameters(first.url)) {
      let cached: FetchedDocument | undefined;
      try {
        cached = await this.cache.get(cacheKey, this.now().getTime());
      } catch {
        throw webError('web_cache_unavailable', 'web cache is unavailable', { retryable: true });
      }
      if (cached) {
        return {
          citationId: request.citationId,
          document: { ...cached, cached: true },
        };
      }
    }

    const controller = linkedTimeoutController(signal, this.policy.fetchTimeoutMs);
    try {
      const document = await this.fetchWithRedirects(first, request.url, maxChars, controller.signal);
      if (this.cache && !document.truncated && !hasSensitiveUrlParameters(first.url) && !hasSensitiveUrlParameters(new URL(document.finalUrl))) {
        try {
          await this.cache.set(cacheKeyFor(document.finalUrl), document, this.now().getTime());
        } catch {
          this.log?.('warn', 'web cache write failed', { kind: 'web_cache_unavailable' });
        }
      }
      return { citationId: request.citationId, document };
    } catch (error) {
      const normalized = controller.timedOut()
        ? webError('web_fetch_timeout', 'web fetch timed out', { retryable: true })
        : signal?.aborted
          ? webError('web_fetch_cancelled', 'web fetch was cancelled', { retryable: false })
          : normalizeFetchError(error);
      this.log?.('warn', 'web fetch failed', { kind: normalized.kind, status: normalized.httpStatus });
      throw normalized;
    } finally {
      controller.dispose();
    }
  }

  async clearCache(): Promise<void> {
    await this.cache?.clear();
  }

  cacheStats(): ReturnType<WebCache['stats']> | undefined {
    return this.cache?.stats();
  }

  private async fetchWithRedirects(
    initial: ValidatedPublicUrl,
    requestedUrl: string,
    maxChars: number,
    signal: AbortSignal,
  ): Promise<FetchedDocument> {
    let current = initial;
    const redirectChain: string[] = [];
    const visited = new Set<string>();
    for (let redirectCount = 0; ; redirectCount += 1) {
      const currentString = current.url.toString();
      if (visited.has(currentString)) {
        throw webError('web_redirect_blocked', 'redirect loop detected', { retryable: false });
      }
      visited.add(currentString);
      const response = await this.httpClient.request({
        url: current.url,
        resolvedAddress: current.address,
        signal,
        maxResponseBytes: this.policy.maxResponseBytes,
        maxDecompressedBytes: this.policy.maxResponseBytes,
      });
      if (isRedirect(response.status)) {
        const location = response.headers.location;
        if (!location) throw webError('web_redirect_blocked', 'redirect response has no Location header', { retryable: false });
        if (redirectCount >= this.policy.maxRedirects) {
          throw webError('web_redirect_blocked', 'redirect limit exceeded', { retryable: false });
        }
        redirectChain.push(currentString);
        current = await validateRedirectUrl(current.url, location, {
          policy: this.policy,
          resolveHost: this.resolveHost,
          signal,
        });
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw webError(response.status >= 500 ? 'web_provider_unavailable' : 'web_content_unsupported', `web page returned HTTP ${response.status}`, {
          retryable: response.status >= 500,
          httpStatus: response.status,
        });
      }
      const contentType = response.headers['content-type'] ?? '';
      const extracted = extractWebContent(response.body, contentType, maxChars);
      if (extracted.extractor === 'none') {
        throw webError('web_content_unsupported', extracted.warnings[0] ?? 'web page content type is unsupported', { retryable: false, httpStatus: response.status });
      }
      if (!extracted.content.trim()) {
        throw webError('web_extraction_failed', 'web page contained no readable text', { retryable: false, httpStatus: response.status });
      }
      const contentHash = `sha256:${createHash('sha256').update(extracted.fullContent).digest('hex')}`;
      return {
        version: 1,
        requestedUrl,
        finalUrl: currentString,
        redirectChain,
        status: response.status,
        contentType: contentType || 'text/plain',
        ...(extracted.title ? { title: extracted.title } : {}),
        ...(extracted.publishedAt ? { publishedAt: extracted.publishedAt } : {}),
        extractor: extracted.extractor,
        content: extracted.content,
        contentHash,
        fetchedAt: this.now().toISOString(),
        cached: false,
        truncated: extracted.truncated,
        externalUntrusted: true,
        warnings: extracted.warnings,
      };
    }
  }
}

function linkedTimeoutController(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const timeout = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new Error('web fetch timeout'));
  }, Math.max(1, timeoutMs));
  timeout.unref?.();
  const abort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  parent?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abort);
    },
  };
}

function normalizeFetchError(error: unknown): WebRetrievalError {
  if (error instanceof WebRetrievalError) {
    return webError(error.kind, fetchErrorMessage(error.kind), {
      retryable: error.retryable,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    });
  }
  if (error instanceof Error && error.message.toLowerCase().includes('timeout')) {
    return webError('web_fetch_timeout', 'web fetch timed out', { retryable: true });
  }
  return asWebRetrievalError(error, 'web_provider_unavailable');
}

function fetchErrorMessage(kind: WebRetrievalError['kind']): string {
  switch (kind) {
    case 'web_redirect_blocked': return 'web redirect was blocked';
    case 'web_response_too_large': return 'web response exceeded the configured limit';
    case 'web_content_unsupported': return 'web content is unsupported';
    case 'web_extraction_failed': return 'web content extraction failed';
    case 'web_fetch_cancelled': return 'web fetch was cancelled';
    case 'web_fetch_timeout': return 'web fetch timed out';
    case 'web_ssrf_blocked': return 'web fetch target was blocked';
    default: return 'web fetch failed';
  }
}

function validateMaxChars(value: number | undefined, policyMax: number): number {
  if (value === undefined) return policyMax;
  if (!Number.isSafeInteger(value) || value < 1 || value > policyMax) {
    throw webError('web_url_invalid', 'web_fetch maxChars is outside the configured limit', { retryable: false });
  }
  return value;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function cacheKeyFor(url: string): string {
  return `url:${createHash('sha256').update(url).digest('hex')}`;
}
