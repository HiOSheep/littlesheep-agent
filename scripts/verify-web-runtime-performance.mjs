import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MemoryWebCache,
  SearchProviderRegistry,
  WebFetchService,
  WebRetrievalRuntime,
} from '../packages/web/dist/index.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const iterations = 48;
const publicUrl = 'https://93.184.216.34/web-runtime-performance';
const body = Buffer.from(`<html><title>Performance fixture</title><body>${'bounded public content '.repeat(800)}</body></html>`);
const budgets = {
  maxTotalMs: 15_000,
  maxP95RunMs: 250,
  maxHeapDeltaBytes: 32 * 1024 * 1024,
  maxCacheBytes: 512 * 1024,
  expectedProviderCalls: iterations,
  expectedHttpCalls: 1,
};

/**
 * Local-only runtime baseline. Fake provider and HTTP client exercise the
 * normal quota, citation, extraction and cache path without external egress.
 */
async function main() {
  let providerCalls = 0;
  let httpCalls = 0;
  const cache = new MemoryWebCache(budgets.maxCacheBytes, 60_000);
  const provider = {
    id: 'performance',
    displayName: 'Performance fixture provider',
    capabilities: { search: true, recency: false, domains: false, language: false, citations: true },
    async search(request, context) {
      providerCalls += 1;
      return {
        version: 1,
        provider: 'performance',
        query: request.query,
        results: [{
          rank: 1,
          title: 'Performance fixture',
          url: publicUrl,
          canonicalUrl: publicUrl,
          citationId: context.citationIdFor(publicUrl, 1),
          sourceStatus: 'search_result',
        }],
        fetchedAt: new Date().toISOString(),
        cached: false,
        partial: false,
        warnings: [],
      };
    },
  };
  const providers = new SearchProviderRegistry([provider]);
  const policy = {
    version: 1,
    enabled: true,
    providerId: 'performance',
    mode: 'public_anonymous',
    allowDomains: [], blockDomains: [], strictReadApproval: false,
    maxResults: 1, maxQueryChars: 256, maxQueriesPerRun: 1, maxFetchesPerRun: 1,
    maxConcurrentRequests: 1, searchTimeoutMs: 1_000, fetchTimeoutMs: 1_000,
    totalTimeoutMs: 3_000, maxResponseBytes: 64 * 1024, maxExtractedChars: 32_000,
    maxRedirects: 0, cacheEnabled: true, cacheTtlSeconds: 60, cacheMaxBytes: budgets.maxCacheBytes,
    browserFallback: 'disabled', sensitiveQueryPolicy: 'deny',
  };
  const httpClient = {
    async request() {
      httpCalls += 1;
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body,
        bytesReceived: body.length,
        decompressedBytes: body.length,
      };
    },
  };
  const heapBefore = process.memoryUsage().heapUsed;
  const samples = [];
  const startedAt = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    const runtime = new WebRetrievalRuntime({
      runId: `web-performance-${index}`,
      policy,
      providers,
      cache,
      fetchService: new WebFetchService({
        policy,
        cache,
        httpClient,
        resolveHost: async () => ['93.184.216.34'],
      }),
    });
    const runStartedAt = performance.now();
    try {
      const search = await runtime.search({ query: `current web fixture ${index}`, maxResults: 1, runId: 'spoofed' });
      const fetched = await runtime.fetch({ url: publicUrl, citationId: search.results[0]?.citationId });
      const evidence = runtime.evidence();
      assert(fetched.externalUntrusted === true, 'fetched document lost external-untrusted envelope');
      assert(evidence.citationCount === 1 && evidence.documentCount === 1, 'runtime evidence was incomplete');
      assert(!JSON.stringify(evidence).includes('bounded public content'), 'durable evidence contains page content');
    } finally {
      runtime.dispose();
    }
    samples.push(performance.now() - runStartedAt);
  }

  const totalMs = performance.now() - startedAt;
  const heapAfter = process.memoryUsage().heapUsed;
  const sorted = [...samples].sort((left, right) => left - right);
  const p95RunMs = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
  const cacheStats = cache.stats();
  const results = {
    totalMs: round(totalMs),
    p95RunMs: round(p95RunMs),
    heapDeltaBytes: heapAfter - heapBefore,
    providerCalls,
    httpCalls,
    cache: cacheStats,
  };
  const assertions = {
    totalDuration: results.totalMs <= budgets.maxTotalMs,
    p95Run: results.p95RunMs <= budgets.maxP95RunMs,
    heapTrend: results.heapDeltaBytes <= budgets.maxHeapDeltaBytes,
    cacheBounded: cacheStats.bytes <= budgets.maxCacheBytes,
    providerCalls: providerCalls === budgets.expectedProviderCalls,
    sharedCache: httpCalls === budgets.expectedHttpCalls && cacheStats.hits === iterations - 1,
  };
  const ok = Object.values(assertions).every(Boolean);
  print({
    check: 'web-runtime-performance',
    status: ok ? 'passed' : 'failed',
    ok,
    isolated: true,
    externalNetworkRequests: 0,
    iterations,
    budgets,
    results,
    assertions,
  });
  return ok ? 0 : 1;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function round(value) { return Math.round(value * 100) / 100; }
function print(value) { console.log(JSON.stringify(value)); }

main().then((code) => { process.exitCode = code; }).catch((error) => {
  print({ check: 'web-runtime-performance', status: 'failed', ok: false, errorKind: error?.name || 'Error' });
  process.exitCode = 1;
});
