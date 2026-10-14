// @littlesheep/llm — anthropic-translate.ts
// The Anthropic Messages protocol's SHAPES, and the translation between them and the
// neutral contract in `types.ts`.
//
// Nothing here performs I/O: it is the pure half of the Anthropic client, kept apart from
// `anthropic-client.ts` so the protocol's wire format can be read, tested and changed
// without the fetch loop in the way. Every rule below exists because a plausible-looking
// translation is REJECTED by the Messages API:
//
// - the system prompt is a top-level `system` string, never a `role: 'system'` message;
// - a `tool_use` block's `input` is a JSON OBJECT, never the JSON string the neutral
//   contract carries;
// - tools declare `input_schema`, never `parameters`;
// - every `tool_result` answering one assistant turn must arrive in a SINGLE user message;
// - `max_tokens` is required and must strictly exceed the thinking `budget_tokens`;
// - thinking blocks cannot be replayed without the `signature` Anthropic issued.

import type {
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ToolCall,
  ToolSpec,
} from './types.js';

/**
 * `max_tokens` is REQUIRED by the Messages API and has no server-side default, so a request
 * that omitted it would fail with a 400 naming the missing field. The fallback is the
 * documented Claude output ceiling rather than something small: capping a caller's answer is
 * worse than being refused, and `max_tokens` above the model's own limit is clamped by the API.
 */
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Thinking budgets per neutral `reasoning_effort` level.
 *
 * Anthropic bills thinking tokens as output, so these are real money and a real latency
 * cost; they track the ordinal levels of `reasoning_effort` rather than any model's limit.
 * `budget_tokens` has a documented floor (1024) and must be lower than `max_tokens`.
 */
const THINKING_BUDGET_BY_EFFORT: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768,
  max: 32768,
};

/** How far `max_tokens` must exceed the thinking budget; the API requires it to be larger. */
const THINKING_HEADROOM = 1024;

/** Anthropic tool_choice has no `required`: "must call some tool" is spelled `any`. */
const TOOL_CHOICE_REQUIRED = 'any' as const;

/** An Anthropic content block, on the way out (raw) or on the way back (parsed). */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
  /** Thinking blocks are only replayed together with the signature Anthropic issued. */
  thinking?: string;
  signature?: string;
  /** `tool_use` block. */
  id?: string;
  name?: string;
  input?: unknown;
  /** `tool_result` block. */
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  /** `image` block. */
  source?: AnthropicImageSource;
}

export type AnthropicImageSource =
  | { type: 'url'; url: string }
  | { type: 'base64'; media_type: string; data: string };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** The exact JSON body the Messages API accepts, after neutral-request translation. */
export interface AnthropicMessagesBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  stream: boolean;
  /** Top-level by definition: Anthropic rejects a `system` message inside `messages`. */
  system?: string;
  tools?: Array<{ name: string; description?: string; input_schema: object }>;
  tool_choice?: { type: string; name?: string };
  temperature?: number;
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' };
}

/** A complete (non-streaming) message, or the payload `message_start` carries. */
export interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

/**
 * Build the exact JSON body the Messages API accepts for a neutral request.
 *
 * Exported so the translation is testable without HTTP.
 */
export function buildAnthropicMessagesBody(req: ChatRequest, stream: boolean): AnthropicMessagesBody {
  // Anthropic takes the system prompt as a single TOP-LEVEL string. A `role: 'system'`
  // entry inside `messages` is rejected outright, so every system message is lifted out
  // and concatenated in order before any message is translated.
  const systemParts = req.messages
    .filter((message) => message.role === 'system')
    .map((message) => contentText(message.content))
    .filter((text) => text.length > 0);
  const messages = translateMessages(req.messages.filter((message) => message.role !== 'system'));
  const body: AnthropicMessagesBody = {
    model: req.model,
    // Required, and always emitted even when thinking is off: a missing `max_tokens` is a 400.
    max_tokens: resolveMaxTokens(req),
    messages,
    stream,
  };
  if (systemParts.length > 0) body.system = systemParts.join('\n\n');
  if (req.tools && req.tools.length > 0) body.tools = req.tools.map(toAnthropicTool);
  // `tool_choice: 'none'` is deliberately translated away rather than sent as
  // `{type: 'none'}`: the neutral contract means "no tool may be called", and not
  // offering them is the shape every Anthropic-compatible gateway accepts.
  const toolChoice = toAnthropicToolChoice(req.tool_choice);
  if (toolChoice && body.tools) body.tool_choice = toolChoice;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  const thinking = resolveThinking(req);
  if (thinking) body.thinking = thinking;
  return body;
}

