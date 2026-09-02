import { createHash } from 'node:crypto';
import type {
  ProviderHealth,
  SearchRequest,
  SearchResponse,
} from '@littlesheep/types';
import { webError } from '../errors.js';
import type { SearchProvider, SearchProviderContext } from '../provider.js';
import { isSensitiveUrlParameterName } from '../fetch/url-policy.js';

export interface TavilySearchProviderOptions {
  readonly providerId?: string;
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => Date;
  readonly maxResponseBytes?: number;
}

/** Tavily adapter: discovery/ranking only; raw page content and answers stay disabled. */
export class TavilySearchProvider implements SearchProvider {
  readonly id: string;
  readonly displayName = 'Tavily';
  readonly capabilities = {
    search: true,
    recency: true,
    domains: true,
    language: false,
    citations: true,
  } as const;
  private readonly fetchFn: typeof fetch;
  private readonly apiKey: string;
  private readonly endpoint: URL;
  private readonly now: () => Date;
  private readonly maxResponseBytes: number;

  constructor(options: TavilySearchProviderOptions) {
    if (!options.apiKey.trim()) throw new Error('web: Tavily API key is required');
    this.id = options.providerId?.trim() || 'tavily';
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.maxResponseBytes = Math.max(16_384, Math.min(options.maxResponseBytes ?? 2 * 1024 * 1024, 32 * 1024 * 1024));
    const rawEndpoint = options.baseURL ?? 'https://api.tavily.com/search';
    try {
      this.endpoint = new URL(rawEndpoint);
    } catch (error) {
      throw new Error(`web: invalid Tavily endpoint: ${(error as Error).message}`);
    }
    if (this.endpoint.protocol !== 'https:') throw new Error('web: Tavily endpoint must use HTTPS');
    if (this.endpoint.username || this.endpoint.password) throw new Error('web: provider endpoint credentials are not allowed');
    if (this.endpoint.origin !== 'https://api.tavily.com' || this.endpoint.pathname.replace(/\/+$/u, '') !== '/search' || this.endpoint.search || this.endpoint.hash) {
      throw new Error('web: Tavily endpoint is not an approved provider endpoint');
    }
  }

  async search(request: SearchRequest, context: SearchProviderContext): Promise<SearchResponse> {
    const body: Record<string, unknown> = {
      query: request.query,
      search_depth: 'basic',
      topic: 'general',
      max_results: request.maxResults,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      auto_parameters: false,
    };
    if (request.domains?.length) body.include_domains = request.domains;
    if (request.excludeDomains?.length) body.exclude_domains = request.excludeDomains;
    if (request.recency && request.recency !== 'custom') body.time_range = recencyToTavily(request.recency);
    if (request.from) body.start_date = request.from;
    if (request.to) body.end_date = request.to;

    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'LittleSheep/0.1',
        },
        body: JSON.stringify(body),
        signal: context.signal,
      });
    } catch (error) {
      if (context.signal?.aborted) {
        throw webError('web_fetch_cancelled', 'provider request was cancelled', { retryable: false, providerId: this.id });
      }
      throw webError('web_provider_unavailable', 'Tavily request failed', { retryable: true, providerId: this.id });
    }
    const responseText = await readResponseBounded(response, this.maxResponseBytes, context.signal);
    if (!response.ok) throw providerHttpError(this.id, response.status, response.headers);

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw webError('web_provider_invalid_response', 'Tavily returned invalid JSON', {
        retryable: false,
        providerId: this.id,
        httpStatus: response.status,
      });
    }
    return normalizeTavilyResponse(parsed, request, context, this.now, this.id, [this.apiKey]);
  }

  async health(context: SearchProviderContext): Promise<ProviderHealth> {
    // Do not send a paid query for a health probe. Configuration health is
    // reported as configured; an opt-in search smoke test proves reachability.
    return {
      providerId: this.id,
      status: 'healthy',
      checkedAt: (context.now ?? this.now)().toISOString(),
    };
  }
}

