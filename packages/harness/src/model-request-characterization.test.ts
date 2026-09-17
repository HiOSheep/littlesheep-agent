import { describe, expect, it } from 'vitest';
import type { ChatContentPart, ChatRequest } from '@littlesheep/llm';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { textMessage } from '@littlesheep/types';
import { createDecideStage } from './stages/decide.js';
import { createExecuteStage } from './stages/execute.js';
import { createReplyStage } from './stages/reply.js';
import { createMockLlm, makeCtx, makeTool, textResponse } from './tests/helpers.js';

const deps = { model: 'test-model', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING };

function makeObservableContext() {
  const ctx = makeCtx({
    inbound: textMessage('user', 'CURRENT_INPUT_SENTINEL'),
    history: [
      textMessage('user', 'PRIOR_USER_SENTINEL'),
      textMessage('assistant', 'PRIOR_ASSISTANT_SENTINEL'),
    ],
    bootstrap: { 'AGENTS.md': 'BOOTSTRAP_SENTINEL' },
  });
  ctx.memoryRootIndex = 'MEMORY_ROOT_SENTINEL';
  ctx.profilePromptAddon = 'PROFILE_SENTINEL';
  ctx.reasoningPromptAddon = 'REASONING_SENTINEL';
  ctx.attachments = [{
    path: 'C:/tmp/image.png',
    name: 'image.png',
    kind: 'image',
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,abc',
  }];
  return ctx;
}

function textPart(parts: ChatContentPart[]): string {
  return parts.find((part): part is Extract<ChatContentPart, { type: 'text' }> => part.type === 'text')?.text ?? '';
}

/** Everything after the system message: conversation, then trailing stage sections. */
function trailingText(request: ChatRequest): string {
  return request.messages.slice(1).map((message) => String(message.content)).join('\n');
}

function expectCommonPayloadShape(request: ChatRequest, options: { includesBootstrap?: boolean } = {}) {
  expect(request.model).toBe('test-model');
  const roles = request.messages.map((message) => message.role);
  // The conversation keeps its stable order; every volatile Context section
  // travels afterwards as a trailing system message.
  expect(roles.slice(0, 5)).toEqual(['system', 'user', 'assistant', 'user', 'user']);
  expect(roles.slice(5).every((role) => role === 'system')).toBe(true);
  expect(roles.length).toBeGreaterThanOrEqual(6);
  if (options.includesBootstrap !== false) {
    expect(request.messages.map((message) => String(message.content)).join('\n')).toContain('BOOTSTRAP_SENTINEL');
  }
  expect(request.messages.map((message) => String(message.content)).join('\n')).toContain('MEMORY_ROOT_SENTINEL');
  // The system message is the canonical shared head only; stage addons such as
  // the behaviour profile now travel after the conversation so that every stage
  // of the turn shares the same cached prefix.
  expect(String(request.messages[0]?.content)).not.toContain('PROFILE_SENTINEL');
  expect(request.messages.map((message) => String(message.content)).join('\n')).toContain('PROFILE_SENTINEL');
  expect(request.messages[1]?.content).toBe('PRIOR_USER_SENTINEL');
  expect(request.messages[2]?.content).toBe('PRIOR_ASSISTANT_SENTINEL');
  expect(String(request.messages[3]?.content)).toContain('Attached files manifest');
  const inbound = request.messages[4]?.content;
  expect(Array.isArray(inbound)).toBe(true);
  expect(textPart(inbound as ChatContentPart[])).toContain('CURRENT_INPUT_SENTINEL');
  expect(inbound).toContainEqual({
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,abc', detail: 'auto' },
  });
}

function expectRecordedSnapshot(
  ctx: ReturnType<typeof makeObservableContext>,
  stage: 'decide' | 'execute' | 'reply',
  stream = false,
) {
  expect(ctx.modelRequests).toHaveLength(1);
  expect(ctx.modelRequests?.[0]).toMatchObject({
    stage,
    requestIndex: 1,
    model: 'test-model',
    messagesTruncated: false,
    stream,
  });
  // 5 conversation messages, the trailing Runtime block and any volatile
  // Context sections below the system-prompt cache boundary.
  expect(ctx.modelRequests?.[0]?.totalMessageCount).toBeGreaterThanOrEqual(6);
  expect(ctx.contextSnapshots).toHaveLength(1);
  expect(ctx.contextSnapshots?.[0]).toMatchObject({
    id: ctx.modelRequests?.[0]?.contextSnapshotId,
    model: 'test-model',
    itemsTruncated: false,
    budget: { status: 'unknown' },
    localTokenLedger: { accuracy: 'unavailable' },
  });
  const items = ctx.contextSnapshots?.[0]?.items ?? [];
  const kinds = items.map((item) => item.kind);
  expect(ctx.contextSnapshots?.[0]?.totalItemCount).toBe(items.length);
  expect(kinds).toEqual(expect.arrayContaining([
    'memory_index',
    'output_constraint',
  ]));
  if (stage === 'reply') {
    // REPLY shares the canonical head with the other stages, so it now carries
    // project knowledge (workspace) instead of dropping it.
    expect(kinds).toContain('project_knowledge');
  } else {
    expect(kinds).toContain('project_knowledge');
  }
  // The volatile Context sections and the Runtime block travel after the
  // conversation, so the cacheable prefix is the system prompt plus history.
  const lastConversationIndex = kinds.lastIndexOf('user_input');
  expect(kinds.indexOf('runtime_event')).toBeGreaterThan(lastConversationIndex);
  expect(items.at(-1)?.kind).toBe('runtime_event');
}

