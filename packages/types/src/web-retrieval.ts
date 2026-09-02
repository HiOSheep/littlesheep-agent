// @littlesheep/types — serializable contracts for safe web retrieval.

export const WEB_RETRIEVAL_CONTRACT_VERSION = 1 as const;

export type NetworkReadMode = 'disabled' | 'public_anonymous' | 'configured_allowlist';
export type NetworkDnsResolver = 'system' | 'cloudflare_doh';
export type BrowserFallbackMode = 'disabled' | 'approval_required' | 'full_only';
export type SensitiveQueryPolicy = 'allow' | 'redact' | 'approve' | 'deny';
export type RetrievalCompleteness = 'complete' | 'partial' | 'none';
export type SearchRecency = 'today' | 'week' | 'month' | 'year' | 'custom';
export type SearchResultSourceStatus = 'search_result' | 'cached_result' | 'partial';
export type WebCitationStatus = 'search_result' | 'fetched' | 'cached' | 'blocked' | 'partial';
export type WebExtractorKind = 'readability' | 'markdown' | 'plain_text' | 'json' | 'none';
export type WebFetchPurpose = 'user_url' | 'search_followup' | 'verification';

export type WebErrorKind =
  | 'web_disabled'
  | 'web_provider_unconfigured'
  | 'web_provider_auth_failed'
  | 'web_provider_rate_limited'
  | 'web_provider_unavailable'
  | 'web_provider_invalid_response'
  | 'web_invalid_query'
  | 'web_sensitive_query_blocked'
  | 'web_url_invalid'
  | 'web_scheme_blocked'
  | 'web_ssrf_blocked'
  | 'web_dns_check_failed'
  | 'web_redirect_blocked'
  | 'web_fetch_timeout'
  | 'web_fetch_cancelled'
  | 'web_response_too_large'
  | 'web_content_unsupported'
  | 'web_extraction_failed'
  | 'web_cache_unavailable'
  | 'web_partial'
  | 'web_citation_invalid';

/** Immutable per-run limits resolved before a model or tool can request network access. */
export interface NetworkReadPolicy {
  readonly version: typeof WEB_RETRIEVAL_CONTRACT_VERSION;
  readonly enabled: boolean;
  readonly providerId?: string;
  readonly mode: NetworkReadMode;
  readonly allowDomains: readonly string[];
  readonly blockDomains: readonly string[];
  /** Legacy/missing values use system DNS. Trusted DoH is an explicit user-selected egress mode. */
  readonly dnsResolver?: NetworkDnsResolver;
  readonly strictReadApproval: boolean;
  readonly maxResults: number;
  readonly maxQueryChars: number;
  readonly maxQueriesPerRun: number;
  readonly maxFetchesPerRun: number;
  readonly maxConcurrentRequests: number;
  readonly searchTimeoutMs: number;
  readonly fetchTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxExtractedChars: number;
  readonly maxRedirects: number;
  readonly cacheEnabled: boolean;
  readonly cacheTtlSeconds: number;
  readonly cacheMaxBytes: number;
  readonly browserFallback: BrowserFallbackMode;
  readonly sensitiveQueryPolicy: SensitiveQueryPolicy;
}

export interface SearchProviderCapabilities {
  readonly search: boolean;
  readonly recency: boolean;
  readonly domains: boolean;
  readonly language: boolean;
  readonly citations: boolean;
}

export type WebProviderRuntimeStatus =
  | 'disabled'
  | 'unconfigured'
  | 'configured_unchecked'
  | 'ready'
  | 'degraded'
  | 'unavailable';

/** Redacted provider selection captured in run configuration and evidence. */
export interface WebProviderRuntimeSnapshot {
  readonly id: string;
  readonly adapterType: string;
  readonly status: WebProviderRuntimeStatus;
  readonly capabilities?: SearchProviderCapabilities;
  readonly checkedAt?: string;
  readonly detailCode?: WebErrorKind;
}

export interface ProviderHealth {
  readonly providerId: string;
  readonly status: 'healthy' | 'degraded' | 'unavailable' | 'unconfigured' | 'disabled';
  readonly checkedAt: string;
  readonly latencyMs?: number;
  readonly retryAfterMs?: number;
  readonly errorKind?: WebErrorKind;
  readonly detail?: string;
}

