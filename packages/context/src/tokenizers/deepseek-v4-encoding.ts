// Owns deterministic DeepSeek V4 message, thinking, and DSML tool framing
// before the official tokenizer converts the final prompt to token ids.
import type { ChatMessage, ChatRequest, ToolSpec } from '@littlesheep/llm';

export const DEEPSEEK_V4_BOS_TOKEN = '<｜begin▁of▁sentence｜>';
export const DEEPSEEK_V4_EOS_TOKEN = '<｜end▁of▁sentence｜>';

const THINKING_START_TOKEN = '<think>';
const THINKING_END_TOKEN = '</think>';
const DSML_TOKEN = '｜DSML｜';
const USER_TOKEN = '<｜User｜>';
const ASSISTANT_TOKEN = '<｜Assistant｜>';
const LATEST_REMINDER_TOKEN = '<｜latest_reminder｜>';
const TOOL_CALLS_BLOCK_NAME = 'tool_calls';

const TASK_TOKENS = {
  action: '<｜action｜>',
  query: '<｜query｜>',
  authority: '<｜authority｜>',
  domain: '<｜domain｜>',
  title: '<｜title｜>',
  read_url: '<｜read_url｜>',
} as const;

type DeepSeekTask = keyof typeof TASK_TOKENS;
type ThinkingMode = 'chat' | 'thinking';
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface DeepSeekToolCall {
  id?: string;
  type?: 'function';
  function: { name: string; arguments: string };
}

interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
}

type ContentBlock = TextBlock | ToolResultBlock;

export interface DeepSeekV4Message {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'latest_reminder' | 'direct_search_results';
  content?: string;
  reasoning_content?: string;
  tool_calls?: DeepSeekToolCall[];
  tool_call_id?: string;
  tools?: ToolSpec[];
  response_format?: JsonValue;
  content_blocks?: ContentBlock[];
  task?: DeepSeekTask;
  wo_eos?: boolean;
  mask?: number;
}

export interface EncodeDeepSeekV4MessagesOptions {
  thinkingMode: ThinkingMode;
  dropThinking?: boolean;
  addDefaultBosToken?: boolean;
  reasoningEffort?: 'high' | 'max';
}

const REASONING_EFFORT_MAX = [
  'Reasoning Effort: Absolute maximum with no shortcuts permitted.',
  'You MUST be very thorough in your thinking and comprehensively decompose the problem to resolve the root cause, rigorously stress-testing your logic against all potential paths, edge cases, and adversarial scenarios.',
  'Explicitly write out your entire deliberation process, documenting every intermediate step, considered alternative, and rejected hypothesis to ensure absolutely no assumption is left unchecked.',
  '',
  '',
].join('\n');

const TOOLS_TEMPLATE = `## Tools

You have access to a set of tools to help answer the user's question. You can invoke tools by writing a "<${DSML_TOKEN}tool_calls>" block like the following:

<${DSML_TOKEN}tool_calls>
<${DSML_TOKEN}invoke name="$TOOL_NAME">
<${DSML_TOKEN}parameter name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</${DSML_TOKEN}parameter>
...
</${DSML_TOKEN}invoke>
<${DSML_TOKEN}invoke name="$TOOL_NAME2">
...
</${DSML_TOKEN}invoke>
</${DSML_TOKEN}tool_calls>

String parameters should be specified as is and set \`string="true"\`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set \`string="false"\`.

If thinking_mode is enabled (triggered by ${THINKING_START_TOKEN}), you MUST output your complete reasoning inside ${THINKING_START_TOKEN}...${THINKING_END_TOKEN} BEFORE any tool calls or final response.

Otherwise, output directly after ${THINKING_END_TOKEN} with tool calls or final response.

### Available Tool Schemas

{tool_schemas}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.
`;

