// Request-shape probe for the SP-08 baseline comparison.
//
// It runs one frozen load through the real main loop and reports, per request,
// the facts a cache policy can act on:
//
//   - the request's own character count and the request it extends,
//   - the shared prefix in characters (how much of the previous request is
//     literally repeated at the start of this one),
//   - the shared prefix up to the provider's cache boundary,
//   - the system prompt's stable head, and
//   - the advertised tool catalog, by digest.
//
// It is deterministic and needs no Provider: the model is scripted. The output
// is a per-request table so the same probe can be run against two checkouts and
// compared line by line. Character counts only: no token estimate, no cost
// estimate, and nothing here is Provider cache evidence.
import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import type { ChatRequest } from '@littlesheep/llm';
import { textMessage, type AgentTool, type RunContext } from '@littlesheep/types';
import { createExecuteStage } from '../stages/execute.js';
import { createReplyStage } from '../stages/reply.js';
import { createMockLlm, makeCtx, makeTool, textResponse, toolCallResponse } from '../tests/helpers.js';

/**
 * The marker the prompt builder places at its cache boundary.
 *
 * Inlined instead of imported so this probe can run unchanged against an older
 * checkout, which is the whole point of a before/after comparison.
 */
const CACHE_BOUNDARY_MARKER = '<!-- LITTLESHEEP_CACHE_BOUNDARY -->';

export interface ProbeRequest {
  index: number;
  label: string;
  characters: number;
  messages: number;
  sharedPrefixCharacters?: number;
  sharedPrefixRatio?: number;
  sharedHeadAtBoundary?: number;
  stableHeadCharacters: number;
  catalog: string;
}

export interface ProbeReport {
  probe: string;
  freeze: string;
  model: string;
  toolNames: string[];
  requests: ProbeRequest[];
  publishedReply?: string;
}

/** Every source of non-determinism in a probe run, recorded for the reader. */
export interface ProbeOptions {
  probe: string;
  freeze: string;
  model?: string;
  config?: typeof DEFAULT_CONFIG;
}

function bodyOf(request: ChatRequest): string {
  return request.messages.map((message) => JSON.stringify(message)).join('\u0000');
}

function sharedPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function stableHead(system: string): number {
  const boundary = system.indexOf(CACHE_BOUNDARY_MARKER);
  return boundary < 0 ? system.length : boundary;
}

function catalogDigest(tools: ChatRequest['tools']): string {
  const names = (tools ?? []).map((spec) => spec.function.name);
  return names.length === 0
    ? 'none'
    : `${names.join(',')}#${createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 8)}`;
}

class ProbeRecorder {
  private readonly requests: ProbeRequest[] = [];
  private previousBody = '';
  private readonly tools: AgentTool[];

  constructor(tools: AgentTool[]) {
    this.tools = tools;
  }

  record(label: string, request: ChatRequest): void {
    const body = bodyOf(request);
    const system = typeof request.messages[0]?.content === 'string'
      ? request.messages[0]!.content as string
      : '';
    const prefix = this.previousBody === '' ? undefined : sharedPrefix(this.previousBody, body);
    this.requests.push({
      index: this.requests.length + 1,
      label,
      characters: body.length,
      messages: request.messages.length,
      ...(prefix === undefined ? {} : {
        sharedPrefixCharacters: prefix,
        sharedPrefixRatio: Number((prefix / Math.max(1, this.previousBody.length)).toFixed(4)),
      }),
      stableHeadCharacters: stableHead(system),
      catalog: catalogDigest(request.tools),
    });
    this.previousBody = body;
  }

  report(options: ProbeOptions, publishedReply?: string): ProbeReport {
    return {
      probe: options.probe,
      freeze: options.freeze,
      model: options.model ?? 'test',
      toolNames: this.tools.map((tool) => tool.name),
      requests: this.requests,
      ...(publishedReply === undefined ? {} : { publishedReply }),
    };
  }
}

function frozenTools(): AgentTool[] {
  return [
    makeTool('read', { ok: true, output: 'file contents' }),
    makeTool('web_search', { ok: true, output: 'results' }),
    makeTool('web_fetch', { ok: true, output: 'page' }),
    makeTool('document_read', { ok: true, output: 'doc' }),
  ];
}

