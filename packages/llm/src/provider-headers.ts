// @littlesheep/llm — provider-headers.ts
// Wire headers a Provider or gateway requires outside the OpenAI-compatible body.

/**
 * Gateways that refuse traffic without a stable per-conversation session header.
 *
 * opencode Go answers `400 {"type":"MissingSessionID"}` — "Request is missing
 * x-opencode-session and cannot be routed efficiently" — before it looks at the
 * credential, so every model call fails however well-formed the request is. The
 * header is routing and prompt-cache metadata rather than protocol content, so it is
 * adapted here, in the package that owns Provider differences, and never reaches the
 * body, the durable request snapshot or a Harness contract.
 */
const SESSION_HEADER_BY_HOST: ReadonlyArray<readonly [host: string, header: string]> = [
  ['opencode.ai', 'x-opencode-session'],
];

/**
 * The client names itself instead of arriving as a generic HTTP library.
 *
 * gateways use this to separate an agent from scripted traffic: opencode Go asks clients
 * to send their own user agent rather than a generic SDK/HTTP-library name, which is what
 * a bare `fetch` sends.
 */
export const CLIENT_USER_AGENT = 'LittleSheep/0.1';

export interface ProviderHeaderInput {
  baseURL: string;
  apiKey?: string;
  /** Provider-configured headers (`providers[].headers`); an explicit value always wins. */
  configured?: Readonly<Record<string, string>>;
  /** Stable stand-in for calls that have no conversation of their own (e.g. compaction). */
  fallbackSessionId: string;
}

/**
 * Build the wire headers for one request.
 *
 * `conversationId` is the caller's stable identity for the conversation. A gateway that
 * requires a session header receives it, or the client's fallback when the caller has no
 * conversation to name; every other Provider sees only the configured headers, the API key,
 * `Content-Type` and the client user agent.
 */
export function providerRequestHeaders(
  input: ProviderHeaderInput,
  conversationId?: string,
): Record<string, string> {
  const headers: Record<string, string> = { ...input.configured };
  setIfAbsent(headers, 'Content-Type', 'application/json');
  setIfAbsent(headers, 'User-Agent', CLIENT_USER_AGENT);
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
  const sessionHeader = sessionHeaderFor(input.baseURL);
  if (sessionHeader) {
    setIfAbsent(headers, sessionHeader, conversationId?.trim() || input.fallbackSessionId);
  }
  return headers;
}

/**
 * A stable id for the lifetime of one client.
 *
 * Callers that do have a conversation pass it per request; this only covers the calls that
 * cannot name one, and it must stay stable so a gateway can route and cache them.
 */
export function createProviderSessionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  const suffix = uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `littlesheep-${suffix}`;
}

/** The session header this endpoint requires, if any. A malformed URL is simply not a match. */
function sessionHeaderFor(baseURL: string): string | undefined {
  let host: string;
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const [domain, header] of SESSION_HEADER_BY_HOST) {
    if (host === domain || host.endsWith(`.${domain}`)) return header;
  }
  return undefined;
}

/** Header names are case-insensitive, so a configured spelling must not be duplicated. */
function setIfAbsent(headers: Record<string, string>, name: string, value: string): void {
  const present = Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
  if (!present) headers[name] = value;
}
