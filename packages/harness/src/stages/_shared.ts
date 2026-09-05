// @littlesheep/harness — stages/_shared.ts
// Helpers shared across LLM-backed stages: message conversion, JSON
// extraction, and retry-on-parse-failure LLM calls.

import { filterAuthoritativeUserFacingMessages, type Message, type RunAttachment } from '@littlesheep/types';
import type { ChatContentPart, ChatMessage, ChatResponse, LlmClient } from '@littlesheep/llm';
import { attachmentManifestResourceId } from '@littlesheep/memory-tree';
import type { InsertedContextMessage } from '../context-candidates.js';
import { modelRequestIdFor } from '../model-observability.js';

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

/**
 * Keep model requests bounded while the durable transcript remains complete.
 * Older turns are represented by the session summary or memory indexes; they
 * should not be re-sent verbatim on every planning call.
 */
export function recentHistoryForModel(
  history: Message[],
  maxMessages = 8,
  maxChars = 6_000,
): Message[] {
  const candidates = filterAuthoritativeUserFacingMessages(history).slice(-Math.max(0, maxMessages));
  const selected: Message[] = [];
  let remaining = Math.max(0, maxChars);

  for (let index = candidates.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = candidates[index]!;
    const length = textOf(message).length;
    if (length <= remaining) {
      selected.push(message);
      remaining -= length;
      continue;
    }
    if (selected.length === 0) selected.push(truncateMessageForModel(message, remaining));
    break;
  }
  return selected.reverse();
}