/** Serializable provider-neutral search input. AbortSignal belongs to the invocation context. */
export interface SearchRequest {
  readonly query: string;
  readonly domains?: readonly string[];
  readonly excludeDomains?: readonly string[];
  readonly recency?: SearchRecency;
  readonly from?: string;
  readonly to?: string;
  readonly language?: string;
  readonly maxResults: number;
  readonly runId: string;
}

export interface SearchResult {
  readonly rank: number;
  readonly title: string;
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly snippet?: string;
  readonly publishedAt?: string;
  readonly siteName?: string;
  readonly language?: string;
  readonly citationId: string;
  readonly sourceStatus: SearchResultSourceStatus;
}

export interface SearchResponse {
  readonly version: typeof WEB_RETRIEVAL_CONTRACT_VERSION;
  readonly provider: string;
  readonly query: string;
  readonly results: readonly SearchResult[];
  readonly fetchedAt: string;
  readonly cached: boolean;
  readonly partial: boolean;
  readonly providerRequestId?: string;
  readonly warnings: readonly string[];
}

/** Serializable fetch input. Method, headers, cookies, credentials and output paths are intentionally absent. */
export interface FetchRequest {
  readonly url: string;
  readonly citationId?: string;
  readonly maxChars?: number;
  readonly purpose?: WebFetchPurpose;
}

export interface FetchedDocument {
  readonly version: typeof WEB_RETRIEVAL_CONTRACT_VERSION;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
  readonly status: number;
  readonly contentType: string;
  readonly title?: string;
  readonly publishedAt?: string;
  readonly extractor: WebExtractorKind;
  readonly content: string;
  readonly contentHash: string;
  readonly fetchedAt: string;
  readonly cached: boolean;
  readonly truncated: boolean;
  readonly externalUntrusted: true;
  readonly warnings: readonly string[];
  /** Runtime-issued citation identity, including for direct URL fetches. */
  readonly citationId?: string;
}

export interface WebCitation {
  readonly id: string;
  readonly url: string;
  readonly title?: string;
  readonly provider?: string;
  readonly publishedAt?: string;
  readonly fetchedAt: string;
  readonly status: WebCitationStatus;
  readonly contentHash?: string;
  readonly truncated: boolean;
}

/** Run-local rich evidence. Persistence must use WebEvidenceProjection instead. */
export interface WebEvidenceBundle {
  readonly version: typeof WEB_RETRIEVAL_CONTRACT_VERSION;
  readonly query?: string;
  readonly citations: readonly WebCitation[];
  readonly documents?: readonly FetchedDocument[];
  readonly generatedAt: string;
  readonly completeness: RetrievalCompleteness;
  readonly conflicts?: readonly string[];
}

/** Content-free citation metadata safe for history, logs and source cards. */
export interface WebCitationProjection {
  readonly id: string;
  /** Present only when the canonical URL has no credential-like query fields. */
  readonly url?: string;
  readonly origin: string;
  readonly urlHash: string;
  readonly title?: string;
  readonly provider?: string;
  readonly publishedAt?: string;
  readonly fetchedAt: string;
  readonly status: WebCitationStatus;
  readonly contentHash?: string;
  readonly truncated: boolean;
}

/** Bounded, content-free projection safe for ToolResult, checkpoints and execution logs. */
export interface WebEvidenceProjection {
  readonly version: typeof WEB_RETRIEVAL_CONTRACT_VERSION;
  readonly providerId?: string;
  readonly generatedAt: string;
  readonly completeness: RetrievalCompleteness;
  readonly citationIds: readonly string[];
  readonly citations?: readonly WebCitationProjection[];
  readonly citationCount: number;
  readonly documentCount: number;
  readonly cached: boolean;
  readonly partial: boolean;
  readonly truncated: boolean;
  readonly blocked: boolean;
  readonly stale: boolean;
  readonly errorKinds?: readonly WebErrorKind[];
}

