// @littlesheep/llm — responses-translate.ts
// Everything that maps between the neutral contract and the OpenAI **Responses** wire shapes.
//
// This is the pure half of the Responses client: request builders, response readers, and the
// small type declarations that describe the vendor JSON. Nothing here performs I/O, holds state,
// or knows about retries — that is `responses-client.ts`, and keeping the two apart is what makes
// the wire translation testable on its own.
//
// The Responses shapes differ from chat.completions in ways that each cause a hard 400 when
// translated naively, so every one of them is called out at the point it is handled.

import type { ChatContentPart, ChatMessage, ChatRequest, ChatResponse, ToolCall } from './types.js';
import { LlmError } from './types.js';
import { attachTransportUsage, type TransportTiming } from './transport-timing.js';

/** One entry of the Responses `input` array. Untyped beyond `type`, since the wire is loose. */
export type ResponsesInputItem = Record<string, unknown>;

/** A Responses function tool: flat, unlike chat.completions' nested `function` object. */
export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: object;
  strict?: boolean;
}

/** One item of the `output` array. A discriminated union would be stricter than the wire. */
export interface ResponsesOutputItem {
  type?: string;
  [key: string]: unknown;
}

/** A `response` object, as returned non-streaming or as `response.completed` carries it. */
export interface ResponsesResponse {
  id?: string;
  model?: string;
  status?: string;
  output?: ResponsesOutputItem[];
  output_text?: string | null;
  incomplete_details?: { reason?: string } | null;
  usage?: ResponsesUsage | null;
  error?: { message?: string; type?: string; code?: string } | null;
}

export interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

/**
 * One typed SSE event. Responses has no single delta shape: the event name decides what the
 * payload means, and the meaningful fields (`delta`, `item`, `response`, `error`) are only
 * present on the events that define them.
 */
export interface ResponsesStreamEvent {
  type?: string;
  /** Stream position of the item this event belongs to; the tool-call identity key. */
  output_index?: number;
  /** Item id (`msg_…` / `fc_…`), used only as a correlation hint. */
  item_id?: string;
  delta?: string;
  item?: ResponsesOutputItem;
  response?: ResponsesResponse;
  error?: { message?: string; type?: string; code?: string } | string;
  [key: string]: unknown;
}

export interface ResponsesEmbeddingResponse {
  model: string;
  data: { index: number; embedding: number[] }[];
  usage?: { prompt_tokens: number };
}

/** A function call being accumulated across streamed argument deltas. */
export interface PendingToolCall {
  id: string;
  name: string;
  args: string;
  emittedIdentity: boolean;
}

/** The neutral result a stream accumulates into, before transport metrics are attached. */
export interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: ChatResponse['finishReason'];
  model?: string;
  usage?: ChatResponse['usage'];
  reasoningContent?: string;
}

/** What one parsed SSE event may produce for the neutral stream. */
export interface ParsedEvent {
  delta?: string;
  reasoning?: string;
  toolCallIndex?: number;
  toolCallId?: string;
  toolCallName?: string;
  argsDelta?: string;
  usage?: ChatResponse['usage'];
  model?: string;
  /** A terminal provider signal, i.e. the answer is provably over. */
  completed?: boolean;
  finishReason?: ChatResponse['finishReason'];
  error?: LlmError;
}

/**
 * Translate a neutral message list into Responses `input` items.
 *
 * Three shapes differ from chat.completions, and each causes a 400 when translated naively:
 *  - a system/user message is `{role, content:[{type:'input_text', text}]}` (or `input_image`),
 *    not a bare string;
 *  - an assistant message's `tool_calls` are NOT a field on the assistant item: each call is a
 *    separate top-level `{type:'function_call'}` item, and its `call_id` — not the
 *    chat-completions `id` — is what a later `function_call_output` must reference;
 *  - a tool result is `{type:'function_call_output', call_id, output}`, not a `role:'tool'`
 *    message carrying a `tool_call_id`.
 */