/** Render the actual DeepSeek V4 prompt before model tokenization. */
export function encodeDeepSeekV4Messages(
  inputMessages: readonly DeepSeekV4Message[],
  options: EncodeDeepSeekV4MessagesOptions,
): string {
  const thinkingMode = options.thinkingMode;
  const dropThinking = options.dropThinking ?? true;
  const addDefaultBosToken = options.addDefaultBosToken ?? true;
  let messages = sortToolResultsByCallOrder(mergeToolMessages(cloneMessages(inputMessages)));
  const effectiveDropThinking = messages.some((message) => (message.tools?.length ?? 0) > 0)
    ? false
    : dropThinking;
  if (thinkingMode === 'thinking' && effectiveDropThinking) {
    messages = dropEarlierThinking(messages);
  }

  let prompt = addDefaultBosToken ? DEEPSEEK_V4_BOS_TOKEN : '';
  for (let index = 0; index < messages.length; index++) {
    prompt += renderMessage(
      index,
      messages,
      thinkingMode,
      effectiveDropThinking,
      options.reasoningEffort,
    );
  }
  return prompt;
}

/** Convert LittleSheep's final OpenAI-compatible request to DeepSeek's official V4 prompt format. */
export function encodeDeepSeekV4Request(request: ChatRequest): string {
  const messages = request.messages.map(toDeepSeekMessage);
  if (request.tools && request.tools.length > 0) {
    const systemIndex = messages.findIndex((message) => message.role === 'system');
    if (systemIndex >= 0) {
      messages[systemIndex] = { ...messages[systemIndex]!, tools: structuredClone(request.tools) };
    } else {
      messages.unshift({ role: 'system', content: '', tools: structuredClone(request.tools) });
    }
  }
  if (request.tool_choice !== undefined && request.tool_choice !== 'auto') {
    throw new Error(`DeepSeek V4 exact counting does not cover tool_choice=${toolChoiceLabel(request.tool_choice)}.`);
  }
  const thinkingMode: ThinkingMode = request.thinking?.type === 'enabled' ? 'thinking' : 'chat';
  if (request.reasoning_effort !== undefined
    && request.reasoning_effort !== 'high'
    && request.reasoning_effort !== 'max') {
    throw new Error(`DeepSeek V4 exact counting does not cover reasoning_effort=${request.reasoning_effort}.`);
  }
  const reasoningEffort = resolveProviderPromptReasoningEffort(request);
  return encodeDeepSeekV4Messages(messages, {
    thinkingMode,
    dropThinking: request.thinking?.clear_thinking !== false,
    reasoningEffort,
  });
}

/**
 * DeepSeek's hosted Flash API applies the published max-effort prefix to its
 * default/high thinking path as well. Pro follows the open-weights encoder.
 * The remaining hosted-only max control tokens are accounted by the counter.
 */
function resolveProviderPromptReasoningEffort(request: ChatRequest): 'high' | 'max' | undefined {
  if (request.thinking?.type !== 'enabled') return undefined;
  const model = request.model.trim().toLowerCase();
  if (model === 'deepseek-v4-flash') return 'max';
  return request.reasoning_effort === 'max' ? 'max' : undefined;
}

