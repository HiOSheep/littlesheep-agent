import { describe, expect, it, vi } from 'vitest';
import type { NetworkReadPolicy, SearchRequest } from '@littlesheep/types';
import { TavilySearchProvider } from './tavily.js';

const API_KEY = 'tvly-fixture-secret-key';

function policy(): NetworkReadPolicy {
  return {
    version: 1,
    enabled: true,
    providerId: 'primary-search',
    mode: 'public_anonymous',
    allowDomains: [], blockDomains: [], strictReadApproval: false,
    maxResults: 5, maxQueryChars: 200, maxQueriesPerRun: 2, maxFetchesPerRun: 2,
    maxConcurrentRequests: 2, searchTimeoutMs: 1_000, fetchTimeoutMs: 1_000,
    totalTimeoutMs: 5_000, maxResponseBytes: 64 * 1024, maxExtractedChars: 4_000,
    maxRedirects: 2, cacheEnabled: false, cacheTtlSeconds: 0, cacheMaxBytes: 0,
    browserFallback: 'disabled', sensitiveQueryPolicy: 'deny',
  };
}

function request(): SearchRequest {
  return {
    query: 'current docs',
    domains: ['example.com'],
    excludeDomains: ['old.example.com'],
    recency: 'week',
    language: 'zh-CN',
    maxResults: 3,
    runId: 'run-1',
  };
}

describe('TavilySearchProvider', () => {
  it('sends only fixed discovery fields and preserves the configured provider identity', async () => {
    let observedInit: RequestInit | undefined;
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      observedInit = init;
      return new Response(JSON.stringify({
        request_id: `request-${API_KEY}`,
        results: [{
          title: `Bearer ${API_KEY}`,
          url: 'https://example.com/current?access_token=url-fixture-token&page=1',
          content: `public result accidentally echoed ${API_KEY}`,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const provider = new TavilySearchProvider({ providerId: 'primary-search', apiKey: API_KEY, fetchFn: fetchFn as typeof fetch });

    const result = await provider.search(request(), { policy: policy() });
    const body = JSON.parse(String(observedInit?.body)) as Record<string, unknown>;
    expect(observedInit?.method).toBe('POST');
    expect(observedInit?.headers).toMatchObject({ authorization: `Bearer ${API_KEY}` });
    expect(body).toMatchObject({
      query: 'current docs', max_results: 3, include_answer: false,
      include_raw_content: false, auto_parameters: false,
      include_domains: ['example.com'], exclude_domains: ['old.example.com'], time_range: 'week',
    });
    expect(body).not.toHaveProperty('country');
    expect(result.provider).toBe('primary-search');
    expect(result.results[0]!.url).toBe('https://example.com/current?page=1');
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(result.partial).toBe(true);
  });

  it.each([401, 403, 429, 500])('returns bounded redacted HTTP %s errors', async (status) => {
    const fetchFn = vi.fn(async () => new Response(`Authorization: Bearer ${API_KEY}`, {
      status,
      headers: { 'retry-after': '2' },
    }));
    const provider = new TavilySearchProvider({ providerId: 'primary-search', apiKey: API_KEY, fetchFn: fetchFn as typeof fetch });

    const caught = await provider.search(request(), { policy: policy() }).catch((error: unknown) => error);
    expect(caught).toMatchObject({ providerId: 'primary-search', httpStatus: status });
    if (status === 401 || status === 403) expect(caught).toMatchObject({ kind: 'web_provider_auth_failed', retryable: false });
    if (status === 429) expect(caught).toMatchObject({ kind: 'web_provider_rate_limited', retryable: true, retryAfterMs: 2_000 });
    if (status === 500) expect(caught).toMatchObject({ kind: 'web_provider_unavailable', retryable: true });
    expect(JSON.stringify(caught)).not.toContain(API_KEY);
    expect(String(caught)).not.toContain(API_KEY);
  });

  it('does not retain transport errors that may contain endpoint or key data', async () => {
    const fetchFn = vi.fn(async () => { throw new Error(`failed https://api.tavily.com/search?key=${API_KEY}`); });
    const provider = new TavilySearchProvider({ providerId: 'primary-search', apiKey: API_KEY, fetchFn: fetchFn as typeof fetch });

    const caught = await provider.search(request(), { policy: policy() }).catch((error: unknown) => error);
    expect(caught).toMatchObject({ kind: 'web_provider_unavailable', providerId: 'primary-search' });
    expect(JSON.stringify(caught)).not.toContain(API_KEY);
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('discards a provider result URL that contains resolved secret material', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: 'unsafe result', url: `https://example.com/${API_KEY}/page`, content: 'text' }],
    }), { status: 200 }));
    const provider = new TavilySearchProvider({ providerId: 'primary-search', apiKey: API_KEY, fetchFn: fetchFn as typeof fetch });

    const result = await provider.search(request(), { policy: policy() });
    expect(result.results).toEqual([]);
    expect(result.partial).toBe(true);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it.each([
    'http://api.tavily.com/search',
    'https://example.com/search',
    'https://api.tavily.com/search?key=secret',
    'https://user:pass@api.tavily.com/search',
  ])('rejects unapproved provider endpoint %s', (baseURL) => {
    expect(() => new TavilySearchProvider({ apiKey: API_KEY, baseURL })).toThrow(/endpoint|HTTPS|credentials/u);
  });
});
