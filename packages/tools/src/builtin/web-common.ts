import { createHash } from 'node:crypto';
import type {
  AgentTool,
  ToolContext,
  WebErrorKind,
  WebEvidenceProjection,
} from '@littlesheep/types';
import { classifySensitiveWebQuery } from '@littlesheep/safety';

const WEB_ERROR_KINDS = new Set<WebErrorKind>([
  'web_disabled', 'web_provider_unconfigured', 'web_provider_auth_failed',
  'web_provider_rate_limited', 'web_provider_unavailable', 'web_provider_invalid_response',
  'web_invalid_query', 'web_sensitive_query_blocked', 'web_url_invalid',
  'web_scheme_blocked', 'web_ssrf_blocked', 'web_dns_check_failed',
  'web_redirect_blocked', 'web_fetch_timeout', 'web_fetch_cancelled',
  'web_response_too_large', 'web_content_unsupported', 'web_extraction_failed',
  'web_cache_unavailable', 'web_partial', 'web_citation_invalid',
]);

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function webSearchInputProjection(input: unknown): Record<string, unknown> {
  const record = asRecord(input);
  const query = typeof record.query === 'string' ? record.query : '';
  const sensitive = classifySensitiveWebQuery(query);
  return {
    queryHash: sha256(query),
    queryChars: query.length,
    sensitiveQuery: sensitive.sensitive,
    sensitiveCategories: sensitive.categories,
    domainCount: Array.isArray(record.domains) ? record.domains.length : 0,
    excludeDomainCount: Array.isArray(record.excludeDomains) ? record.excludeDomains.length : 0,
    ...(typeof record.recency === 'string' ? { recency: record.recency } : {}),
    ...(typeof record.language === 'string' ? { language: record.language } : {}),
    ...(typeof record.maxResults === 'number' ? { maxResults: record.maxResults } : {}),
  };
}

export function webFetchInputProjection(input: unknown): Record<string, unknown> {
  const record = asRecord(input);
  const url = typeof record.url === 'string' ? record.url : '';
  return {
    url: safeUrlOrigin(url),
    urlHash: sha256(url),
    ...(typeof record.citationId === 'string' ? { citationId: boundedText(record.citationId, 200) } : {}),
    ...(typeof record.maxChars === 'number' ? { maxChars: record.maxChars } : {}),
    ...(typeof record.purpose === 'string' ? { purpose: record.purpose } : {}),
  };
}

export function webExecution(toolName: 'web_search' | 'web_fetch'): NonNullable<AgentTool['execution']> {
  return {
    concurrency: 'parallel',
    resources(input, ctx) {
      const suffix = toolName === 'web_search'
        ? ctx.networkPolicy?.providerId ?? 'unconfigured'
        : sha256(String(asRecord(input).url ?? 'invalid'));
      return [{ key: `web:${toolName}:${suffix}`, mode: 'read' }];
    },
  };
}

export async function recordWebEvidence(
  ctx: ToolContext,
  projection: WebEvidenceProjection,
): Promise<void> {
  try {
    await ctx.webEvidenceSink?.record(structuredClone(projection));
  } catch {
    ctx.log?.('warn', 'web evidence observer failed', { kind: 'web_partial' });
  }
}

export function adjustedProjection(
  projection: WebEvidenceProjection,
  partial: boolean,
): WebEvidenceProjection {
  if (!partial) return structuredClone(projection);
  return {
    ...structuredClone(projection),
    completeness: projection.citationCount > 0 ? 'partial' : 'none',
    partial: true,
    truncated: true,
  };
}

export function webFailure(error: unknown): { ok: false; error: string; meta: { errorKind: WebErrorKind } } {
  const candidate = error && typeof error === 'object' && 'kind' in error
    ? (error as { kind?: unknown }).kind
    : undefined;
  const kind = typeof candidate === 'string' && WEB_ERROR_KINDS.has(candidate as WebErrorKind)
    ? candidate as WebErrorKind
    : 'web_provider_unavailable';
  return { ok: false, error: webErrorMessage(kind), meta: { errorKind: kind } };
}

export function boundedText(value: string, maxChars: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maxChars);
}

export function hasValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function safeUrlOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.username = '';
    url.password = '';
    return `${url.protocol}//${url.host}/`;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function webErrorMessage(kind: WebErrorKind): string {
  switch (kind) {
    case 'web_disabled': return 'Public network retrieval is disabled.';
    case 'web_provider_unconfigured': return 'No configured web search provider is available.';
    case 'web_provider_auth_failed': return 'The web search provider rejected its configured credential.';
    case 'web_provider_rate_limited': return 'The web search provider rate limit was reached.';
    case 'web_invalid_query': return 'The web search query is invalid or outside the configured limit.';
    case 'web_sensitive_query_blocked': return 'The web search query contains sensitive data and was not allowed to leave the device.';
    case 'web_url_invalid': return 'The web URL or fetch limit is invalid.';
    case 'web_scheme_blocked': return 'The web URL scheme is blocked.';
    case 'web_ssrf_blocked': return 'The web target was blocked by the public-network safety policy.';
    case 'web_dns_check_failed': return 'The web target could not be proven to resolve to a public address.';
    case 'web_redirect_blocked': return 'The web redirect was blocked.';
    case 'web_fetch_timeout': return 'The web fetch timed out.';
    case 'web_fetch_cancelled': return 'The web retrieval was cancelled.';
    case 'web_response_too_large': return 'The web response exceeded the configured limit.';
    case 'web_content_unsupported': return 'The web content type is unsupported.';
    case 'web_extraction_failed': return 'No readable web content could be extracted.';
    case 'web_cache_unavailable': return 'The web cache is unavailable.';
    case 'web_citation_invalid': return 'The citation does not match the requested web URL.';
    case 'web_provider_invalid_response': return 'The web search provider returned an invalid response.';
    case 'web_partial': return 'The web retrieval limit was reached before the request could complete.';
    default: return 'Web retrieval failed.';
  }
}
