// SP-06: one model question must not cost a second model request.
//
// When the model asks the user something through `request_user_input`, its
// wording already exists and already has a Provider request behind it. Routing
// that question to ASK_USER for a *second* wording call bought nothing: the same
// question, re-generated. Measured here by watching the Provider call count.
//
// The counter-case matters just as much: when the Runtime escalates and there is
// no model question, ASK_USER composes one — and if that composition returns
// nothing, the turn fails loudly instead of publishing the Runtime draft as if
// the model had written it.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import type { ClarificationRequest, RunContext } from '@littlesheep/types';
import { textMessage } from '@littlesheep/types';
import { createExecuteStage } from './stages/execute.js';
import { createAskUserStage } from './stages/ask_user.js';
import { createMockLlm, makeCtx, textResponse, toolCallResponse } from './tests/helpers.js';

const deps = { model: 'test', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING };

function modelQuestionContext(modelRequestId: string): RunContext {
  const ctx = makeCtx({ inbound: textMessage('user', 'fix that file') });
  const request: ClarificationRequest = {
    id: 'run-1:user-input',
    kind: 'ambiguous_request',
    sourceStage: 'execute',
    createdAt: '2026-09-21T00:00:00.000Z',
    originalRequest: 'fix that file',
    copySource: 'model',
    copyModelRequestId: modelRequestId,
    prompt: 'Which file should I change, README.md or package.json?',
    blockingReason: 'Which file should I change, README.md or package.json?',
    questions: [{
      id: 'question-1',
      field: 'targetFile',
      prompt: 'Which file should I change, README.md or package.json?',
      required: true,
      options: ['README.md', 'package.json'],
    }],
  };
  ctx.clarificationRequest = request;
  ctx.modelRequests = [{
    version: 1,
    id: modelRequestId,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    stage: 'execute',
    requestIndex: 2,
    provider: 'test-provider',
    model: 'test',
    createdAt: '2026-09-21T00:00:00.000Z',
    messages: [],
    totalMessageCount: 0,
    messagesTruncated: false,
    toolNames: [],
    totalToolCount: 0,
    toolsTruncated: false,
    stream: false,
    callContract: {
      purpose: 'execute_tool_loop',
    } as NonNullable<NonNullable<RunContext['modelRequests']>[number]['callContract']>,
  }];
  return ctx;
}

describe('clarification does not repeat the model call', () => {
  it('publishes the question the model already asked, with no second request', async () => {
    const ctx = modelQuestionContext('request-that-asked');
    const llm = createMockLlm(textResponse('THIS SECOND WORDING MUST NOT BE USED'));
    const stage = createAskUserStage({ llm, model: 'test' });

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'finalize', ok: true });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(ctx.reply).toBe('Which file should I change, README.md or package.json?');
    expect(ctx.clarificationRequest?.prompt).toBe(ctx.reply);
    // The proof points at the request that authored the wording, not at a new one.
    expect(ctx.replyProvenance).toMatchObject({
      source: 'llm',
      purpose: 'execute_tool_loop',
      modelRequestId: 'request-that-asked',
      rewriteCount: 0,
    });
  });

  it('still composes one wording call when the Runtime escalated', async () => {
    const llm = createMockLlm(textResponse('要我重试，还是先停下来？'));
    const ctx = makeCtx({
      inbound: textMessage('user', '继续'),
      lastError: { stage: 'execute', message: 'permission denied' },
    });
    const stage = createAskUserStage({ llm, model: 'test' });

    const result = await stage(ctx);

    expect(result.meta?.escalated).toBe(true);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toBe('要我重试，还是先停下来？');
    expect(ctx.replyProvenance?.purpose).toBe('ask_user');
  });

  it('fails loudly instead of publishing the Runtime draft as the Agent reply', async () => {
    // Two empty responses: the composer has nothing of the model's to publish.
    const llm = createMockLlm(textResponse(''));
    const ctx = makeCtx({
      inbound: textMessage('user', '继续'),
      lastError: { stage: 'execute', message: 'permission denied' },
    });
    const stage = createAskUserStage({ llm, model: 'test' });

    const result = await stage(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no visible text/);
    // Nothing was published under the model's name.
    expect(ctx.reply).toBeUndefined();
    expect(ctx.replyProvenance).toBeUndefined();
    expect(ctx.lastError?.stage).toBe('ask_user');
  });

  it('carries the model request id from the execute route to the stage', async () => {
    const llm = createMockLlm(toolCallResponse([{
      id: 'q1',
      name: 'request_user_input',
      args: { field: 'targetFile', prompt: '要改哪个文件？', required: true },
    }]));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', '帮我改一下那个文件') });

    const result = await stage(ctx);

    expect(result.next).toBe('ask_user');
    expect(ctx.clarificationRequest?.prompt).toBe('要改哪个文件？');
    expect(ctx.clarificationRequest?.copySource).toBe('model');
    // The id of the request that actually produced the question.
    expect(ctx.clarificationRequest?.copyModelRequestId).toBeTruthy();
    expect(ctx.modelRequests?.some((request) => (
      request.id === ctx.clarificationRequest?.copyModelRequestId
    ))).toBe(true);
  });
});
