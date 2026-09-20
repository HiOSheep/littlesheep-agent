// @littlesheep/harness — stages/_shared.ts
// Helpers shared across LLM-backed stages: message conversion, JSON
// extraction, and retry-on-parse-failure LLM calls.

import { filterAuthoritativeUserFacingMessages, type Message, type RunAttachment, type RunContext } from '@littlesheep/types';
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
/**
 * The single conversation-history window every stage must use.
 *
 * Cross-stage cache reuse needs the history projection to be byte-identical for
 * every stage, otherwise the Provider's prefix diverges at the first message
 * that one stage includes and another omits. Stage-specific windows (classify 4,
 * verify none, reply 8/6k) are therefore replaced by this shared projection.
 *
 * It also has to be *append-only*. A Provider prefix cache only matches from
 * token zero, so a plain "last N messages" suffix slides on every turn: the
 * window for turn N+1 no longer starts with the window for turn N, and the only
 * reusable bytes are whatever precedes the history. Measured on a live 8x5
 * session: the first tool-loop call of a run hit 2432 of 6722 prompt tokens
 * while its later iterations (which extend the same array) hit 5120 of 6200.
 *
 * The window therefore keeps every authoritative message until the character
 * budget is exhausted, and only then drops from the oldest side -- at a
 * quantised boundary, so the projection changes once per quantum of messages
 * instead of once per turn. `sessions.compaction.keepRecent` bounds how much
 * verbatim transcript a run receives in the first place.
 */
export const SHARED_HISTORY_MAX_CHARS = 12_000;
/** Messages dropped at once when the window overflows, so the boundary is rare. */
export const SHARED_HISTORY_BOUNDARY_QUANTUM = 8;

export function conversationHistoryForModel(ctx: Pick<RunContext, 'history'>): Message[] {
  const candidates = filterAuthoritativeUserFacingMessages(ctx.history);
  const sizes = candidates.map((message) => textOf(message).length);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= SHARED_HISTORY_MAX_CHARS) return candidates;

  let start = 0;
  while (start < candidates.length && total > SHARED_HISTORY_MAX_CHARS) {
    total -= sizes[start]!;
    start += 1;
  }
  // Round the boundary down so it moves one quantum at a time, never per turn.
  const boundary = Math.floor(start / SHARED_HISTORY_BOUNDARY_QUANTUM) * SHARED_HISTORY_BOUNDARY_QUANTUM;
  if (boundary >= candidates.length) {
    const newest = candidates.at(-1);
    return newest ? [truncateMessageForModel(newest, SHARED_HISTORY_MAX_CHARS)] : [];
  }
  return candidates.slice(boundary);
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
    /** Provider tool definitions to advertise; the provider caches them ahead of the messages. */
    tools?: import('@littlesheep/llm').ToolSpec[];
    /** Optional schema/contract expansion. Throwing performs one bounded schema retry. */
    validateParsed?: (value: unknown) => T;
    onRequest?: (
      request: import('@littlesheep/llm').ChatRequest,
      retry: {
        attempt: number;
        previousResponseWasEmpty: boolean;
        previousRequestId?: string;
        previousFailureReason?: 'empty_output' | 'length' | 'decode' | 'schema';
      },
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
): Promise<{
  parsed: T | null;
  attempts: number;
  lastResponse?: ChatResponse;
  lastFailureReason?: 'empty_output' | 'length' | 'decode' | 'schema';
}> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const initialMaxTokens = opts.maxTokens ?? 1000;
  const maxTokensCeiling = Math.max(initialMaxTokens, opts.maxTokensCeiling ?? initialMaxTokens);
  let currentMaxTokens = initialMaxTokens;
  let lastResponse: ChatResponse | undefined;
  let previousRequestId: string | undefined;
  let previousFailureReason: 'empty_output' | 'length' | 'decode' | 'schema' | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const previousResponseWasEmpty = Boolean(lastResponse && !lastResponse.content.trim());
    // On retry, append corrective feedback — naive identical-message retries
    // tend to reproduce the same malformation.
    const msgs: ChatMessage[] = attempt > 1
      ? [...messages, {
          role: 'user',
          content: retryInstruction(previousFailureReason),
        }]
      : messages;
    const request = {
      model,
      messages: msgs,
      temperature: opts.temperature ?? 0,
      max_tokens: currentMaxTokens,
      signal: opts.signal,
      ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
    };
    const preparedRequest = opts.onRequest?.(request, {
      attempt,
      previousResponseWasEmpty,
      ...(previousRequestId ? { previousRequestId } : {}),
      ...(previousFailureReason ? { previousFailureReason } : {}),
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
    const decoded = extractJson(res.content);
    if (decoded !== null) {
      try {
        const parsed = opts.validateParsed ? opts.validateParsed(decoded) : decoded as T;
        return { parsed, attempts: attempt, lastResponse: res };
      } catch {
        previousFailureReason = 'schema';
      }
    } else {
      previousFailureReason = res.finishReason === 'length'
        ? 'length'
        : previousResponseWasEmpty || !res.content.trim()
          ? 'empty_output'
          : 'decode';
    }
    if (currentMaxTokens < maxTokensCeiling) {
      const growth = previousFailureReason === 'empty_output' || previousFailureReason === 'length' ? 2 : 1.5;
      currentMaxTokens = Math.min(
        maxTokensCeiling,
        Math.max(currentMaxTokens + 1, Math.ceil(currentMaxTokens * growth)),
      );
    }
  }
  return {
    parsed: null,
    attempts: maxAttempts,
    lastResponse,
    ...(previousFailureReason ? { lastFailureReason: previousFailureReason } : {}),
  };
}

function retryInstruction(reason: 'empty_output' | 'length' | 'decode' | 'schema' | undefined): string {
  if (reason === 'empty_output') {
    return 'Your previous response produced no final JSON text. Return the required raw JSON object now. Keep private reasoning bounded and leave enough output budget for the complete JSON.';
  }
  if (reason === 'length') {
    return 'Your previous JSON was cut off by the output limit. Return one shorter complete raw JSON object now. Preserve every required goal, dependency and acceptance criterion; remove only optional prose.';
  }
  if (reason === 'schema') {
    return 'Your previous JSON did not satisfy the required contract. Return ONLY a corrected raw JSON object with every required field and valid enum/tool value.';
  }
  return 'Your previous response was not valid JSON. Return ONLY a raw JSON object — no markdown fences, no surrounding prose.';
}

/** Best-effort non-null assertion helper for arrays from JSON (which are `unknown`). */
export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
