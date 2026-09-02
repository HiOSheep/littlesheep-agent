import { describe, expect, it, vi } from 'vitest';
import type {
  FetchedDocument,
  NetworkReadPolicy,
  SearchResponse,
} from '@littlesheep/types';
import { SearchProviderRegistry, type SearchProvider } from './provider.js';
import { WebRetrievalRuntime } from './runtime.js';
import type { WebCache } from './cache/web-cache.js';
import { WebFetchService } from './fetch/service.js';

const PUBLIC_URL = 'https://93.184.216.34/article';

function policy(overrides: Partial<NetworkReadPolicy> = {}): NetworkReadPolicy {
  return {
    version: 1,
    enabled: true,
    providerId: 'fake',
    mode: 'public_anonymous',
    allowDomains: [],
    blockDomains: [],
    strictReadApproval: false,
    maxResults: 4,
    maxQueryChars: 200,
    maxQueriesPerRun: 1,
    maxFetchesPerRun: 1,
    maxConcurrentRequests: 1,
    searchTimeoutMs: 5_000,
    fetchTimeoutMs: 5_000,
    totalTimeoutMs: 30_000,
    maxResponseBytes: 64 * 1024,
    maxExtractedChars: 4_000,
    maxRedirects: 2,
    cacheEnabled: true,
    cacheTtlSeconds: 300,
    cacheMaxBytes: 1024 * 1024,
    browserFallback: 'approval_required',
    sensitiveQueryPolicy: 'approve',
    ...overrides,
  };
}

function response(
  request: Parameters<SearchProvider['search']>[0],
  context: Parameters<SearchProvider['search']>[1],
): SearchResponse {
  return {
    version: 1,
    provider: 'fake',
    query: request.query,
    results: [{
      rank: 1,
      title: 'Public article',
      url: PUBLIC_URL,
      canonicalUrl: PUBLIC_URL,
      citationId: context.citationIdFor!(PUBLIC_URL, 1),
      sourceStatus: 'search_result',
    }],
    fetchedAt: '2026-08-29T00:00:00.000Z',
    cached: false,
    partial: false,
    warnings: [],
  };
}

function cachedDocument(): FetchedDocument {
  return {
    version: 1,
    requestedUrl: PUBLIC_URL,
    finalUrl: PUBLIC_URL,
    redirectChain: [],
    status: 200,
    contentType: 'text/html; charset=utf-8',
    title: 'Public article',
    extractor: 'readability',
    content: 'Bounded cached public content.',
    contentHash: 'sha256:cached',
    fetchedAt: '2026-08-29T00:00:00.000Z',
    cached: false,
    truncated: false,
    externalUntrusted: true,
    warnings: [],
  };
}