/** Safe plain-text fallback shared by CLI and text-only channels. */
export function formatWebEvidenceSources(evidence: WebEvidenceProjection | undefined): string {
  if (!evidence) return '';
  const hasStatus = evidence.citationCount > 0
    || evidence.partial
    || evidence.truncated
    || evidence.blocked
    || evidence.stale
    || (evidence.errorKinds?.length ?? 0) > 0;
  if (!hasStatus) return '';
  const state = [
    evidence.cached ? 'cached' : undefined,
    evidence.partial ? 'partial' : undefined,
    evidence.truncated ? 'truncated' : undefined,
    evidence.blocked ? 'blocked' : undefined,
    evidence.stale ? 'stale' : undefined,
  ].filter(Boolean).join(', ') || evidence.completeness;
  const lines = (evidence.citations ?? []).map((citation, index) => {
    const label = citation.title || citation.origin;
    const target = citation.url || citation.origin;
    return `${index + 1}. ${label} - ${target} (fetchedAt: ${citation.fetchedAt}) [citation:${citation.id}]`;
  });
  const statusLines = (evidence.errorKinds ?? []).map((kind) => `- ${webEvidenceErrorLabel(kind)}`);
  return [
    `Sources (${state}):`,
    ...(lines.length > 0 ? lines : ['No verified sources were returned.']),
    ...statusLines,
  ].join('\n');
}

function webEvidenceErrorLabel(kind: WebErrorKind): string {
  switch (kind) {
    case 'web_disabled': return 'Web retrieval is disabled.';
    case 'web_provider_unconfigured': return 'No web search provider is configured.';
    case 'web_provider_auth_failed': return 'Web search provider authentication failed.';
    case 'web_provider_rate_limited': return 'Web search provider rate limit reached.';
    case 'web_provider_unavailable': return 'Web search provider is temporarily unavailable.';
    case 'web_provider_invalid_response': return 'Web search provider returned an invalid response.';
    case 'web_invalid_query': return 'The web search query is invalid.';
    case 'web_sensitive_query_blocked': return 'The query was blocked by the privacy policy.';
    case 'web_url_invalid': return 'The requested web address is invalid.';
    case 'web_scheme_blocked': return 'The requested web address uses a blocked scheme.';
    case 'web_ssrf_blocked': return 'The requested web address was blocked by the public-network safety policy.';
    case 'web_dns_check_failed': return 'The web address could not pass DNS safety checks.';
    case 'web_redirect_blocked': return 'A web redirect was blocked by the safety policy.';
    case 'web_fetch_timeout': return 'The web page fetch timed out.';
    case 'web_fetch_cancelled': return 'The web page fetch was cancelled.';
    case 'web_response_too_large': return 'The web response exceeded the configured limit.';
    case 'web_content_unsupported': return 'The web page content format is unsupported.';
    case 'web_extraction_failed': return 'Readable web page content could not be extracted.';
    case 'web_cache_unavailable': return 'The local web cache is unavailable.';
    case 'web_partial': return 'The web retrieval result is incomplete.';
    case 'web_citation_invalid': return 'A web citation could not be verified.';
    default: return 'Web retrieval failed.';
  }
}

const WEB_CITATION_STATUSES = new Set<WebCitationStatus>([
  'search_result', 'fetched', 'cached', 'blocked', 'partial',
]);
const WEB_ERROR_KIND_SET = new Set<WebErrorKind>([
  'web_disabled', 'web_provider_unconfigured', 'web_provider_auth_failed',
  'web_provider_rate_limited', 'web_provider_unavailable', 'web_provider_invalid_response',
  'web_invalid_query', 'web_sensitive_query_blocked', 'web_url_invalid',
  'web_scheme_blocked', 'web_ssrf_blocked', 'web_dns_check_failed',
  'web_redirect_blocked', 'web_fetch_timeout', 'web_fetch_cancelled',
  'web_response_too_large', 'web_content_unsupported', 'web_extraction_failed',
  'web_cache_unavailable', 'web_partial', 'web_citation_invalid',
]);

