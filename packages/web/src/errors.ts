import type { WebErrorInfo, WebErrorKind } from '@littlesheep/types';

const WEB_ERROR_KINDS: readonly WebErrorKind[] = [
  'web_disabled',
  'web_provider_unconfigured',
  'web_provider_auth_failed',
  'web_provider_rate_limited',
  'web_provider_unavailable',
  'web_provider_invalid_response',
  'web_invalid_query',
  'web_sensitive_query_blocked',
  'web_url_invalid',
  'web_scheme_blocked',
  'web_ssrf_blocked',
  'web_dns_check_failed',
  'web_redirect_blocked',
  'web_fetch_timeout',
  'web_fetch_cancelled',
  'web_response_too_large',
  'web_content_unsupported',
  'web_extraction_failed',
  'web_cache_unavailable',
  'web_partial',
  'web_citation_invalid',
];

export function isWebErrorKind(value: unknown): value is WebErrorKind {
  return typeof value === 'string' && WEB_ERROR_KINDS.includes(value as WebErrorKind);
}

export class WebRetrievalError extends Error {
  readonly kind: WebErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly providerId?: string;
  readonly httpStatus?: number;

  constructor(info: WebErrorInfo, options?: { cause?: unknown }) {
    super(info.message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WebRetrievalError';
    this.kind = info.kind;
    this.retryable = info.retryable;
    this.retryAfterMs = info.retryAfterMs;
    this.providerId = info.providerId;
    this.httpStatus = info.httpStatus;
  }

  toInfo(): WebErrorInfo {
    return {
      kind: this.kind,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      ...(this.providerId === undefined ? {} : { providerId: this.providerId }),
      ...(this.httpStatus === undefined ? {} : { httpStatus: this.httpStatus }),
    };
  }
}

export function webError(
  kind: WebErrorKind,
  message: string,
  options: Partial<Omit<WebErrorInfo, 'kind' | 'message'>> & { cause?: unknown } = {},
): WebRetrievalError {
  const { cause, ...info } = options;
  return new WebRetrievalError({
    kind,
    message,
    retryable: info.retryable ?? defaultRetryable(kind),
    ...info,
  }, { cause });
}

export function asWebRetrievalError(error: unknown, fallbackKind: WebErrorKind = 'web_provider_unavailable'): WebRetrievalError {
  if (error instanceof WebRetrievalError) return error;
  if (error instanceof Error && error.name === 'TimeoutError') {
    return webError('web_fetch_timeout', 'network retrieval timed out', { retryable: true });
  }
  if (isAbortError(error)) {
    return webError('web_fetch_cancelled', 'network retrieval was cancelled', { retryable: false });
  }
  return webError(fallbackKind, fallbackMessage(fallbackKind));
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function defaultRetryable(kind: WebErrorKind): boolean {
  return kind === 'web_provider_rate_limited'
    || kind === 'web_provider_unavailable'
    || kind === 'web_fetch_timeout'
    || kind === 'web_cache_unavailable'
    || kind === 'web_partial';
}

function fallbackMessage(kind: WebErrorKind): string {
  if (kind === 'web_cache_unavailable') return 'web cache is unavailable';
  if (kind === 'web_provider_invalid_response') return 'web provider returned an invalid response';
  return 'network retrieval failed';
}