describe('WebRetrievalRuntime run-scoped lifecycle', () => {
  it('rejects invalid search input before consuming query quota', async () => {
    let calls = 0;
    const provider: SearchProvider = {
      id: 'fake',
      displayName: 'Fake',
      capabilities: { search: true, recency: true, domains: true, language: true, citations: true },
      async search(request, context) {
        calls += 1;
        return response(request, context);
      },
    };
    const runtime = new WebRetrievalRuntime({
      runId: 'input-validation',
      policy: policy({ maxQueriesPerRun: 1, maxResults: 2, maxQueryChars: 12 }),
      providers: new SearchProviderRegistry([provider]),
    });
    try {
      await expect(runtime.search({ query: 'bad\nquery', maxResults: 1, runId: 'ignored' }))
        .rejects.toMatchObject({ kind: 'web_invalid_query' });
      await expect(runtime.search({ query: 'query is much too long', maxResults: 1, runId: 'ignored' }))
        .rejects.toMatchObject({ kind: 'web_invalid_query' });
      await expect(runtime.search({ query: 'valid', maxResults: Number.NaN, runId: 'ignored' }))
        .rejects.toMatchObject({ kind: 'web_invalid_query' });
      await expect(runtime.search({ query: 'valid', maxResults: 3, runId: 'ignored' }))
        .rejects.toMatchObject({ kind: 'web_invalid_query' });
      await expect(runtime.search({ query: ' valid ', maxResults: 2, runId: 'ignored' }))
        .resolves.toMatchObject({ query: 'valid' });
      expect(calls).toBe(1);
      await expect(runtime.search({ query: 'again', maxResults: 1, runId: 'ignored' }))
        .rejects.toMatchObject({ kind: 'web_partial' });
    } finally {
      runtime.dispose();
    }
  });

  it('rejects a provider response whose identity differs from the selected registry id', async () => {
    const provider: SearchProvider = {
      id: 'fake',
      displayName: 'Fake',
      capabilities: { search: true, recency: true, domains: true, language: true, citations: true },
      async search(request, context) {
        return { ...response(request, context), provider: 'forged-provider' };
      },
    };
    const runtime = new WebRetrievalRuntime({
      runId: 'identity-check',
      policy: policy(),
      providers: new SearchProviderRegistry([provider]),
    });
    try {
      await expect(runtime.search({ query: 'valid', maxResults: 1, runId: 'ignored' }))
        .rejects.toMatchObject({ kind: 'web_provider_invalid_response' });
      expect(runtime.evidence()).toMatchObject({ partial: true, errorKinds: ['web_provider_invalid_response'] });
    } finally {
      runtime.dispose();
    }
  });

  it('uses a finite two-attempt retry budget', async () => {
    let calls = 0;
    const provider: SearchProvider = {
      id: 'fake',
      displayName: 'Fake',
      capabilities: { search: true, recency: true, domains: true, language: true, citations: true },
      async search() {
        calls += 1;
        throw Object.assign(new Error('temporary provider failure'), {
          kind: 'web_provider_unavailable', retryable: true,
        });
      },
    };
    const runtime = new WebRetrievalRuntime({
      runId: 'retry-budget',
      policy: policy(),
      providers: new SearchProviderRegistry([provider]),
    });
    try {
      await expect(runtime.search({ query: 'valid', maxResults: 1, runId: 'ignored' })).rejects.toThrow();
      expect(calls).toBe(2);
    } finally {
      runtime.dispose();
    }
  });

  it('does not propagate provider error messages or causes across the runtime boundary', async () => {
    const provider: SearchProvider = {
      id: 'fake',
      displayName: 'Fake',
      capabilities: { search: true, recency: true, domains: true, language: true, citations: true },
      async search() {
        throw Object.assign(new Error('Authorization Bearer fixture-secret'), {
          kind: 'web_provider_unavailable', retryable: false, cause: new Error('fixture-secret'),
        });
      },
    };
    const runtime = new WebRetrievalRuntime({
      runId: 'provider-error-redaction', policy: policy(), providers: new SearchProviderRegistry([provider]),
    });
    try {
      const caught = await runtime.search({ query: 'valid', maxResults: 1, runId: 'ignored' }).catch((error: unknown) => error);
      expect(caught).toMatchObject({ kind: 'web_provider_unavailable', providerId: 'fake' });
      expect(String(caught)).not.toContain('fixture-secret');
      expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
    } finally {
      runtime.dispose();
    }
  });

  it('does not accept a forged provider error kind into evidence', async () => {
    const provider: SearchProvider = {
      id: 'fake',
      displayName: 'Fake',
      capabilities: { search: true, recency: true, domains: true, language: true, citations: true },
      async search() {
        throw Object.assign(new Error('secret error'), { kind: 'forged_secret_kind', retryable: false });
      },
    };
    const runtime = new WebRetrievalRuntime({
      runId: 'forged-error-kind', policy: policy(), providers: new SearchProviderRegistry([provider]),
    });
    try {
      await expect(runtime.search({ query: 'valid', maxResults: 1, runId: 'ignored' }))
        .rejects.toMatchObject({ kind: 'web_provider_unavailable' });
      expect(runtime.evidence().errorKinds).toEqual(['web_provider_unavailable']);
      expect(JSON.stringify(runtime.evidence())).not.toContain('forged_secret_kind');
    } finally {
      runtime.dispose();
    }
  });

  it('removes invocation abort listeners after a successful request', async () => {
    const provider: SearchProvider = {
      id: 'fake',
      displayName: 'Fake',
      capabilities: { search: true, recency: true, domains: true, language: true, citations: true },
      async search(request, context) { return response(request, context); },
    };
    const invocation = new AbortController();
    const add = vi.spyOn(invocation.signal, 'addEventListener');
    const remove = vi.spyOn(invocation.signal, 'removeEventListener');
    const runtime = new WebRetrievalRuntime({
      runId: 'listener-cleanup', policy: policy(), providers: new SearchProviderRegistry([provider]),
    });
    try {
      await runtime.search({ query: 'valid', maxResults: 1, runId: 'ignored' }, invocation.signal);
      expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    } finally {
      runtime.dispose();
    }
  });

  it('stops in-flight and future requests after the total retrieval deadline', async () => {
    let calls = 0;
    const provider: SearchProvider = {
      id: 'fake',
      displayName: 'Fake',
      capabilities: { search: true, recency: true, domains: true, language: true, citations: true },
      search: vi.fn((_request, context) => new Promise<SearchResponse>((_resolve, reject) => {
        calls += 1;
        const abort = (): void => reject(new Error('provider observed abort'));
        if (context.signal?.aborted) abort();
        else context.signal?.addEventListener('abort', abort, { once: true });
      })),
    };
    const runtime = new WebRetrievalRuntime({
      runId: 'total-timeout',
      policy: policy({ totalTimeoutMs: 5, searchTimeoutMs: 1_000, maxQueriesPerRun: 2 }),
      providers: new SearchProviderRegistry([provider]),
    });
    try {
      await expect(runtime.search({ query: 'valid', maxResults: 1, runId: 'ignored' }))
        .rejects.toMatchObject({ kind: 'web_partial' });
      await expect(runtime.search({ query: 'again', maxResults: 1, runId: 'ignored' }))
        .rejects.toMatchObject({ kind: 'web_partial' });
      expect(calls).toBe(1);
    } finally {
      runtime.dispose();
    }
  });

  it('isolates query quota, provider runId and citation namespace across runs', async () => {
    const observedRunIds: string[] = [];
    const provider: SearchProvider = {
      id: 'fake',
      displayName: 'Fake',
      capabilities: { search: true, recency: true, domains: true, language: true, citations: true },
      async search(request, context) {
        observedRunIds.push(request.runId);
        return response(request, context);
      },
    };
    const providers = new SearchProviderRegistry([provider]);
    const first = new WebRetrievalRuntime({ runId: 'run-first', policy: policy(), providers });
    const second = new WebRetrievalRuntime({ runId: 'run-second', policy: policy(), providers });
    try {
      const firstResponse = await first.search({ query: ' current facts ', maxResults: 1, runId: 'spoofed' });
      await expect(first.search({ query: 'again', maxResults: 1, runId: 'spoofed' }))
        .rejects.toMatchObject({ kind: 'web_partial' });
      const secondResponse = await second.search({ query: 'current facts', maxResults: 1, runId: 'spoofed' });

      expect(observedRunIds).toEqual(['run-first', 'run-second']);
      expect(firstResponse.results[0]?.citationId).not.toBe(secondResponse.results[0]?.citationId);
      expect(first.evidence()).toMatchObject({ citationCount: 1, completeness: 'partial' });
      expect(second.evidence()).toMatchObject({ citationCount: 1, completeness: 'complete' });
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('binds a search-result citation to its canonical URL before opening an HTTP request', async () => {
    const request = vi.fn(async () => {
      throw new Error('HTTP request must not be attempted for a mismatched citation');
    });
    const provider: SearchProvider = {
      id: 'fake',
      displayName: 'Fake',
      capabilities: { search: true, recency: true, domains: true, language: true, citations: true },
      async search(searchRequest, context) { return response(searchRequest, context); },
    };
    const runtime = new WebRetrievalRuntime({
      runId: 'citation-url-binding',
      policy: policy({ cacheEnabled: false }),
      providers: new SearchProviderRegistry([provider]),
      fetchService: new WebFetchService({ policy: policy({ cacheEnabled: false }), httpClient: { request } }),
    });
    try {
      const search = await runtime.search({ query: 'current facts', maxResults: 1, runId: 'ignored' });
      await expect(runtime.fetch({
        url: 'https://93.184.216.34/unrelated',
        citationId: search.results[0]!.citationId,
      })).rejects.toMatchObject({ kind: 'web_citation_invalid' });

      expect(request).not.toHaveBeenCalled();
      expect(runtime.evidence()).toMatchObject({
        documentCount: 0,
        partial: true,
        errorKinds: ['web_citation_invalid'],
      });
    } finally {
      runtime.dispose();
    }
  });

  it('projects bounded citation metadata while redacting credential-like URL queries', async () => {
    const signedUrl = `${PUBLIC_URL}?token=fixture-secret`;
    const body = Buffer.from('body must remain run-local');
    const fetchService = new WebFetchService({
      policy: policy({ cacheEnabled: false }),
      httpClient: {
        request: vi.fn(async () => ({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body,
          bytesReceived: body.length,
          decompressedBytes: body.length,
        })),
      },
    });
    const runtime = new WebRetrievalRuntime({
      runId: 'citation-projection', policy: policy({ cacheEnabled: false }),
      providers: new SearchProviderRegistry(), fetchService,
    });
    try {
      const fetched = await runtime.fetch({ url: signedUrl });
      const projection = runtime.evidence();
      expect(projection.citationIds).toEqual([fetched.citationId]);
      expect(projection.citations?.[0]).toMatchObject({
        id: fetched.citationId,
        origin: 'https://93.184.216.34',
        urlHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        status: 'fetched',
      });
      expect(projection.citations?.[0]?.url).toBeUndefined();
      const durable = JSON.stringify(projection);
      expect(durable).not.toContain('fixture-secret');
      expect(durable).not.toContain('body must remain run-local');
    } finally {
      runtime.dispose();
    }
  });

  it('shares only the cache while keeping fetch quota and direct-fetch citations per run', async () => {
    const get = vi.fn(async () => cachedDocument());
    const cache: WebCache = {
      get,
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      stats: () => ({ entries: 1, bytes: 100, hits: get.mock.calls.length, misses: 0 }),
    };
    const providers = new SearchProviderRegistry();
    const first = new WebRetrievalRuntime({ runId: 'fetch-first', policy: policy(), providers, cache });
    const second = new WebRetrievalRuntime({ runId: 'fetch-second', policy: policy(), providers, cache });
    try {
      const firstDocument = await first.fetch({ url: PUBLIC_URL });
      await expect(first.fetch({ url: PUBLIC_URL })).rejects.toMatchObject({ kind: 'web_partial' });
      const secondDocument = await second.fetch({ url: PUBLIC_URL });

      expect(get).toHaveBeenCalledTimes(2);
      expect(firstDocument.cached).toBe(true);
      expect(secondDocument.cached).toBe(true);
      expect(firstDocument.citationId).not.toBe(secondDocument.citationId);
      expect(first.evidence()).toMatchObject({ documentCount: 1, cached: true, partial: true });
      expect(second.evidence()).toMatchObject({ documentCount: 1, cached: true, partial: false });
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('enforces the per-run concurrency envelope', async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const provider: SearchProvider = {
      id: 'fake',
      displayName: 'Fake',
      capabilities: { search: true, recency: true, domains: true, language: true, citations: true },
      async search(request, context) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return response(request, context);
      },
    };
    const runtime = new WebRetrievalRuntime({
      runId: 'concurrency-run',
      policy: policy({ maxQueriesPerRun: 2, maxConcurrentRequests: 1 }),
      providers: new SearchProviderRegistry([provider]),
    });
    try {
      const first = runtime.search({ query: 'first', maxResults: 1, runId: 'ignored' });
      const second = runtime.search({ query: 'second', maxResults: 1, runId: 'ignored' });
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      releases.shift()!();
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      releases.shift()!();
      await Promise.all([first, second]);
      expect(maxActive).toBe(1);
    } finally {
      runtime.dispose();
    }
  });

  it('cancels in-flight work with the parent run and rejects use after disposal', async () => {
    const parent = new AbortController();
    const provider: SearchProvider = {
      id: 'fake',
      displayName: 'Fake',
      capabilities: { search: true, recency: true, domains: true, language: true, citations: true },
      async search(_request, context) {
        return await new Promise<SearchResponse>((_resolve, reject) => {
          const abort = (): void => reject(new Error('provider observed abort'));
          if (context.signal?.aborted) abort();
          else context.signal?.addEventListener('abort', abort, { once: true });
        });
      },
    };
    const runtime = new WebRetrievalRuntime({
      runId: 'cancel-run',
      policy: policy(),
      providers: new SearchProviderRegistry([provider]),
      signal: parent.signal,
    });
    const running = runtime.search({ query: 'wait', maxResults: 1, runId: 'ignored' });
    parent.abort();
    await expect(running).rejects.toMatchObject({ kind: 'web_fetch_cancelled' });
    runtime.dispose();
    await expect(runtime.search({ query: 'after', maxResults: 1, runId: 'ignored' }))
      .rejects.toMatchObject({ kind: 'web_fetch_cancelled' });
  });
});