function renderMessage(
  index: number,
  messages: readonly DeepSeekV4Message[],
  thinkingMode: ThinkingMode,
  dropThinking: boolean,
  reasoningEffort: 'high' | 'max' | undefined,
): string {
  const message = messages[index]!;
  const lastUserIndex = findLastUserIndex(messages);
  let prompt = index === 0 && thinkingMode === 'thinking' && reasoningEffort === 'max'
    ? REASONING_EFFORT_MAX
    : '';

  switch (message.role) {
    case 'system':
      prompt += message.content ?? '';
      if (message.tools?.length) prompt += `\n\n${renderTools(message.tools)}`;
      if (message.response_format !== undefined) {
        prompt += `\n\n## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n${pythonJson(message.response_format)}`;
      }
      break;
    case 'developer': {
      if (!message.content) throw new Error('DeepSeek V4 developer messages require content.');
      prompt += `${USER_TOKEN}${message.content}`;
      if (message.tools?.length) prompt += `\n\n${renderTools(message.tools)}`;
      if (message.response_format !== undefined) {
        prompt += `\n\n## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n${pythonJson(message.response_format)}`;
      }
      break;
    }
    case 'user':
      prompt += USER_TOKEN;
      if (message.content_blocks) {
        prompt += message.content_blocks.map(renderContentBlock).join('\n\n');
      } else {
        prompt += message.content ?? '';
      }
      break;
    case 'latest_reminder':
      prompt += `${LATEST_REMINDER_TOKEN}${message.content ?? ''}`;
      break;
    case 'tool':
      throw new Error('DeepSeek V4 tool messages must be merged before rendering.');
    case 'assistant': {
      const previousHasTask = index > 0 && messages[index - 1]?.task !== undefined;
      const reasoning = message.reasoning_content ?? '';
      let thinkingPart = '';
      if (thinkingMode === 'thinking' && !previousHasTask) {
        if (!dropThinking || index > lastUserIndex) thinkingPart = `${reasoning}${THINKING_END_TOKEN}`;
      }
      const toolCalls = message.tool_calls?.length
        ? `\n\n<${DSML_TOKEN}${TOOL_CALLS_BLOCK_NAME}>\n${message.tool_calls.map(renderToolCall).join('\n')}\n</${DSML_TOKEN}${TOOL_CALLS_BLOCK_NAME}>`
        : '';
      prompt += `${thinkingPart}${message.content ?? ''}${toolCalls}`;
      if (!message.wo_eos) prompt += DEEPSEEK_V4_EOS_TOKEN;
      break;
    }
    case 'direct_search_results':
      prompt += message.content ?? '';
      break;
  }

  const nextRole = messages[index + 1]?.role;
  if (nextRole !== undefined && nextRole !== 'assistant' && nextRole !== 'latest_reminder') return prompt;

  if (message.task !== undefined) {
    const taskToken = TASK_TOKENS[message.task];
    if (message.task === 'action') {
      prompt += `${ASSISTANT_TOKEN}${thinkingMode === 'thinking' ? THINKING_START_TOKEN : THINKING_END_TOKEN}${taskToken}`;
    } else {
      prompt += taskToken;
    }
  } else if (message.role === 'user' || message.role === 'developer') {
    prompt += ASSISTANT_TOKEN;
    prompt += thinkingMode === 'thinking' && (!dropThinking || index >= lastUserIndex)
      ? THINKING_START_TOKEN
      : THINKING_END_TOKEN;
  }
  return prompt;
}

function renderTools(tools: readonly ToolSpec[]): string {
  const schemas = tools.map((tool) => pythonJson(tool.function as unknown as JsonValue)).join('\n');
  return TOOLS_TEMPLATE.replace('{tool_schemas}', schemas);
}

function renderToolCall(toolCall: DeepSeekToolCall): string {
  return `<${DSML_TOKEN}invoke name="${toolCall.function.name}">\n${encodeArgumentsToDsml(toolCall)}\n</${DSML_TOKEN}invoke>`;
}

function encodeArgumentsToDsml(toolCall: DeepSeekToolCall): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.function.arguments);
  } catch {
    parsed = { arguments: toolCall.function.arguments };
  }
  const argumentsObject = isRecord(parsed) ? parsed : { arguments: parsed };
  return Object.entries(argumentsObject).map(([key, value]) => {
    const isString = typeof value === 'string';
    const rendered = isString ? value : pythonJson(value as JsonValue);
    return `<${DSML_TOKEN}parameter name="${key}" string="${isString ? 'true' : 'false'}">${rendered}</${DSML_TOKEN}parameter>`;
  }).join('\n');
}

