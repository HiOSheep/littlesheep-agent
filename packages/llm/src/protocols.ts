// @littlesheep/llm — wire protocols.ts
// The set of wire protocols LS can speak, and the facts that differ between them.
//
// `ChatRequest`/`ChatResponse` in `types.ts` are the harness's protocol-neutral
// contract. Everything vendor-shaped lives behind this module: a client translates
// the neutral request into one protocol's body, and translates that protocol's
// stream back into the same neutral chunks. Nothing above `@littlesheep/llm` should
// have to know which protocol a provider speaks.
//
// The enum is duplicated from `@littlesheep/config` on purpose: `llm` must not
// depend on `config` (the dependency runs the other way). `client-conformance.test.ts`
// asserts the two lists agree, so a protocol added on one side cannot be silently
// missing on the other.

/** Wire protocols implemented by a client in this package. */
export const IMPLEMENTED_API_PROTOCOLS = [
  'openai-chat-completions',
  'openai-responses',
  'anthropic-messages',
] as const;

export type ApiProtocol = typeof IMPLEMENTED_API_PROTOCOLS[number];

export function isImplementedApiProtocol(value: unknown): value is ApiProtocol {
  return typeof value === 'string' && (IMPLEMENTED_API_PROTOCOLS as readonly string[]).includes(value);
}

/** What a caller must supply to build any protocol's client. */
export interface ProtocolClientOptions {
  baseURL: string;
  apiKey?: string;
  timeoutSeconds?: number;
  headers?: Record<string, string>;
}

/**
 * Per-protocol wire facts.
 *
 * These are constants of the vendor API, not user settings. `versionHeader` covers
 * Anthropic's required `anthropic-version`; `authScheme` covers the fact that
 * Anthropic authenticates with `x-api-key` while the OpenAI-shaped APIs use a
 * bearer token. Getting either wrong produces a 401 that looks like a bad key.
 */
export interface ProtocolDescriptor {
  protocol: ApiProtocol
  /** Path appended to the provider's base URL. */
  path: string
  /** Header the credential travels in. */
  auth: 'bearer' | 'x-api-key'
  /** Extra headers every request of this protocol needs. */
  requiredHeaders?: Record<string, string>
  /** Path appended to the base URL for the model catalog, or null when unsupported. */
  modelCatalogPath: string | null
}

export const PROTOCOL_DESCRIPTORS: Record<ApiProtocol, ProtocolDescriptor> = {
  'openai-chat-completions': {
    protocol: 'openai-chat-completions',
    path: '/chat/completions',
    auth: 'bearer',
    modelCatalogPath: '/models',
  },
  'openai-responses': {
    protocol: 'openai-responses',
    path: '/responses',
    auth: 'bearer',
    modelCatalogPath: '/models',
  },
  'anthropic-messages': {
    protocol: 'anthropic-messages',
    path: '/messages',
    auth: 'x-api-key',
    // Anthropic rejects a request without this and names the missing header, so a
    // provider configured without it would look like an authentication failure.
    requiredHeaders: { 'anthropic-version': '2023-06-01' },
    modelCatalogPath: '/models',
  },
};

/**
 * Join a base URL with one protocol path.
 *
 * Base URLs are written both ways in the wild (`https://host/v1` and
 * `https://host/v1/chat/completions` copied from a request example), so a base URL
 * that already ends with the protocol path is used as written instead of being
 * doubled. The query string belongs to the base call, never to this path.
 */
export function protocolUrl(baseURL: string, path: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/u, '')
  if (!path) return trimmed
  if (trimmed.endsWith(path)) return trimmed
  return `${trimmed}${path}`
}

/** Build the request headers for one protocol. */
export function protocolHeaders(
  descriptor: ProtocolDescriptor,
  apiKey: string | undefined,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...descriptor.requiredHeaders,
    ...extra,
  }
  if (apiKey) {
    if (descriptor.auth === 'x-api-key') headers['x-api-key'] = apiKey
    else headers.Authorization = `Bearer ${apiKey}`
  }
  return headers
}
