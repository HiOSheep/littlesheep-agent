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

function expectCommonPayloadShape(request: ChatRequest, options: { includesBootstrap?: boolean } = {}) {
  expect(request.model).toBe('test-model');
  expect(request.messages.map((message) => message.role)).toEqual([
    'system',
    'user',
    'assistant',
    'user',
    'user',
    // Volatile Runtime facts travel after the conversation so a per-request
    // clock change cannot break the Provider's prefix cache.
    'system',
  ]);
  if (options.includesBootstrap !== false) {
    expect(String(request.messages[0]?.content)).toContain('BOOTSTRAP_SENTINEL');
  }
  expect(String(request.messages[0]?.content)).toContain('MEMORY_ROOT_SENTINEL');
  expect(String(request.messages[0]?.content)).toContain('PROFILE_SENTINEL');
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
    totalMessageCount: 6,
    messagesTruncated: false,
    stream,
  });
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
    expect(kinds).not.toContain('project_knowledge');
  } else {
    expect(kinds).toContain('project_knowledge');
  }
  const tailKinds = items.slice(-6).map((item) => item.kind);
  expect(tailKinds).toEqual(expect.arrayContaining([
    'recent_message',
    'attachment_manifest',
    'user_input',
    'runtime_event',
  ]));
  // The volatile Runtime Context item stays last so the cacheable prefix is
  // the system prompt plus the whole conversation.
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
    expect(String(requests[0]!.messages[0]?.content)).toContain('DECIDE stage');
    expect(String(requests[0]!.messages[0]?.content)).toContain('REASONING_SENTINEL');
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
    expectCommonPayloadShape(requests[0]!, { includesBootstrap: false });
    expect(String(requests[0]!.messages[0]?.content)).not.toContain('BOOTSTRAP_SENTINEL');
    expect(String(requests[0]!.messages[0]?.content)).not.toContain('REASONING_SENTINEL');
    expect(String(requests[0]!.messages[0]?.content)).not.toContain('# Core Flow');
    expect(String(requests[0]!.messages[0]?.content)).not.toContain('# Workspace');
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