function renderContentBlock(block: ContentBlock): string {
  if (block.type === 'text') return block.text;
  const content = Array.isArray(block.content)
    ? block.content.map((part) => part.type === 'text' ? part.text ?? '' : `[Unsupported ${part.type}]`).join('\n\n')
    : block.content;
  return `<tool_result>${content}</tool_result>`;
}

function mergeToolMessages(messages: DeepSeekV4Message[]): DeepSeekV4Message[] {
  const merged: DeepSeekV4Message[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const block: ToolResultBlock = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id ?? '',
        content: message.content ?? '',
      };
      const previous = merged.at(-1);
      if (previous?.role === 'user' && previous.content_blocks) {
        previous.content_blocks.push(block);
      } else {
        merged.push({ role: 'user', content_blocks: [block] });
      }
      continue;
    }
    if (message.role === 'user') {
      const block: TextBlock = { type: 'text', text: message.content ?? '' };
      const previous = merged.at(-1);
      if (previous?.role === 'user' && previous.content_blocks && previous.task === undefined) {
        previous.content_blocks.push(block);
      } else {
        merged.push({
          role: 'user',
          content: message.content ?? '',
          content_blocks: [block],
          task: message.task,
          wo_eos: message.wo_eos,
          mask: message.mask,
        });
      }
      continue;
    }
    merged.push(message);
  }
  return merged;
}

function sortToolResultsByCallOrder(messages: DeepSeekV4Message[]): DeepSeekV4Message[] {
  let callOrder = new Map<string, number>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      callOrder = new Map(message.tool_calls.flatMap((call, index) => call.id ? [[call.id, index]] : []));
      continue;
    }
    if (message.role !== 'user' || !message.content_blocks || callOrder.size === 0) continue;
    const sorted = message.content_blocks
      .filter((block): block is ToolResultBlock => block.type === 'tool_result')
      .sort((left, right) => (callOrder.get(left.tool_use_id) ?? 0) - (callOrder.get(right.tool_use_id) ?? 0));
    let sortedIndex = 0;
    message.content_blocks = message.content_blocks.map((block) => (
      block.type === 'tool_result' ? sorted[sortedIndex++]! : block
    ));
  }
  return messages;
}

function dropEarlierThinking(messages: DeepSeekV4Message[]): DeepSeekV4Message[] {
  const lastUserIndex = findLastUserIndex(messages);
  return messages.flatMap((message, index) => {
    if (['user', 'system', 'tool', 'latest_reminder', 'direct_search_results'].includes(message.role)
      || index >= lastUserIndex) return [message];
    if (message.role === 'assistant') {
      const { reasoning_content: _removed, ...rest } = message;
      return [rest];
    }
    return [];
  });
}

function findLastUserIndex(messages: readonly DeepSeekV4Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const role = messages[index]?.role;
    if (role === 'user' || role === 'developer') return index;
  }
  return -1;
}

function toDeepSeekMessage(message: ChatMessage): DeepSeekV4Message {
  if (typeof message.content !== 'string') {
    if (message.content.some((part) => part.type !== 'text')) {
      throw new Error('DeepSeek V4 exact counting is unavailable for image content.');
    }
    throw new Error('DeepSeek V4 official encoding does not define OpenAI content-part arrays.');
  }
  return {
    role: message.role,
    content: message.content,
    reasoning_content: message.reasoning_content,
    tool_calls: message.tool_calls ? structuredClone(message.tool_calls) : undefined,
    tool_call_id: message.tool_call_id,
  };
}

function cloneMessages(messages: readonly DeepSeekV4Message[]): DeepSeekV4Message[] {
  return structuredClone([...messages]);
}

/** Match Python json.dumps(..., ensure_ascii=False) separators used by the official encoder. */
function pythonJson(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('DeepSeek V4 tool JSON must contain finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
  return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(', ')}}`;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolChoiceLabel(choice: NonNullable<ChatRequest['tool_choice']>): string {
  return typeof choice === 'string' ? choice : choice.function.name;
}
