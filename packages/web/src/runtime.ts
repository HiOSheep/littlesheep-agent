// Per-run Web retrieval budgets, cancellation, citations, and evidence projection.
import { createHash } from 'node:crypto';
import type {
  FetchRequest,
  FetchedDocument,
  NetworkReadPolicy,
  SearchRequest,
  SearchResponse,
  WebCitation,
  WebCitationProjection,
  WebErrorKind,
  WebEvidenceProjection,
  WebRetrievalRuntimePort,
} from '@littlesheep/types';
import { isWebErrorKind, WebRetrievalError, webError } from './errors.js';
import type { ProviderRegistry, SearchProviderContext } from './provider.js';
import { WebFetchService } from './fetch/service.js';
import type { WebCache } from './cache/web-cache.js';
import { hasSensitiveUrlParameters } from './fetch/url-policy.js';

export interface WebRetrievalRuntimeOptions {
  /** Stable owner of quotas, cancellation and the citation namespace. */
  readonly runId: string;
  readonly policy: Readonly<NetworkReadPolicy>;
  readonly providers: ProviderRegistry;
  /** Parent run cancellation. The runtime never outlives this signal. */
  readonly signal?: AbortSignal;
  /** Process-local cache may be shared, while all counters stay run-scoped. */
  readonly cache?: WebCache;
  readonly fetchService?: WebFetchService;
  readonly now?: () => Date;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

interface RequestSlotWaiter {
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  abort: () => void;
}

/** Run-scoped gateway that owns quotas, citation binding and bounded evidence. */
export class WebRetrievalRuntime implements WebRetrievalRuntimePort {
  readonly runId: string;
  readonly policy: Readonly<NetworkReadPolicy>;
  readonly providers: ProviderRegistry;
  readonly fetchService: WebFetchService;
  private readonly now: () => Date;
  private readonly log?: WebRetrievalRuntimeOptions['log'];
  private readonly runAbort = new AbortController();
  private readonly detachParentSignal: () => void;
  private readonly totalTimeout: ReturnType<typeof setTimeout>;
  private readonly citationNamespace: string;
  private readonly requestWaiters: RequestSlotWaiter[] = [];
  private readonly citations = new Map<string, WebCitation>();
  private readonly citationUrls = new Map<string, string>();
  private readonly errors = new Set<WebErrorKind>();
  private activeRequests = 0;
  private totalTimedOut = false;
  private disposed = false;
  private queryCount = 0;
  private searchResultCount = 0;
  private fetchResultCount = 0;
  private cached = false;
  private partial = false;
  private truncated = false;
  private blocked = false;
  private stale = false;