function truncateMessageForModel(message: Message, maxChars: number): Message {
  const budget = Math.max(0, maxChars);
  if (budget === 0) return { ...message, content: [] };
  const text = textOf(message);
  if (text.length <= budget) return message;
  const marker = '\n... [older message truncated] ...\n';
  const contentBudget = Math.max(0, budget - marker.length);
  const head = Math.ceil(contentBudget / 2);
  const tail = Math.floor(contentBudget / 2);
  const bounded = `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ''}`;
  return { ...message, content: [{ type: 'text', text: bounded }] };
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

export interface AttachmentContextMessage {
  message: ChatMessage;
  context: InsertedContextMessage;
}

export function attachmentManifestText(attachments?: RunAttachment[]): string {
  if (!attachments || attachments.length === 0) return '';
  return [
    'Attached files manifest (content is not included in this block):',
    ...attachments.map((attachment, index) => {
      const id = attachment.id ?? `attachment-${index + 1}`;
      const size = attachment.size === undefined ? 'unknown size' : `${attachment.size} bytes`;
      const state = attachment.contentState ?? 'uninspected';
      const contextPath = attachment.contextPath ?? attachment.path;
      const lines = (attachment.lineComments ?? []).map((comment) => {
        const range = comment.endLine && comment.endLine !== comment.startLine
          ? `${comment.startLine}-${comment.endLine}`
          : String(comment.startLine);
        return `    - lines ${range}: ${comment.text}`;
      });
      return [
        `- [${id}] ${attachment.name ?? contextPath} (${attachment.kind}, ${size}, ${state}) path=${contextPath}`,
        ...(lines.length > 0 ? ['  User line comments:', ...lines] : []),
      ].join('\n');
    }),
    'Use inspect_attachment with attachment_id when the task requires a non-image file\'s content; use its optional page or sheet selectors for bounded multi-part reads.',
  ].join('\n');
}

/** Build manifest-only attachment messages. Content enters through a scoped tool result. */
export function attachmentContextMessages(
  runId: string,
  attachments: RunAttachment[] | undefined,
): AttachmentContextMessage[] {
  if (!attachments || attachments.length === 0) return [];
  const manifest = attachmentManifestText(attachments);
  const resourceId = attachmentManifestResourceId(runId);
  const messages: AttachmentContextMessage[] = [{
    message: { role: 'user', content: manifest },
    context: {
      id: resourceId,
      kind: 'attachment_manifest',
      source: { kind: 'attachment', id: resourceId, runId },
      priority: 92,
      required: true,
      sensitive: true,
      scope: 'run',
    },
  }];
  return messages;
}

/** Extract the last complete JSON object from plain text or markdown output. */
export function extractJson(content: string): unknown | null {
  const parsedObjects: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (start < 0) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    if (character !== '}') continue;
    depth -= 1;
    if (depth > 0) continue;

    try {
      parsedObjects.push(JSON.parse(content.slice(start, index + 1)));
    } catch {
      // Continue scanning in case a later complete object is valid.
    }
    start = -1;
    depth = 0;
    inString = false;
    escaped = false;
  }

  return parsedObjects.at(-1) ?? null;
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
  opts: {
    maxAttempts?: number;
    temperature?: number;
    maxTokens?: number;
    /** Upper bound used only after an empty response exhausts the initial budget. */
    maxTokensCeiling?: number;
    signal?: AbortSignal;
    onRequest?: (
      request: import('@littlesheep/llm').ChatRequest,
      retry: { attempt: number; previousResponseWasEmpty: boolean; previousRequestId?: string },
    ) => import('@littlesheep/llm').ChatRequest | void;
    /** Durable request-start gate, awaited immediately before Provider I/O. */
    beforeRequest?: (request: import('@littlesheep/llm').ChatRequest, attempt: number) => Promise<void>;
    onResponse?: (
      request: import('@littlesheep/llm').ChatRequest,
      response: ChatResponse,
    ) => void | Promise<void>;
    onError?: (
      request: import('@littlesheep/llm').ChatRequest,
      error: unknown,
    ) => void | Promise<void>;
  } = {},
): Promise<{ parsed: T | null; attempts: number; lastResponse?: ChatResponse }> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const initialMaxTokens = opts.maxTokens ?? 1000;
  const maxTokensCeiling = Math.max(initialMaxTokens, opts.maxTokensCeiling ?? initialMaxTokens);
  let currentMaxTokens = initialMaxTokens;
  let lastResponse: ChatResponse | undefined;
  let previousRequestId: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const previousResponseWasEmpty = Boolean(lastResponse && !lastResponse.content.trim());
    // On retry, append corrective feedback — naive identical-message retries
    // tend to reproduce the same malformation.
    const msgs: ChatMessage[] = attempt > 1
      ? [...messages, {
          role: 'user',
          content: previousResponseWasEmpty
            ? 'Your previous response produced no final JSON text. Return the required raw JSON object now. Keep private reasoning bounded and leave enough output budget for the complete JSON.'
            : 'Your previous response was not valid JSON. Return ONLY a raw JSON object — no markdown fences, no surrounding prose.',
        }]
      : messages;
    const request = {
      model,
      messages: msgs,
      temperature: opts.temperature ?? 0,
      max_tokens: currentMaxTokens,
      signal: opts.signal,
    };
    const preparedRequest = opts.onRequest?.(request, {
      attempt,
      previousResponseWasEmpty,
      ...(previousRequestId ? { previousRequestId } : {}),
    }) ?? request;
    previousRequestId = modelRequestIdFor(preparedRequest);
    await opts.beforeRequest?.(preparedRequest, attempt);
    let res: ChatResponse;
    try {
      res = await llm.chat(preparedRequest);
    } catch (error) {
      await opts.onError?.(preparedRequest, error);
      throw error;
    }
    await opts.onResponse?.(preparedRequest, res);
    lastResponse = res;
    const parsed = extractJson(res.content) as T | null;
    if (parsed !== null) return { parsed, attempts: attempt, lastResponse: res };
    if (currentMaxTokens < maxTokensCeiling) {
      const growth = !res.content.trim() ? 2 : 1.5;
      currentMaxTokens = Math.min(
        maxTokensCeiling,
        Math.max(currentMaxTokens + 1, Math.ceil(currentMaxTokens * growth)),
      );
    }
  }
  return { parsed: null, attempts: maxAttempts, lastResponse };
}

/** Best-effort non-null assertion helper for arrays from JSON (which are `unknown`). */
export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