export function buildResponsesInputItems(messages: ChatMessage[]): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      // One message item when there is text, plus one item per call. Order matters: Responses
      // replays the call items in the order they were made.
      const content = assistantContent(message.content);
      if (content.length > 0) items.push({ role: 'assistant', content });
      for (const call of message.tool_calls ?? []) {
        items.push({
          type: 'function_call',
          // `call_id` is the Responses identity for a call; `id` is item identity and is not
          // what the provider matches an output against, so it is left out entirely.
          call_id: call.id,
          name: call.function.name,
          // Arguments stay a JSON *string* here: one of the few fields Responses did not
          // convert to structured content.
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    if (message.role === 'tool') {
      items.push({
        type: 'function_call_output',
        // A tool message with no call id cannot be matched to anything; send it empty rather
        // than invent an id the provider would reject the mismatch on.
        call_id: message.tool_call_id ?? '',
        output: contentText(message.content),
      });
      continue;
    }
    // `system` and `user` share a shape: a role plus typed content parts.
    items.push({ role: message.role, content: inputContent(message.content) });
  }
  return items;
}

/** Translate a `ToolSpec` list into Responses function tools (flat, not nested). */
export function buildResponsesTools(tools: ChatRequest['tools']): ResponsesFunctionTool[] {
  return (tools ?? []).map((tool) => ({
    type: 'function' as const,
    name: tool.function.name,
    description: tool.function.description,
    // JSON Schema passes through unchanged: only the surrounding envelope moved.
    parameters: tool.function.parameters,
  }));
}

/**
 * Translate `tool_choice`. The three string shorthands are identical to chat.completions, but a
 * named function collapses from `{type:'function', function:{name}}` to `{type:'function', name}`.
 */
export function buildResponsesToolChoice(choice: ChatRequest['tool_choice']): unknown {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.function.name };
}

/**
 * Translate `reasoning_effort` into the Responses `reasoning` object.
 *
 * Responses accepts `none|minimal|low|medium|high|xhigh`; the neutral contract also carries
 * `max`, which Responses does not define. `max` maps to `xhigh`, the highest level the wire
 * accepts, rather than being dropped — dropping it would silently downgrade a user who asked
 * for maximum effort.
 */
export function buildResponsesReasoning(
  effort: ChatRequest['reasoning_effort'],
): { effort: string } | undefined {
  if (effort === undefined) return undefined;
  return { effort: effort === 'max' ? 'xhigh' : effort };
}

/**
 * Build the exact JSON body for `POST /responses`.
 *
 * Differences from the chat-completions body, each a hard 400 if carried over:
 *  - `input` instead of `messages`;
 *  - `max_output_tokens` instead of `max_tokens`;
 *  - `reasoning: {effort}` instead of a bare `reasoning_effort`;
 *  - no `stream_options`: a Responses stream reports usage unconditionally.
 */
export function buildResponsesRequestBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    input: buildResponsesInputItems(req.messages),
    stream,
  };
  const tools = buildResponsesTools(req.tools);
  if (tools.length > 0) body.tools = tools;
  const toolChoice = buildResponsesToolChoice(req.tool_choice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  // `max_tokens` is not a Responses field; sending it beside `max_output_tokens` is a 400.
  if (req.max_tokens !== undefined) body.max_output_tokens = req.max_tokens;
  const reasoning = buildResponsesReasoning(req.reasoning_effort);
  if (reasoning) body.reasoning = reasoning;
  return body;
}

/** Parse a non-streaming `response` object into the neutral shape. */
export function parseResponsesOutput(json: ResponsesResponse): ChatResponse {
  let content = '';
  let reasoningContent = '';
  const toolCalls: ToolCall[] = [];
  for (const item of json.output ?? []) {
    if (item.type === 'message') {
      content += outputItemText(item);
      continue;
    }
    if (item.type === 'function_call') {
      const call = functionCallOf(item);
      if (!call) continue;
      toolCalls.push({
        // The neutral `id` is the Responses `call_id`: it is what the harness replays back as
        // `function_call_output.call_id`, so substituting the item id would break the pairing.
        id: call.call_id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      });
      continue;
    }
    if (item.type === 'reasoning') {
      // Only summary text is a literal string; encrypted reasoning content is opaque and
      // carries nothing to replay, so it contributes nothing.
      reasoningContent += reasoningText(item);
    }
  }
  // An explicit incomplete status is the only provider signal that maps to `length`; a function
  // call otherwise asks the harness to run a tool regardless of what `status` says.
  const incomplete = json.status === 'incomplete'
    || json.incomplete_details?.reason === 'max_output_tokens';
  return {
    content,
    toolCalls,
    finishReason: finishReasonOf(incomplete, toolCalls.length > 0),
    reasoningContent: reasoningContent || undefined,
    usage: parseResponsesUsage(json.usage),
    model: json.model,
  };
}

/**
 * Responses token usage in the neutral shape.
 *
 * Reported integers only: a missing count must not be invented as 0 (see the package README).
 * Responses reports just the cached subset of input, so the uncached remainder is derived —
 * keeping the two disjoint is what the billing accounting above this package relies on.
 */