function frozenContext(inbound: string, tools: AgentTool[]): RunContext {
  const ctx = makeCtx({
    tools,
    toolSources: Object.fromEntries(tools.map((tool) => [tool.name, 'builtin'])),
    inbound: textMessage('user', inbound),
    bootstrap: {
      'SOUL.md': 'Use a calm, concise voice.',
      'USER.md': 'The user is a developer.',
      'AGENTS.md': 'Workspace instructions for the frozen load.',
    },
  });
  ctx.memoryRootIndex = '# Memory Tree Root Index\n- `projects`: project facts\n- `daily`: dated details';
  ctx.profilePromptAddon = 'Frozen profile addon.';
  return ctx;
}

/** Load A: a local turn, then a web turn, then a local turn, in one session. */
export async function runFrozenLocalWebLocal(options: ProbeOptions): Promise<ProbeReport> {
  const tools = frozenTools();
  const recorder = new ProbeRecorder(tools);
  const turns = [
    '搜索我的项目文件里有哪些 web_search 调用',
    '查一下今天的公开新闻',
    '帮我写一个函数',
  ];
  for (const [turnIndex, inbound] of turns.entries()) {
    let call = 0;
    const llm = createMockLlm((request) => {
      recorder.record(`turn${turnIndex + 1}.call${++call}`, request);
      return textResponse(`answer ${turnIndex + 1}`);
    });
    await createExecuteStage({
      model: options.model ?? 'test',
      config: options.config ?? DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      llm,
    })(frozenContext(inbound, tools));
  }
  return recorder.report(options, 'answer 3');
}

/** Load B: a tool loop that merges a KnownState change and a memory release. */
export async function runFrozenToolLoop(options: ProbeOptions): Promise<ProbeReport> {
  const tools = frozenTools();
  const recorder = new ProbeRecorder(tools);
  let call = 0;
  const llm = createMockLlm((request) => {
    call += 1;
    recorder.record(`loop.call${call}`, request);
    return call <= 3
      ? toolCallResponse([{ id: `c${call}`, name: 'read', args: { file_path: `notes-${call}.md` } }])
      : textResponse('read all three notes');
  });
  const ctx = frozenContext('read the three notes', tools);
  ctx.memoryContextWorkingSet = {
    revision: 1,
    activeAtomIds: ['atom-a'],
    releasedAtomIds: [],
    activeCallByAtom: { 'atom-a': 'call-1' },
    callAtomIds: { 'call-1': ['atom-a', 'atom-b'] },
    updatedAt: '2026-09-21T00:00:00.000Z',
  };
  const outcome = await createExecuteStage({
    model: options.model ?? 'test',
    config: options.config ?? DEFAULT_CONFIG,
    branding: DEFAULT_BRANDING,
    llm,
  })(ctx);
  return recorder.report(options, String(ctx.reply ?? outcome.ok));
}

/** Load C: a conversational turn and a tool turn sharing one context. */
export async function runFrozenChatVersusTool(options: ProbeOptions): Promise<ProbeReport> {
  const tools = frozenTools();
  const recorder = new ProbeRecorder(tools);
  let call = 0;
  const toolLlm = createMockLlm((request) => {
    call += 1;
    recorder.record('tool.call1', request);
    return textResponse('tool answer');
  });
  await createExecuteStage({
    model: options.model ?? 'test',
    config: options.config ?? DEFAULT_CONFIG,
    branding: DEFAULT_BRANDING,
    llm: toolLlm,
  })(frozenContext('look at the workspace', tools));

  const replyLlm = createMockLlm((request) => {
    recorder.record('chat.call1', request);
    return textResponse('chat answer');
  });
  await createReplyStage({
    model: options.model ?? 'test',
    config: options.config ?? DEFAULT_CONFIG,
    branding: DEFAULT_BRANDING,
    llm: replyLlm,
  })(frozenContext('hello there', tools));
  return recorder.report(options, 'chat answer');
}

export const FROZEN_LOADS = [
  { name: 'local-web-local', run: runFrozenLocalWebLocal },
  { name: 'tool-loop', run: runFrozenToolLoop },
  { name: 'chat-versus-tool', run: runFrozenChatVersusTool },
] as const;