/** Runtime whitelist applied again at every durable Web evidence boundary. */
export function sanitizeWebEvidenceProjection(value: unknown): WebEvidenceProjection | undefined {
  const record = webRecord(value);
  if (!record || record.version !== WEB_RETRIEVAL_CONTRACT_VERSION) return undefined;
  const generatedAt = webIso(record.generatedAt) ?? new Date(0).toISOString();
  const completeness = record.completeness === 'complete' || record.completeness === 'partial'
    ? record.completeness
    : 'none';
  const rawIds = Array.isArray(record.citationIds) ? record.citationIds : [];
  const citationIds = [...new Set(rawIds
    .filter((id): id is string => typeof id === 'string' && /^web-[A-Za-z0-9-]{1,196}$/u.test(id)))]
    .slice(0, 128);
  const allowedIds = new Set(citationIds);
  const citations = (Array.isArray(record.citations) ? record.citations : [])
    .map((citation) => sanitizeCitationProjection(citation, allowedIds))
    .filter((citation): citation is WebCitationProjection => Boolean(citation))
    .slice(0, 128);
  const rawErrors = Array.isArray(record.errorKinds) ? record.errorKinds : [];
  const errorKinds = [...new Set(rawErrors.filter((kind): kind is WebErrorKind => (
    typeof kind === 'string' && WEB_ERROR_KIND_SET.has(kind as WebErrorKind)
  )))].slice(0, 32);
  return {
    version: WEB_RETRIEVAL_CONTRACT_VERSION,
    ...(typeof record.providerId === 'string' && record.providerId.trim()
      ? { providerId: webText(record.providerId, 100) }
      : {}),
    generatedAt,
    completeness,
    citationIds,
    ...(citations.length > 0 ? { citations } : {}),
    citationCount: webInteger(record.citationCount, 0, 100_000, citationIds.length),
    documentCount: webInteger(record.documentCount, 0, 100_000, 0),
    cached: record.cached === true,
    partial: record.partial === true,
    truncated: record.truncated === true,
    blocked: record.blocked === true,
    stale: record.stale === true,
    ...(errorKinds.length > 0 ? { errorKinds } : {}),
  };
}

function sanitizeCitationProjection(
  value: unknown,
  allowedIds: ReadonlySet<string>,
): WebCitationProjection | undefined {
  const record = webRecord(value);
  const id = typeof record?.id === 'string' ? record.id : '';
  if (!record || !allowedIds.has(id)) return undefined;
  const origin = safeWebOrigin(record.origin);
  const urlHash = typeof record.urlHash === 'string' && /^[a-f0-9]{64}$/u.test(record.urlHash)
    ? record.urlHash
    : undefined;
  const fetchedAt = webIso(record.fetchedAt);
  const status = typeof record.status === 'string' && WEB_CITATION_STATUSES.has(record.status as WebCitationStatus)
    ? record.status as WebCitationStatus
    : undefined;
  if (!origin || !urlHash || !fetchedAt || !status) return undefined;
  const url = safeDurableWebUrl(record.url);
  const publishedAt = webIso(record.publishedAt);
  return {
    id,
    ...(url ? { url } : {}),
    origin,
    urlHash,
    ...(typeof record.title === 'string' && record.title.trim() ? { title: webText(record.title, 300) } : {}),
    ...(typeof record.provider === 'string' && record.provider.trim() ? { provider: webText(record.provider, 100) } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    fetchedAt,
    status,
    ...(typeof record.contentHash === 'string' && record.contentHash.length <= 200
      ? { contentHash: webText(record.contentHash, 200) }
      : {}),
    truncated: record.truncated === true,
  };
}

function safeDurableWebUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined;
    if ([...url.searchParams.keys()].some((key) => /(?:token|key|secret|signature|credential|auth|session|cookie)/iu.test(key))) return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeWebOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 300) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function webRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function webText(value: string, maxChars: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maxChars);
}

function webIso(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function webInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

export interface WebErrorInfo {
  readonly kind: WebErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly providerId?: string;
  readonly httpStatus?: number;
}

export interface WebEvidenceSink {
  record(projection: WebEvidenceProjection): void | Promise<void>;
}

/**
 * Narrow host-owned port exposed to tools. The implementation owns provider
 * selection, URL validation, quotas, caching, citation binding and evidence;
 * tools only receive provider-neutral requests and bounded results.
 */
export interface WebRetrievalRuntimePort {
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>;
  fetch(request: FetchRequest, signal?: AbortSignal): Promise<FetchedDocument>;
  evidence(): WebEvidenceProjection;
}