describe('LLM request characterization', () => {
  it('DECIDE sends the assembled system prompt, history, and multimodal inbound in stable order', async () => {
    const requests: ChatRequest[] = [];
    const llm = createMockLlm((request) => {
      requests.push(request);
      return textResponse('{"plan":[{"description":"inspect the request"}]}');
    });
    const stage = createDecideStage({ ...deps, llm });

    const ctx = makeObservableContext();
    await stage(ctx);

    expect(requests).toHaveLength(1);
    expectCommonPayloadShape(requests[0]!);
    // The stage contract and behaviour addons travel after the conversation;
    // only the canonical shared head stays in the system message.
    expect(String(requests[0]!.messages[0]?.content)).not.toContain('DECIDE stage');
    expect(trailingText(requests[0]!)).toContain('DECIDE stage');
    expect(trailingText(requests[0]!)).toContain('REASONING_SENTINEL');
    expect(requests[0]!.temperature).toBe(0);
    expect(requests[0]!.max_tokens).toBe(1_400);
    expect(requests[0]!.tools).toBeUndefined();
    expectRecordedSnapshot(ctx, 'decide');
  });

  it('EXECUTE sends the same base ordering plus registered tool specs', async () => {
    const requests: ChatRequest[] = [];
    const llm = createMockLlm((request) => {
      requests.push(request);
      return textResponse('done');
    });
    const tool = makeTool('inspect', { ok: true, output: 'unused' });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeObservableContext();
    ctx.tools = [tool];

    await stage(ctx);

    expect(requests).toHaveLength(1);
    expectCommonPayloadShape(requests[0]!);
    expect(trailingText(requests[0]!)).toContain('REASONING_SENTINEL');
    expect(requests[0]!.tools?.map((spec) => spec.function.name)).toEqual(['inspect']);
    expect(requests[0]!.tool_choice).toBe('auto');
    expect(requests[0]!.temperature).toBe(0);
    expectRecordedSnapshot(ctx, 'execute');
  });

  it('REPLY uses the same base ordering without exposing tools to the chat path', async () => {
    const requests: ChatRequest[] = [];
    const llm = createMockLlm((request) => {
      requests.push(request);
      return textResponse('reply');
    });
    const stage = createReplyStage({ ...deps, llm });

    const ctx = makeObservableContext();
    await stage(ctx);

    expect(requests).toHaveLength(1);
    expectCommonPayloadShape(requests[0]!, { includesBootstrap: false });
    expect(String(requests[0]!.messages[0]?.content)).not.toContain('BOOTSTRAP_SENTINEL');
    expect(String(requests[0]!.messages[0]?.content)).not.toContain('REASONING_SENTINEL');
    // The canonical shared head is emitted for every stage, REPLY included.
    expect(String(requests[0]!.messages[0]?.content)).toContain('# Core Flow');
    expect(String(requests[0]!.messages[0]?.content)).toContain('# Workspace');
    expect(requests[0]!.temperature).toBe(0.7);
    expect(requests[0]!.max_tokens).toBe(1_200);
    expect(requests[0]!.tools).toBeUndefined();
    expectRecordedSnapshot(ctx, 'reply');
  });

  it('REPLY records the actual streaming transport when deltas are requested', async () => {
    const llm = createMockLlm(textResponse('streamed reply'));
    const stage = createReplyStage({ ...deps, llm });
    const ctx = makeObservableContext();
    ctx.onAssistantDelta = () => undefined;

    await stage(ctx);

    expect(llm.chatStream).toHaveBeenCalledOnce();
    const request = llm.chatStream.mock.calls[0]?.[0] as ChatRequest;
    expect(request.stream).toBe(true);
    expectRecordedSnapshot(ctx, 'reply', true);
  });
});