export function normalizeTavilyResponse(
  value: unknown,
  request: SearchRequest,
  context: SearchProviderContext,
  now: () => Date = () => new Date(),
  providerId = 'tavily',
  redactValues: readonly string[] = [],
): SearchResponse {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw webError('web_provider_invalid_response', 'Tavily response has no valid results array', {
      retryable: false,
      providerId,
    });
  }
  const warnings: string[] = [];
  const seen = new Set<string>();
  const results = [] as SearchResponse['results'][number][];
  for (const candidate of value.results) {
    if (!isRecord(candidate)) continue;
    const rawUrl = typeof candidate.url === 'string' ? candidate.url.trim() : '';
    const title = typeof candidate.title === 'string' ? cleanText(candidate.title, 500, redactValues) : '';
    if (!rawUrl || !title) continue;
    if (redactValues.some((secret) => secret && rawUrl.includes(secret))) {
      warnings.push('one provider result URL contained secret material and was discarded');
      continue;
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      warnings.push('one provider result had an invalid URL and was discarded');
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      warnings.push('one provider result used a blocked URL scheme and was discarded');
      continue;
    }
    if (url.username || url.password) {
      warnings.push('one provider result contained URL credentials and was discarded');
      continue;
    }
    let strippedSensitiveParameters = false;
    for (const name of [...url.searchParams.keys()]) {
      if (isSensitiveUrlParameterName(name)) {
        url.searchParams.delete(name);
        strippedSensitiveParameters = true;
      }
    }
    if (strippedSensitiveParameters) warnings.push('sensitive URL parameters were removed from one provider result');
    url.hash = '';
    const canonicalUrl = url.toString();
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    const rank = results.length + 1;
    const citationId = context.citationIdFor?.(canonicalUrl, rank) ?? defaultCitationId(canonicalUrl, rank);
    results.push({
      rank,
      title,
      url: canonicalUrl,
      canonicalUrl,
      ...(typeof candidate.content === 'string' && candidate.content.trim()
        ? { snippet: cleanText(candidate.content, 2_000, redactValues) }
        : {}),
      ...(typeof candidate.published_date === 'string' ? { publishedAt: candidate.published_date } : {}),
      siteName: url.hostname,
      citationId,
      sourceStatus: 'search_result',
    });
    if (results.length >= request.maxResults) break;
  }
  if (results.length === 0 && value.results.length > 0) warnings.push('provider results were present but none passed normalization');
  return {
    version: 1,
    provider: providerId,
    query: request.query,
    results,
    fetchedAt: (context.now ?? now)().toISOString(),
    cached: false,
    partial: warnings.length > 0,
    ...(typeof value.request_id === 'string' ? { providerRequestId: cleanText(value.request_id, 200, redactValues) } : {}),
    warnings,
  };
}

function recencyToTavily(value: Exclude<SearchRequest['recency'], undefined | 'custom'>): string {
  switch (value) {
    case 'today': return 'day';
    case 'week': return 'week';
    case 'month': return 'month';
    case 'year': return 'year';
  }
}

async function readResponseBounded(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw webError('web_response_too_large', 'provider response exceeds the configured size limit', { retryable: false });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw webError('web_fetch_cancelled', 'provider request was cancelled', { retryable: false });
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw webError('web_response_too_large', 'provider response exceeds the configured size limit', { retryable: false });
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function providerHttpError(providerId: string, status: number, headers: Headers): ReturnType<typeof webError> {
  const retryAfter = Number(headers.get('retry-after'));
  if (status === 401 || status === 403) {
    return webError('web_provider_auth_failed', 'Tavily authentication failed', {
      retryable: false,
      providerId,
      httpStatus: status,
    });
  }
  if (status === 429) {
    return webError('web_provider_rate_limited', 'Tavily rate limit reached', {
      retryable: true,
      retryAfterMs: Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1_000) : undefined,
      providerId,
      httpStatus: status,
    });
  }
  return webError(status >= 500 ? 'web_provider_unavailable' : 'web_provider_invalid_response', `Tavily request failed with HTTP ${status}`, {
    retryable: status >= 500,
    providerId,
    httpStatus: status,
  });
}

function defaultCitationId(url: string, rank: number): string {
  return `web-${rank}-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;
}

function cleanText(value: string, max: number, redactValues: readonly string[] = []): string {
  let redacted = value.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer [REDACTED]');
  for (const secret of redactValues) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]');
  }
  const cleaned = redacted.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
