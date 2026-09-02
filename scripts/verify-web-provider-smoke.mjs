import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildProviderRegistry, createPolicyHostResolver, validatePublicUrl, WebRetrievalRuntime } from '../packages/web/dist/index.js';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);

/**
 * Live Tavily acceptance runner. It intentionally has no write access to the
 * application data root and never prints the resolved secret or raw provider
 * response. Without --require-live, an absent key is a successful skip, not a
 * claim that the live provider is ready.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'littlesheep-web-smoke-'));
  const counters = { providerRequests: 0, disabledRequests: 0 };
  const key = process.env.LS_TAVILY_API_KEY?.trim() || process.env.TAVILY_API_KEY?.trim() || '';
  let stage = 'setup';
  try {
    if (!key) {
      print({ check: 'setup', status: 'skipped', ok: false, reason: 'TAVILY_API_KEY or LS_TAVILY_API_KEY is not configured', isolated: true });
      return args.requireLive ? 1 : 0;
    }

    const fetchFn = async (...input) => {
      counters.providerRequests += 1;
      return fetch(...input);
    };
    const built = await buildProviderRegistry({
      providers: [{ id: 'tavily', type: 'tavily-search-v1', apiKeyRef: '$SMOKE_TAVILY_KEY' }],
      defaultProvider: 'tavily',
      secretResolver: { resolve: async () => key },
      fetchFn,
    });
    if (built.snapshots[0]?.status !== 'configured_unchecked') {
      print({ check: 'provider-config', status: 'failed', ok: false, providerStatus: built.snapshots[0]?.status ?? 'missing', isolated: true });
      return 1;
    }

    const policy = {
      version: 1,
      enabled: true,
      providerId: 'tavily',
      mode: 'public_anonymous',
      dnsResolver: args.dnsResolver,
      allowDomains: [],
      blockDomains: [],
      strictReadApproval: false,
      maxResults: Math.min(args.maxResults, 20),
      maxQueryChars: 2_000,
      maxQueriesPerRun: 2,
      maxFetchesPerRun: 2,
      maxConcurrentRequests: 2,
      searchTimeoutMs: args.timeoutMs,
      fetchTimeoutMs: args.timeoutMs,
      totalTimeoutMs: Math.max(args.timeoutMs * 3, 10_000),
      maxResponseBytes: 2 * 1024 * 1024,
      maxExtractedChars: 40_000,
      maxRedirects: 5,
      cacheEnabled: false,
      cacheTtlSeconds: 0,
      cacheMaxBytes: 0,
      browserFallback: 'disabled',
      sensitiveQueryPolicy: 'deny',
    };

    stage = 'disabled-zero-request';
    const disabledRuntime = new WebRetrievalRuntime({
      runId: 'web-smoke-disabled',
      policy: { ...policy, enabled: false, mode: 'disabled', maxQueriesPerRun: 0, maxFetchesPerRun: 0 },
      providers: built.registry,
      log: () => undefined,
    });
    try {
      await disabledRuntime.search({ query: args.query, maxResults: 1, runId: 'ignored' });
      throw new Error('disabled retrieval unexpectedly succeeded');
    } catch (error) {
      const kind = error?.kind;
      if (kind !== 'web_disabled') throw error;
    } finally {
      disabledRuntime.dispose();
    }
    counters.disabledRequests = counters.providerRequests;
    print({ check: 'disabled-zero-request', status: counters.disabledRequests === 0 ? 'passed' : 'failed', ok: counters.disabledRequests === 0, requests: counters.disabledRequests });
    if (counters.disabledRequests !== 0) return 1;

    stage = 'public-fetch-preflight';
    const preflightResolver = createPolicyHostResolver(policy);
    await validatePublicUrl('https://example.com/', { policy, resolveHost: preflightResolver });
    print({ check: 'public-fetch-preflight', status: 'passed', ok: true, dnsResolver: args.dnsResolver, providerRequests: counters.providerRequests });

    const runtime = new WebRetrievalRuntime({ runId: `web-smoke-${Date.now()}`, policy, providers: built.registry, log: () => undefined });
    try {
      stage = 'search';
      const search = await runtime.search({ query: args.query, maxResults: args.maxResults, runId: 'ignored' });
      if (search.results.length === 0) throw new Error('Tavily returned no normalized search results');
      print({ check: 'search', status: 'passed', ok: true, provider: search.provider, resultCount: search.results.length, cached: search.cached, partial: search.partial });

      stage = 'public-fetch-and-citation';
      // This acceptance must fetch the exact normalized Tavily result whose citation it presents.
      const fetched = await runtime.fetch({ url: search.results[0].url, purpose: 'verification', citationId: search.results[0].citationId });
      const evidence = runtime.evidence();
      const citationFound = evidence.citationIds.includes(fetched.citationId ?? '');
      const contentSafe = fetched.document.externalUntrusted === true && fetched.document.content.length <= policy.maxExtractedChars;
      print({ check: 'public-fetch-and-citation', status: citationFound && contentSafe ? 'passed' : 'failed', ok: citationFound && contentSafe, requestedOrigin: new URL(fetched.document.requestedUrl).origin, finalOrigin: new URL(fetched.document.finalUrl).origin, statusCode: fetched.document.status, truncated: fetched.document.truncated, citationCount: evidence.citationCount, completeness: evidence.completeness });
      if (!citationFound || !contentSafe) return 1;
      print({ check: 'summary', status: 'passed', ok: true, providerRequests: counters.providerRequests, isolated: true });
      return 0;
    } finally {
      runtime.dispose();
    }
  } catch (error) {
    const errorKind = reportErrorKind(error);
    print({ check: 'live-smoke', stage, status: smokeFailureStatus(errorKind), ok: false, errorKind, providerRequests: counters.providerRequests, isolated: true });
    return 1;
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const values = new Map();
  let forwardedSeparator = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--') {
      if (forwardedSeparator || index !== 0 || index === argv.length - 1) {
        throw new Error('web provider smoke accepts at most one leading argument separator');
      }
      forwardedSeparator = true;
      continue;
    }
    if (!item?.startsWith('--')) throw new Error('web provider smoke accepts only named arguments');
    const equals = item.indexOf('=');
    const name = equals > 2 ? item.slice(2, equals) : item.slice(2);
    const value = equals > 2 ? item.slice(equals + 1) : argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : 'true';
    if (!['query', 'timeout-ms', 'max-results', 'dns-resolver', 'require-live'].includes(name) || values.has(name)) {
      throw new Error('web provider smoke argument is invalid');
    }
    if (name === 'require-live' && value !== 'true') throw new Error('require-live does not accept a value');
    if (name !== 'require-live' && (value === 'true' || value.length > 2_000)) {
      throw new Error('web provider smoke argument is invalid');
    }
    values.set(name, value);
  }
  const timeoutMs = Number(values.get('timeout-ms') ?? 20_000);
  const maxResults = Number(values.get('max-results') ?? 3);
  const dnsResolver = values.get('dns-resolver') ?? 'system';
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error('timeout-ms must be an integer from 1000 to 120000');
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) throw new Error('max-results must be an integer from 1 to 20');
  if (dnsResolver !== 'system' && dnsResolver !== 'cloudflare_doh') throw new Error('dns-resolver must be system or cloudflare_doh');
  return { query: String(values.get('query') ?? 'LittleSheep realtime web retrieval'), timeoutMs, maxResults, dnsResolver, requireLive: values.has('require-live') };
}

function reportErrorKind(error) {
  const kind = typeof error?.kind === 'string' ? error.kind : '';
  return /^web_[a-z0-9_]+$/u.test(kind) ? kind : 'unexpected_failure';
}

function smokeFailureStatus(errorKind) {
  return errorKind === 'web_ssrf_blocked' || errorKind === 'web_dns_check_failed'
    ? 'blocked'
    : 'failed';
}

function print(value) { console.log(JSON.stringify(value)); }

main().then((code) => { process.exitCode = code; }).catch((error) => {
  print({ check: 'setup', status: 'failed', ok: false, errorKind: reportErrorKind(error) });
  process.exitCode = 1;
});
