import { buildProviderRegistry, WebRetrievalRuntime } from '../packages/web/dist/index.js';

const policy = {
  version: 1,
  enabled: true,
  mode: 'public_anonymous',
  dnsResolver: 'system',
  allowDomains: [],
  blockDomains: [],
  strictReadApproval: false,
  maxResults: 1,
  maxQueryChars: 2_000,
  maxQueriesPerRun: 0,
  maxFetchesPerRun: 1,
  maxConcurrentRequests: 1,
  searchTimeoutMs: 10_000,
  fetchTimeoutMs: 15_000,
  totalTimeoutMs: 20_000,
  maxResponseBytes: 1 * 1024 * 1024,
  maxExtractedChars: 4_000,
  maxRedirects: 3,
  cacheEnabled: false,
  cacheTtlSeconds: 0,
  cacheMaxBytes: 0,
  browserFallback: 'disabled',
  sensitiveQueryPolicy: 'deny',
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { registry } = await buildProviderRegistry();
  const runtime = new WebRetrievalRuntime({
    runId: 'web-fetch-public-smoke',
    policy: { ...policy, dnsResolver: args.dnsResolver },
    providers: registry,
  });
  try {
    const document = await runtime.fetch({
      url: args.url,
      purpose: 'verification',
    });
    const evidence = runtime.evidence();
    const result = {
      check: 'web-fetch-public-smoke',
      status: document.status === 200 && document.externalUntrusted === true && !document.truncated && evidence.completeness === 'complete'
        ? 'passed'
        : 'failed',
      ok: document.status === 200 && document.externalUntrusted === true && !document.truncated && evidence.completeness === 'complete',
      statusCode: document.status,
      finalOrigin: new URL(document.finalUrl).origin,
      extractor: document.extractor,
      externalUntrusted: document.externalUntrusted,
      truncated: document.truncated,
      contentChars: document.content.length,
      contentHash: document.contentHash,
      citationCount: evidence.citationCount,
      completeness: evidence.completeness,
    };
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } finally {
    runtime.dispose();
  }
}

function parseArgs(argv) {
  const values = new Map();
  let forwardedSeparator = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--') {
      if (forwardedSeparator || index !== 0 || index === argv.length - 1) {
        throw new Error('web-fetch smoke accepts at most one leading argument separator');
      }
      forwardedSeparator = true;
      continue;
    }
    if (!item?.startsWith('--')) throw new Error('web-fetch smoke accepts only named arguments');
    const equals = item.indexOf('=');
    const name = equals > 2 ? item.slice(2, equals) : item.slice(2);
    const value = equals > 2 ? item.slice(equals + 1) : argv[++index];
    if ((name !== 'url' && name !== 'dns-resolver') || !value || value.startsWith('--')) throw new Error('web-fetch smoke accepts only --url=<public-http-url> or --dns-resolver=<mode>');
    if (values.has(name) || value.length > 4_096) throw new Error('web-fetch smoke URL argument is invalid');
    values.set(name, value);
  }
  const dnsResolver = values.get('dns-resolver') ?? 'system';
  if (dnsResolver !== 'system' && dnsResolver !== 'cloudflare_doh') throw new Error('dns-resolver must be system or cloudflare_doh');
  return { url: values.get('url') ?? 'https://example.com/', dnsResolver };
}

main().catch((error) => {
  const errorKind = reportErrorKind(error);
  console.log(JSON.stringify({
    check: 'web-fetch-public-smoke',
    status: smokeFailureStatus(errorKind),
    ok: false,
    errorKind,
  }));
  process.exitCode = 1;
});

function reportErrorKind(error) {
  const kind = typeof error?.kind === 'string' ? error.kind : '';
  return /^web_[a-z0-9_]+$/u.test(kind) ? kind : 'unexpected_failure';
}

function smokeFailureStatus(errorKind) {
  return errorKind === 'web_ssrf_blocked' || errorKind === 'web_dns_check_failed'
    ? 'blocked'
    : 'failed';
}
