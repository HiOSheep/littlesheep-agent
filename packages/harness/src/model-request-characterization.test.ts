import { describe, expect, it } from 'vitest';
import type { ChatContentPart, ChatRequest } from '@littlesheep/llm';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { textMessage } from '@littlesheep/types';
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

function expectCommonPayloadShape(
  request: ChatRequest,
  options: { includesBootstrap?: boolean; tail?: 'append-only' | 'injected' } = {},
) {
  expect(request.model).toBe('test-model');
  const roles = request.messages.map((message) => message.role);
  // The main system prompt, then the conversation in its stable order. The
  // Runtime facts and the retrieval contract follow, either as the main loop's
  // append-only tail after the user turn (EXECUTE) or as the stable injected
  // facts directly after the system prompt (single-request stages such as
  // REPLY). Both keep the conversation itself contiguous and in order.
  const appendOnly = options.tail !== 'injected';
  const conversationStart = appendOnly ? 1 : 2;
  expect(roles.slice(conversationStart, conversationStart + 4))
    .toEqual(['user', 'assistant', 'user', 'user']);
  expect(roles.slice(conversationStart + 4).every((role) => role === 'system')).toBe(true);
  expect(roles.length).toBeGreaterThanOrEqual(conversationStart + 4);
  if (options.includesBootstrap !== false) {
    expect(request.messages.map((message) => String(message.content)).join('\n')).toContain('BOOTSTRAP_SENTINEL');
  }
  expect(request.messages.map((message) => String(message.content)).join('\n')).toContain('MEMORY_ROOT_SENTINEL');
  expect(String(request.messages[0]?.content)).toContain('PROFILE_SENTINEL');
  expect(request.messages[conversationStart]?.content).toBe('PRIOR_USER_SENTINEL');
  expect(request.messages[conversationStart + 1]?.content).toBe('PRIOR_ASSISTANT_SENTINEL');
  expect(String(request.messages[conversationStart + 2]?.content)).toContain('Attached files manifest');
  const inbound = request.messages[conversationStart + 3]?.content;
  expect(Array.isArray(inbound)).toBe(true);
  expect(textPart(inbound as ChatContentPart[])).toContain('CURRENT_INPUT_SENTINEL');
  expect(inbound).toContainEqual({
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,abc', detail: 'auto' },
  });
  // The per-run Runtime capability facts always reach the model exactly once.
  expect(request.messages.filter((message) => (
    String(message.content).includes('# Runtime Facts')
  ))).toHaveLength(1);
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
  // Runtime-owned Context (capability facts, volatile run state) is emitted
  // exactly once. The main loop (EXECUTE) appends it after the conversation, in
  // the tail it owns, so a later round extends the request instead of rewriting
  // it; a single-request stage (REPLY) still receives it as the stable facts
  // block that follows the system prompt.
  const firstConversationIndex = kinds.findIndex((kind) => kind === 'user_input');
  const runtimeIndices = kinds
    .map((kind, index) => (kind === 'runtime_event' ? index : -1))
    .filter((index) => index >= 0);
  expect(runtimeIndices.length).toBeGreaterThan(0);
  if (stage === 'execute') {
    expect(runtimeIndices[0]).toBeGreaterThan(firstConversationIndex);
    expect(items.at(-1)?.kind).toBe('runtime_event');
  } else {
    expect(runtimeIndices[0]).toBeLessThan(firstConversationIndex);
    expect(items.at(-1)?.kind).not.toBe('runtime_event');
  }
}

describe('LLM request characterization', () => {
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
    expect(String(requests[0]!.messages[0]?.content)).toContain('REASONING_SENTINEL');
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
    expectCommonPayloadShape(requests[0]!, { includesBootstrap: false, tail: 'injected' });
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