  constructor(options: WebRetrievalRuntimeOptions) {
    const runId = options.runId.trim();
    if (!runId) throw new Error('web retrieval runtime requires a non-empty runId');
    this.runId = runId;
    this.policy = options.policy;
    this.providers = options.providers;
    this.now = options.now ?? (() => new Date());
    this.log = options.log;
    this.citationNamespace = createHash('sha256').update(runId).digest('hex').slice(0, 10);
    this.fetchService = options.fetchService ?? new WebFetchService({
      policy: options.policy,
      cache: options.cache,
      now: this.now,
      log: options.log,
    });

    const abortFromParent = (): void => {
      if (!this.runAbort.signal.aborted) this.runAbort.abort(options.signal?.reason);
    };
    if (options.signal?.aborted) abortFromParent();
    else options.signal?.addEventListener('abort', abortFromParent, { once: true });
    this.detachParentSignal = () => options.signal?.removeEventListener('abort', abortFromParent);

    this.totalTimeout = setTimeout(() => {
      this.totalTimedOut = true;
      if (!this.runAbort.signal.aborted) this.runAbort.abort(new Error('web retrieval total timeout'));
    }, boundedTimeout(options.policy.totalTimeoutMs));
    this.totalTimeout.unref?.();
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    try {
      return await this.withRequestBudget('search', this.policy.searchTimeoutMs, signal, async (operationSignal) => {
        if (!this.policy.enabled || this.policy.mode === 'disabled') return this.fail('web_disabled', 'public network retrieval is disabled');
        const boundedRequest: SearchRequest = {
          ...request,
          runId: this.runId,
          query: boundQuery(request.query, this.policy.maxQueryChars),
          maxResults: boundedMaxResults(request.maxResults, this.policy.maxResults),
        };
        if (this.queryCount >= this.policy.maxQueriesPerRun) return this.fail('web_partial', 'per-run web search quota has been exhausted');
        const providerId = this.policy.providerId;
        const provider = this.providers.get(providerId);
        if (!provider) return this.fail('web_provider_unconfigured', 'no configured web search provider is available');
        this.queryCount += 1;
        const context: SearchProviderContext = {
          policy: this.policy,
          signal: operationSignal,
          now: this.now,
          citationIdFor: (url, rank) => this.citationId(url, rank),
          log: this.log,
        };
        let response: SearchResponse | undefined;
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            response = await provider.search(boundedRequest, context);
            break;
          } catch (error) {
            lastError = error;
            const retryable = error && typeof error === 'object' && 'retryable' in error && (error as { retryable?: unknown }).retryable === true;
            if (!retryable || attempt === 1) break;
            await waitBeforeRetry(error, operationSignal);
          }
        }
        if (!response) {
          const candidateKind = lastError && typeof lastError === 'object' && 'kind' in lastError
            ? (lastError as { kind?: unknown }).kind
            : undefined;
          const kind = isWebErrorKind(candidateKind) ? candidateKind : 'web_provider_unavailable';
          this.recordError(kind);
          if (lastError instanceof WebRetrievalError) {
            throw webError(kind, providerErrorMessage(kind), {
              retryable: lastError.retryable,
              ...(lastError.retryAfterMs === undefined ? {} : { retryAfterMs: Math.min(Math.max(0, lastError.retryAfterMs), 60_000) }),
              providerId: provider.id,
              ...(lastError.httpStatus === undefined ? {} : { httpStatus: lastError.httpStatus }),
            });
          }
          throw webError(kind, 'web search provider failed', {
            retryable: Boolean(lastError && typeof lastError === 'object' && 'retryable' in lastError && (lastError as { retryable?: unknown }).retryable),
            providerId: provider.id,
          });
        }
        if (response.provider !== provider.id) {
          return this.fail('web_provider_invalid_response', 'web search provider identity did not match the selected provider');
        }
        response = normalizeProviderResponse(
          response,
          boundedRequest,
          provider.id,
          (url, rank) => this.citationId(url, rank),
          this.now,
        );
        this.searchResultCount += response.results.length;
        this.cached ||= response.cached;
        this.partial ||= response.partial;
        for (const result of response.results) {
          const citation: WebCitation = {
            id: result.citationId,
            url: result.canonicalUrl ?? result.url,
            ...(result.title ? { title: result.title } : {}),
            provider: response.provider,
            ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
            fetchedAt: response.fetchedAt,
            status: response.cached ? 'cached' : response.partial ? 'partial' : 'search_result',
            truncated: false,
          };
          this.citations.set(citation.id, citation);
          this.citationUrls.set(citation.id, citation.url);
        }
        return response;
      });
    } catch (error) {
      this.recordKnownError(error);
      throw error;
    }
  }

  async fetch(request: FetchRequest, signal?: AbortSignal): Promise<FetchedDocument> {
    try {
      return await this.withRequestBudget('fetch', this.policy.fetchTimeoutMs, signal, async (operationSignal) => {
        if (request.citationId) {
          const expected = this.citationUrls.get(request.citationId);
          if (!expected || !sameUrl(expected, request.url)) {
            return this.fail('web_citation_invalid', 'citationId does not match a known search result URL');
          }
        }
        const result = await this.fetchService.fetch(request, operationSignal);
        this.fetchResultCount += 1;
        this.cached ||= result.document.cached;
        this.truncated ||= result.document.truncated;
        this.partial ||= result.document.truncated;
        let citationId = request.citationId;
        if (request.citationId) {
          const previous = this.citations.get(request.citationId);
          this.citations.set(request.citationId, {
            id: request.citationId,
            url: result.document.finalUrl,
            ...(result.document.title ? { title: result.document.title } : previous?.title ? { title: previous.title } : {}),
            ...(previous?.provider ? { provider: previous.provider } : {}),
            ...(result.document.publishedAt ? { publishedAt: result.document.publishedAt } : previous?.publishedAt ? { publishedAt: previous.publishedAt } : {}),
            fetchedAt: result.document.fetchedAt,
            status: result.document.cached ? 'cached' : result.document.truncated ? 'partial' : 'fetched',
            contentHash: result.document.contentHash,
            truncated: result.document.truncated,
          });
        } else {
          citationId = this.citationId(result.document.finalUrl, this.citations.size + 1);
          this.citations.set(citationId, {
            id: citationId,
            url: result.document.finalUrl,
            ...(result.document.title ? { title: result.document.title } : {}),
            fetchedAt: result.document.fetchedAt,
            status: result.document.cached ? 'cached' : result.document.truncated ? 'partial' : 'fetched',
            contentHash: result.document.contentHash,
            truncated: result.document.truncated,
          });
        }
        return { ...result.document, ...(citationId ? { citationId } : {}) };
      });
    } catch (error) {
      this.recordKnownError(error);
      throw error;
    }
  }

  /** End the run-scoped lifetime and cancel in-flight/queued retrieval. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.totalTimeout);
    this.detachParentSignal();
    if (!this.runAbort.signal.aborted) this.runAbort.abort(new Error('web retrieval runtime disposed'));
  }

  evidence(): WebEvidenceProjection {
    const completeness = this.citations.size === 0
      ? 'none'
      : this.partial || this.errors.size > 0
        ? 'partial'
        : 'complete';
    const citations = [...this.citations.values()].slice(0, 128).map(projectCitation);
    return {
      version: 1,
      ...(this.policy.providerId ? { providerId: this.policy.providerId } : {}),
      generatedAt: this.now().toISOString(),
      completeness,
      citationIds: citations.map((citation) => citation.id),
      citations,
      citationCount: this.citations.size,
      documentCount: this.fetchResultCount,
      cached: this.cached,
      partial: this.partial || this.errors.size > 0,
      truncated: this.truncated,
      blocked: this.blocked,
      stale: this.stale,
      ...(this.errors.size > 0 ? { errorKinds: [...this.errors] } : {}),
    };
  }

  citationsSnapshot(): readonly WebCitation[] {
    return [...this.citations.values()].map((citation) => structuredClone(citation));
  }

  private citationId(url: string, rank: number): string {
    const normalized = normalizeUrl(url);
    const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
    return `web-${this.citationNamespace}-${rank}-${digest}`;
  }

  private async withRequestBudget<T>(
    kind: 'search' | 'fetch',
    timeoutMs: number,
    invocationSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.disposed) throw webError('web_fetch_cancelled', 'web retrieval runtime is no longer active', { retryable: false });
    if (this.totalTimedOut) throw webError('web_partial', 'web retrieval total timeout has been exhausted', { retryable: false });
    const linked = linkedOperationController(this.runAbort.signal, invocationSignal, timeoutMs);
    let acquired = false;
    try {
      await this.acquireRequestSlot(linked.signal);
      acquired = true;
      return await operation(linked.signal);
    } catch (error) {
      if (this.totalTimedOut) {
        throw webError('web_partial', 'web retrieval total timeout has been exhausted', { retryable: false });
      }
      if (linked.timedOut()) {
        throw webError(
          kind === 'fetch' ? 'web_fetch_timeout' : 'web_provider_unavailable',
          kind === 'fetch' ? 'web fetch timed out' : 'web search timed out',
          { retryable: true },
        );
      }
      if (this.disposed || this.runAbort.signal.aborted || invocationSignal?.aborted) {
        throw webError('web_fetch_cancelled', 'web retrieval was cancelled', { retryable: false });
      }
      throw error;
    } finally {
      if (acquired) this.releaseRequestSlot();
      linked.dispose();
    }
  }

  private acquireRequestSlot(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(webError('web_fetch_cancelled', 'web retrieval was cancelled', { retryable: false }));
    if (this.activeRequests < Math.max(1, this.policy.maxConcurrentRequests)) {
      this.activeRequests += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: RequestSlotWaiter = {
        signal,
        resolve,
        reject,
        abort: () => undefined,
      };
      waiter.abort = () => {
        const index = this.requestWaiters.indexOf(waiter);
        if (index >= 0) this.requestWaiters.splice(index, 1);
        signal.removeEventListener('abort', waiter.abort);
        reject(webError('web_fetch_cancelled', 'web retrieval was cancelled while waiting for capacity', { retryable: false }));
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.requestWaiters.push(waiter);
    });
  }

  private releaseRequestSlot(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    while (this.requestWaiters.length > 0) {
      const waiter = this.requestWaiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(webError('web_fetch_cancelled', 'web retrieval was cancelled while waiting for capacity', { retryable: false }));
        continue;
      }
      this.activeRequests += 1;
      waiter.resolve();
      break;
    }
  }

  private recordKnownError(error: unknown): void {
    if (error && typeof error === 'object' && 'kind' in error && isWebErrorKind((error as { kind?: unknown }).kind)) {
      this.recordError((error as { kind: WebErrorKind }).kind);
    }
  }

  private recordError(kind: WebErrorKind): void {
    this.errors.add(kind);
    this.partial = true;
    this.blocked ||= kind === 'web_ssrf_blocked' || kind === 'web_scheme_blocked' || kind === 'web_redirect_blocked';
  }

  private fail(kind: WebErrorKind, message: string): never {
    this.recordError(kind);
    throw webError(kind, message, { retryable: false });
  }
}

function projectCitation(citation: WebCitation): WebCitationProjection {
  const url = new URL(normalizeUrl(citation.url));
  const canonicalUrl = url.toString();
  const title = citation.title ? cleanProviderText(citation.title, 300) : '';
  const provider = citation.provider ? cleanProviderText(citation.provider, 100) : '';
  const publishedAt = citation.publishedAt && validIsoDate(citation.publishedAt)
    ? citation.publishedAt
    : undefined;
  return {
    id: citation.id.slice(0, 200),
    ...(!hasSensitiveUrlParameters(url) ? { url: canonicalUrl } : {}),
    origin: url.origin,
    urlHash: createHash('sha256').update(canonicalUrl).digest('hex'),
    ...(title ? { title } : {}),
    ...(provider ? { provider } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    fetchedAt: validIsoDate(citation.fetchedAt) ? citation.fetchedAt : new Date(0).toISOString(),
    status: citation.status,
    ...(citation.contentHash ? { contentHash: citation.contentHash.slice(0, 200) } : {}),
    truncated: citation.truncated,
  };
}

function providerErrorMessage(kind: WebErrorKind): string {
  switch (kind) {
    case 'web_provider_auth_failed': return 'web search provider authentication failed';
    case 'web_provider_rate_limited': return 'web search provider rate limit reached';
    case 'web_provider_invalid_response': return 'web search provider returned an invalid response';
    case 'web_fetch_cancelled': return 'web search was cancelled';
    default: return 'web search provider failed';
  }
}

function normalizeProviderResponse(
  response: SearchResponse,
  request: SearchRequest,
  providerId: string,
  citationIdFor: (url: string, rank: number) => string,
  now: () => Date,
): SearchResponse {
  const results: SearchResponse['results'][number][] = [];
  const seen = new Set<string>();
  let discarded = false;
  for (const candidate of response.results) {
    if (results.length >= request.maxResults) {
      discarded = true;
      break;
    }
    const rawUrl = typeof candidate.canonicalUrl === 'string' ? candidate.canonicalUrl : candidate.url;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      discarded = true;
      continue;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || hasSensitiveUrlParameters(url)) {
      discarded = true;
      continue;
    }
    url.hash = '';
    const canonicalUrl = url.toString();
    if (seen.has(canonicalUrl)) continue;
    const title = cleanProviderText(candidate.title, 500);
    if (!title) {
      discarded = true;
      continue;
    }
    seen.add(canonicalUrl);
    const rank = results.length + 1;
    results.push({
      rank,
      title,
      url: canonicalUrl,
      canonicalUrl,
      ...(candidate.snippet ? { snippet: cleanProviderText(candidate.snippet, 2_000) } : {}),
      ...(candidate.publishedAt ? { publishedAt: cleanProviderText(candidate.publishedAt, 100) } : {}),
      siteName: url.hostname,
      ...(candidate.language ? { language: cleanProviderText(candidate.language, 35) } : {}),
      citationId: citationIdFor(canonicalUrl, rank),
      sourceStatus: candidate.sourceStatus === 'cached_result' ? 'cached_result' : candidate.sourceStatus === 'partial' ? 'partial' : 'search_result',
    });
  }
  const partial = response.partial || discarded;
  return {
    version: 1,
    provider: providerId,
    query: request.query,
    results,
    fetchedAt: validIsoDate(response.fetchedAt) ? response.fetchedAt : now().toISOString(),
    cached: response.cached === true,
    partial,
    warnings: partial ? ['provider response was bounded by runtime normalization'] : [],
  };
}

function cleanProviderText(value: string, maxChars: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maxChars);
}

function validIsoDate(value: string): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function boundQuery(query: string, maxChars: number): string {
  if (typeof query !== 'string' || /[\u0000-\u001f\u007f]/u.test(query)) {
    throw webError('web_invalid_query', 'web search query contains invalid control characters', { retryable: false });
  }
  const bounded = query.replace(/\s+/gu, ' ').trim();
  if (!bounded) throw webError('web_invalid_query', 'web search query is empty', { retryable: false });
  const limit = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 500;
  if (bounded.length > limit) throw webError('web_invalid_query', 'web search query exceeds the configured limit', { retryable: false });
  return bounded;
}

function boundedMaxResults(value: number, policyMax: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > Math.max(1, Math.floor(policyMax))) {
    throw webError('web_invalid_query', 'web search maxResults is outside the configured limit', { retryable: false });
  }
  return value;
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value.trim();
  }
}

function sameUrl(left: string, right: string): boolean {
  return normalizeUrl(left) === normalizeUrl(right);
}

async function waitBeforeRetry(error: unknown, signal?: AbortSignal): Promise<void> {
  const retryAfter = error && typeof error === 'object' && 'retryAfterMs' in error
    ? Number((error as { retryAfterMs?: unknown }).retryAfterMs)
    : 0;
  const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 2_000) : 100;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, delay);
    const abort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(webError('web_fetch_cancelled', 'web search was cancelled', { retryable: false }));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function boundedTimeout(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 90_000;
}

function linkedOperationController(
  runSignal: AbortSignal,
  invocationSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const abortFromRun = (): void => {
    if (!controller.signal.aborted) controller.abort(runSignal.reason);
  };
  const abortFromInvocation = (): void => {
    if (!controller.signal.aborted) controller.abort(invocationSignal?.reason);
  };
  if (runSignal.aborted) abortFromRun();
  else runSignal.addEventListener('abort', abortFromRun, { once: true });
  if (invocationSignal?.aborted) abortFromInvocation();
  else invocationSignal?.addEventListener('abort', abortFromInvocation, { once: true });
  const timeout = setTimeout(() => {
    timeoutTriggered = true;
    if (!controller.signal.aborted) controller.abort(new Error('web request timeout'));
  }, boundedTimeout(timeoutMs));
  timeout.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      clearTimeout(timeout);
      runSignal.removeEventListener('abort', abortFromRun);
      invocationSignal?.removeEventListener('abort', abortFromInvocation);
    },
  };
}