/** `budget_tokens` must be strictly below `max_tokens`; the raise happens in one place. */
function resolveThinking(req: ChatRequest): AnthropicMessagesBody['thinking'] | undefined {
  if (req.thinking?.type === 'disabled') return { type: 'disabled' };
  const budget = thinkingBudget(req.reasoning_effort);
  if (budget === undefined) return undefined;
  return { type: 'enabled', budget_tokens: budget };
}

/**
 * The thinking budget for a neutral effort level, or undefined when thinking is off.
 *
 * `reasoning_effort: 'none'` and `'minimal'` mean "do not think": sending a thinking block
 * for them would bill the caller for reasoning they explicitly switched off. `minimal` has
 * no Anthropic equivalent below the 1024-token floor, so it degrades to off.
 */
function thinkingBudget(effort: ChatRequest['reasoning_effort']): number | undefined {
  if (effort === undefined || effort === 'none' || effort === 'minimal') return undefined;
  return THINKING_BUDGET_BY_EFFORT[effort] ?? THINKING_BUDGET_BY_EFFORT.medium;
}

/**
 * `max_tokens` for this request, raised above the thinking budget when it has to be.
 *
 * Anthropic rejects a request whose thinking budget is not strictly smaller than
 * `max_tokens`, so a caller that asked for `max_tokens: 2000` with `reasoning_effort: 'high'`
 * would fail validation. Raising the ceiling only relaxes a limit; using the model's
 * default instead would ignore what the caller asked for, so raise and document.
 */
function resolveMaxTokens(req: ChatRequest): number {
  const requested = normalizeMaxTokens(req.max_tokens) ?? DEFAULT_MAX_TOKENS;
  const budget = resolveThinking(req)?.type === 'enabled' ? thinkingBudget(req.reasoning_effort) : undefined;
  return budget === undefined ? requested : Math.max(requested, budget + THINKING_HEADROOM);
}

/** `max_tokens` is a positive integer on the wire; anything else is not a usable limit. */
function normalizeMaxTokens(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const tokens = Math.floor(value);
  return tokens > 0 ? tokens : undefined;
}

/** `ToolSpec` → Anthropic tool. Anthropic names the schema `input_schema`, never `parameters`. */
function toAnthropicTool(tool: ToolSpec): { name: string; description?: string; input_schema: object } {
  return {
    name: tool.function.name,
    // Omitted rather than sent empty: an empty description is worse than none.
    ...(tool.function.description ? { description: tool.function.description } : {}),
    input_schema: tool.function.parameters,
  };
}

function toAnthropicToolChoice(choice: ChatRequest['tool_choice']): { type: string; name?: string } | undefined {
  if (choice === undefined || choice === 'auto') return undefined;
  if (choice === 'none') return undefined;
  if (choice === 'required') return { type: TOOL_CHOICE_REQUIRED };
  return { type: 'tool', name: choice.function.name };
}

/**
 * Translate neutral messages, merging every run of adjacent tool results.
 *
 * Anthropic requires that all `tool_result` blocks answering one assistant turn arrive in a
 * SINGLE user message; one user message per result is accepted by nothing and reads as the
 * model having answered several times. A tool result is also the only thing that may follow
 * an assistant turn, so the merge is a correctness rule, not a formatting preference.
 */
function translateMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const translated: AnthropicMessage[] = [];
  let pendingToolResults: AnthropicContentBlock[] = [];
  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    translated.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        // Without the id Anthropic cannot match the result to the call it answers.
        tool_use_id: message.tool_call_id ?? '',
        content: contentText(message.content),
      });
      continue;
    }
    flushToolResults();
    // Only `user` and `assistant` survive to here: `system` was lifted to the top-level
    // field and `tool` was consumed above, which is also what narrows the type.
    const role: AnthropicMessage['role'] = message.role === 'assistant' ? 'assistant' : 'user';
    const content = role === 'assistant' ? assistantBlocks(message) : userBlocks(message.content);
    // A message that translated to nothing still has to be present: dropping it would
    // silently rewrite the conversation the model is being asked to continue.
    translated.push({ role, content: content.length > 0 ? content : [{ type: 'text', text: '' }] });
  }
  flushToolResults(); // a trailing tool result has nothing left to merge with
  return translated;
}

function assistantBlocks(message: ChatMessage): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  // `reasoning_content` is deliberately NOT replayed as a `{type:'thinking'}` block, even
  // though the neutral contract carries it: Anthropic validates the `signature` it issued
  // with every thinking block and rejects an unsigned one, and that signature is not part
  // of the neutral contract — so this client has nothing valid to send. A continuation that
  // requires replayed thinking must go through a protocol that does not verify it (the
  // OpenAI-shaped clients), or the contract must start carrying the signature.
  for (const part of textParts(message.content)) blocks.push({ type: 'text', text: part });
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      // `input` must be a JSON OBJECT. Anthropic rejects a string here, so the arguments
      // are parsed — and an unparsable payload becomes `{}` rather than a broken block.
      input: parseToolInput(call.function.arguments),
    });
  }
  return blocks;
}

function userBlocks(content: ChatMessage['content']): AnthropicContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map(toAnthropicPart);
}

/** Anthropic parts are a union with a `type` tag; an untranslatable part is kept as text. */
function toAnthropicPart(part: ChatContentPart): AnthropicContentBlock {
  if (part.type === 'text') return { type: 'text', text: part.text };
  return { type: 'image', source: imageSource(part.image_url.url) };
}

/**
 * A data URL becomes a base64 source, everything else a URL source.
 *
 * Anthropic accepts `source.type: 'url'` only for a real URL; a `data:` URL there is a 400,
 * while the same bytes as `source.type: 'base64'` are accepted (and are what callers
 * already send for pasted images).
 */
function imageSource(url: string): AnthropicImageSource {
  const match = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.*)$/su.exec(url);
  return match ? { type: 'base64', media_type: match[1]!, data: match[2]! } : { type: 'url', url };
}

/** `input` must be a JSON object; a string or an unparsable payload becomes `{}`. */
function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Join the text of a neutral message into one string, in order. */
export function contentText(content: ChatMessage['content'] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** The same join, part by part, so non-text parts are not silently swallowed. */
function textParts(content: ChatMessage['content']): string[] {
  if (typeof content === 'string') return content.length > 0 ? [content] : [];
  return content.filter((part) => part.type === 'text').map((part) => part.text).filter((text) => text.length > 0);
}

/** Parse a complete message into the neutral response. */
export function parseResponse(json: AnthropicResponse, request: ChatRequest): ChatResponse {
  const blocks = Array.isArray(json.content) ? json.content : [];
  const text: string[] = [];
  const thinking: string[] = [];
  const calls: ToolCall[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (block.type === 'thinking' && typeof block.thinking === 'string') thinking.push(block.thinking);
    else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      // The neutral contract carries arguments as a JSON string, so the object Anthropic
      // returned is stringified back — `{}` when it sent no usable input.
      calls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(isRecord(block.input) ? block.input : (block.input ?? {})),
        },
      });
    }
  }
  return {
    content: text.join(''),
    toolCalls: calls,
    // A returned tool call outranks `stop_reason`, exactly as in the OpenAI client.
    finishReason: calls.length > 0 ? 'tool_calls' : mapStopReason(json.stop_reason ?? undefined),
    ...(thinking.length > 0 ? { reasoningContent: thinking.join('\n') } : {}),
    usage: parseUsage(json.usage),
    model: json.model ?? request.model,
  };
}

/** Collect streamed tool blocks in content-block order, which is emission order. */
export function collectToolCalls(
  map: Map<number, { id: string; name: string; args: string }>,
): ToolCall[] {
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: call.args },
    }));
}