export function parseResponsesUsage(
  usage: ResponsesUsage | null | undefined,
): ChatResponse['usage'] | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.input_tokens;
  const completionTokens = usage.output_tokens;
  if (typeof promptTokens !== 'number' || !Number.isSafeInteger(promptTokens) || promptTokens < 0
    || typeof completionTokens !== 'number' || !Number.isSafeInteger(completionTokens) || completionTokens < 0) return undefined;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  if (!Number.isSafeInteger(totalTokens) || totalTokens < promptTokens + completionTokens) return undefined;
  const counter = (value: unknown, max: number): number | undefined => typeof value === 'number'
    && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
  const cachedPromptTokens = counter(usage.input_tokens_details?.cached_tokens, promptTokens);
  const reasoningTokens = counter(usage.output_tokens_details?.reasoning_tokens, completionTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
    ...(cachedPromptTokens === undefined ? {} : { uncachedPromptTokens: promptTokens - cachedPromptTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

/** Receipt usage for one physical response: the delivered usage plus transport timing. */
export function receiptUsage(
  request: ChatRequest,
  usage: NonNullable<ChatResponse['usage']>,
  timing: TransportTiming,
): ChatResponse['usage'] {
  return attachTransportUsage(
    { content: '', toolCalls: [], finishReason: 'stop', model: request.model, usage },
    timing,
    1,
    timing.startedAtMs,
  ).usage;
}

/** The neutral finish reason: a length stop beats a tool-call stop, which beats `stop`. */
export function finishReasonOf(incomplete: boolean, hasToolCalls: boolean): ChatResponse['finishReason'] {
  if (incomplete) return 'length';
  if (hasToolCalls) return 'tool_calls';
  return 'stop';
}

/** Serialize accumulated calls in `output_index` order. */
export function serializeToolCalls(toolCalls: Map<number, PendingToolCall>): ToolCall[] {
  return Array.from(toolCalls.entries())
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      // An id the provider never sent stays empty rather than being invented: the harness
      // matches the call to its output by this exact value.
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: call.args },
    }));
}

/**
 * An HTTP-shaped status carried on an `error` event.
 *
 * Accepts a numeric string as well as a number: providers send `code` as `"429"` about as often
 * as `429`, and a string that fell through here silently downgraded a rate limit to the generic
 * 502 default. Anything outside the HTTP status range, or a symbolic code like
 * `invalid_request_error`, is not a status and stays unknown.
 */
export function statusField(source: unknown, key: string): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const raw = (source as Record<string, unknown>)[key];
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

/** Whether a streamed error status is one the bounded retry may replay. */
export function isRetryableStreamStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * The provider's own explanation out of a Responses error body `{error:{message,type,code}}`.
 *
 * The message is the only part a human can act on, so it replaces the bare status. `type` and
 * `code` are not folded in: they are machine vocabulary the neutral contract has no field for.
 */
export function responsesErrorMessage(body: unknown): string | undefined {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' && message ? message : undefined;
}

/** Read a string field off a loose wire object, treating any other type as absent. */
export function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

/** A completed `function_call` item, or undefined when the wire omitted its identity. */
function functionCallOf(
  item: ResponsesOutputItem,
): { call_id: string; name: string; arguments: string } | undefined {
  const callId = stringField(item, 'call_id');
  const name = stringField(item, 'name');
  if (!callId || !name) return undefined;
  return { call_id: callId, name, arguments: stringField(item, 'arguments') };
}

/** Concatenate the `output_text` parts of a `message` item. */
function outputItemText(item: ResponsesOutputItem): string {
  const parts = item.content;
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  let text = '';
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if ((record.type === 'output_text' || record.type === 'text') && typeof record.text === 'string') {
      text += record.text;
    }
  }
  return text;
}

/** Concatenate reasoning summary text, the only replayable reasoning a response carries. */
function reasoningText(item: ResponsesOutputItem): string {
  const summary = item.summary;
  if (!Array.isArray(summary)) return '';
  let text = '';
  for (const part of summary) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (typeof record.text === 'string') text += record.text;
  }
  return text;
}

/** Plain text of a neutral message's content, for the `output` string of a tool result. */
function contentText(content: string | ChatContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/**
 * Input content parts. `input_text` is the input-side text type: `output_text` is only valid on
 * assistant *output* items, and sending it as input is rejected.
 */
function inputContent(content: string | ChatContentPart[]): Record<string, unknown>[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  return content.map((part) => part.type === 'text'
    ? { type: 'input_text', text: part.text }
    // `image_url` keeps its chat-completions shape (a string, or an object with `url`/`detail`),
    // because that is also the Responses shape.
    : { type: 'input_image', image_url: part.image_url });
}

/** Assistant content uses `output_text`, the output-side text type. */
function assistantContent(content: string | ChatContentPart[]): Record<string, unknown>[] {
  if (typeof content === 'string') return content ? [{ type: 'output_text', text: content }] : [];
  const parts: Record<string, unknown>[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) parts.push({ type: 'output_text', text: part.text });
    } else {
      parts.push({ type: 'input_image', image_url: part.image_url });
    }
  }
  return parts;
}
