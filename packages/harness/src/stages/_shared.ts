// @littlesheep/harness — stages/_shared.ts
// Helpers shared across LLM-backed stages: message conversion, JSON
// extraction, and retry-on-parse-failure LLM calls.

import type { Message, RunAttachment } from '@littlesheep/types';
import type { ChatContentPart, ChatMessage, ChatResponse, LlmClient } from '@littlesheep/llm';

/** Extract text content from a Message (concatenates text blocks). */
export function textOf(m: Message): string {
  return m.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/** Convert an internal Message to an OpenAI-format ChatMessage. */
export function toChatMessage(m: Message): ChatMessage {
  // Tool messages and tool_calls blocks are flattened to text for simplicity
  // in non-EXECUTE stages. EXECUTE builds tool messages itself.
  const text = textOf(m);
  const role: ChatMessage['role'] =
    m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'user';
  return { role, content: text };
}

/** Build the inbound user message, including image attachments as data URLs. */
export function userChatMessage(
  text: string,
  attachments?: RunAttachment[],
): ChatMessage {
  const imageParts: ChatContentPart[] = (attachments ?? [])
    .filter((a) => a.kind === 'image' && !!a.dataUrl)
    .map((a) => ({
      type: 'image_url' as const,
      image_url: { url: a.dataUrl!, detail: 'auto' as const },
    }));

  if (imageParts.length === 0) {
    return { role: 'user', content: text || '(empty message)' };
  }

  return {
    role: 'user',
    content: [
      { type: 'text', text: text || '(empty message)' },
      ...imageParts,
    ],
  };
}

/** Extract the first JSON object {...} from a string (handles markdown wraps). */
export function extractJson(content: string): unknown | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Call llm.chat and parse JSON output, retrying on parse failure.
 * Returns parsed object or null after `maxAttempts` parse failures.
 *
 * Contract:
 * - Parse failures (invalid/empty JSON) → returns `{ parsed: null }` so the
 *   caller can route to RECOVER / ask_user.
 * - Transport errors (auth, persistent 5xx, network) → THROWS. The LLM client
 *   already retries via retryWithBackoff; a throw here means the error is not
 *   retryable. Non-harness callers (e.g. import-repo CLI) depend on this
 *   throw to surface operational failures. Harness stages that need to route
 *   transport errors to RECOVER must wrap the call in their own try/catch.
 *
 * On retry, a corrective user message is appended so the model knows its last
 * response was invalid — naive identical-message retries tend to reproduce the
 * same malformation.
 */
export async function callLlmForJson<T>(
  llm: LlmClient,
  model: string,
  messages: ChatMessage[],
  opts: { maxAttempts?: number; temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<{ parsed: T | null; attempts: number; lastResponse?: ChatResponse }> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let lastResponse: ChatResponse | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // On retry, append corrective feedback — naive identical-message retries
    // tend to reproduce the same malformation.
    const msgs: ChatMessage[] = attempt > 1
      ? [...messages, { role: 'user', content: 'Your previous response was not valid JSON. Return ONLY a raw JSON object — no markdown fences, no surrounding prose.' }]
      : messages;
    const res = await llm.chat({
      model,
      messages: msgs,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 1000,
      signal: opts.signal,
    });
    lastResponse = res;
    const parsed = extractJson(res.content) as T | null;
    if (parsed !== null) return { parsed, attempts: attempt, lastResponse: res };
  }
  return { parsed: null, attempts: maxAttempts, lastResponse };
}

/** Best-effort non-null assertion helper for arrays from JSON (which are `unknown`). */
export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