/**
 * Anthropic `stop_reason` → neutral `finishReason`.
 *
 * Unknown reasons must NOT become `'stop'`: `'stop'` makes the harness treat a run as
 * complete, while `'length'` routes it to recovery — the safe reading of an unfamiliar
 * termination signal (the same rule `client.ts` applies to OpenAI finish reasons).
 */
export function mapStopReason(reason: string | undefined): ChatResponse['finishReason'] {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence': return 'stop';
    case 'tool_use': return 'tool_calls';
    case 'max_tokens': return 'length';
    case 'refusal': return 'content_filter';
    case undefined: return 'stop';
    default: return 'length';
  }
}

/**
 * In real token usage into the neutral usage shape.
 *
 * `input_tokens`/`output_tokens` are the billable pair and must both be real integers;
 * the cache counters are subsets of the input and stay unknown when they are not credible,
 * so an invalid auxiliary field never erases valid primary usage.
 */
export function parseUsage(usage: AnthropicUsage | null | undefined): ChatResponse['usage'] | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.input_tokens;
  const completionTokens = usage.output_tokens;
  if (typeof promptTokens !== 'number' || !Number.isSafeInteger(promptTokens) || promptTokens < 0
    || typeof completionTokens !== 'number' || !Number.isSafeInteger(completionTokens) || completionTokens < 0) return undefined;
  const counter = (value: unknown, max: number): number | undefined => typeof value === 'number'
    && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
  const cachedPromptTokens = counter(usage.cache_read_input_tokens, promptTokens);
  const cacheWriteTokens = counter(usage.cache_creation_input_tokens, promptTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

/** A response carrying only the fields a receipt needs. */
export function emptyResponse(model: string, usage: ChatResponse['usage']): ChatResponse {
  return { content: '', toolCalls: [], finishReason: 'stop', model, usage };
}

/**
 * Fold one streaming usage frame into the running usage.
 *
 * The two halves arrive in different events: `message_start` reports the input (plus its
 * cache counters) and a placeholder output count, while `message_delta` reports only the
 * final output. A frame that carries one half must therefore update that half alone —
 * `parseUsage` cannot be used here, because it requires both billable counters at once and
 * would discard the output total the delta is the only source of.
 */
export function mergeStreamUsage(
  current: ChatResponse['usage'] | undefined,
  frame: AnthropicUsage | undefined,
): ChatResponse['usage'] | undefined {
  if (!frame) return current;
  const integer = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const inputTokens = integer(frame.input_tokens);
  const outputTokens = integer(frame.output_tokens);
  // Nothing usable in this frame: keep whatever is already known rather than blanking it.
  if (inputTokens === undefined && outputTokens === undefined) return current;
  const promptTokens = inputTokens ?? current?.promptTokens;
  const completionTokens = outputTokens ?? current?.completionTokens;
  // Input and output may be known in isolation, so totals/derived counters only appear with
  // both halves — an incomplete pair stays unreported instead of being invented.
  if (promptTokens === undefined || completionTokens === undefined) {
    return {
      ...(current ?? { promptTokens: 0, completionTokens: 0 }),
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
    } as ChatResponse['usage'];
  }
  // Cache counters are subsets of the input; they only stay credible against a real input count.
  // The frame that carries the output total has none of them, so a counter already learned from
  // `message_start` must be carried across rather than dropped.
  const counter = (value: number | undefined, previous: number | undefined): number | undefined => {
    const candidate = value ?? previous;
    return candidate === undefined || candidate > promptTokens ? undefined : candidate;
  };
  const cachedPromptTokens = counter(integer(frame.cache_read_input_tokens), current?.cachedPromptTokens);
  const cacheWriteTokens = counter(integer(frame.cache_creation_input_tokens), current?.cacheWriteTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

/** The content-block index an event refers to; `0` is a real index, so absence is explicit. */
export function blockIndexOf(payload: Record<string, unknown>): number {
  const index = payload.index;
  return typeof index === 'number' && Number.isFinite(index) ? index : 0;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asUsage(value: unknown): AnthropicUsage | undefined {
  return asRecord(value) as AnthropicUsage | undefined;
}
