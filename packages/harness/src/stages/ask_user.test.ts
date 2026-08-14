// @littlesheep/harness - stages/ask_user.test.ts
import { describe, expect, it } from 'vitest';
import { createAskUserStage } from './ask_user.js';
import { createMockLlm, makeCtx, textResponse } from '../tests/helpers.js';
import { textMessage } from '@littlesheep/types';

describe('askUserStage', () => {
  it('renders and preserves a structured clarification request', async () => {
    const llm = createMockLlm(textResponse('请选择目标文件：README.md 还是 package.json？'));
    const stage = createAskUserStage({ llm, model: 'test' });
    const ctx = makeCtx({
      inbound: textMessage('user', '修改那个文件'),
      clarificationRequest: {
        id: 'run-1:clarification',
        kind: 'missing_information',
        sourceStage: 'decide',
        createdAt: '2026-07-10T00:00:00.000Z',
        originalRequest: '修改那个文件',
        copySource: 'model',
        blockingReason: '没有目标路径',
        questions: [{
          id: 'question-1',
          field: 'targetPath',
          prompt: '请选择目标文件。',
          required: true,
          options: ['README.md', 'package.json'],
        }],
      },
    });

    const result = await stage(ctx);

    expect(result.next).toBe('finalize');
    expect(result.meta?.clarificationRequestId).toBe('run-1:clarification');
    expect(ctx.reply).toBe('请选择目标文件：README.md 还是 package.json？');
    expect(ctx.clarificationRequest?.prompt).toBe(ctx.reply);
    expect(ctx.lastError).toBeUndefined();
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(ctx.replyProvenance?.source).toBe('llm');
  });

  it('uses the LLM and active Soul to compose runtime-generated clarification copy', async () => {
    const systemPrompts: string[] = [];
    const llm = createMockLlm((request) => {
      systemPrompts.push(String(request.messages[0]?.content ?? ''));
      return textResponse('这一步需要你的决定：要我重试，还是先停下来？');
    });
    const stage = createAskUserStage({ llm, model: 'test' });
    const ctx = makeCtx({
      inbound: textMessage('user', '继续执行'),
      lastError: { stage: 'execute', message: 'permission denied' },
      bootstrap: { 'SOUL.md': 'SOUL_SENTINEL_ASK_USER_VOICE' },
    });

    const result = await stage(ctx);

    expect(result.meta?.escalated).toBe(true);
    expect(ctx.clarificationRequest?.kind).toBe('recovery_decision');
    expect(ctx.clarificationRequest?.sourceStage).toBe('execute');
    expect(ctx.clarificationRequest?.copySource).toBe('model');
    expect(ctx.reply).toBe('这一步需要你的决定：要我重试，还是先停下来？');
    expect(systemPrompts[0]).toContain('SOUL_SENTINEL_ASK_USER_VOICE');
    expect(ctx.modelRequests?.at(-1)?.callContract?.purpose).toBe('ask_user');
    expect(ctx.replyProvenance?.purpose).toBe('ask_user');
  });

  it('passes a bounded clarification chain instead of dropping prior correction context', async () => {
    const payloads: string[] = [];
    const llm = createMockLlm((request) => {
      payloads.push(String(request.messages[1]?.content ?? ''));
      return textResponse('Please confirm the remaining output format.');
    });
    const stage = createAskUserStage({ llm, model: 'test' });
    const priorRequest = {
      id: 'prior-request',
      kind: 'recovery_decision' as const,
      sourceStage: 'recover' as const,
      createdAt: '2026-08-14T00:00:00.000Z',
      originalRequest: 'Complete the PDF task.',
      blockingReason: 'Permission and output format were missing.',
      questions: [
        { id: 'q1', field: 'permission', prompt: 'Enable permission.', required: true },
        { id: 'q2', field: 'outputFormat', prompt: 'Choose the output format.', required: true },
      ],
    };
    const ctx = makeCtx({
      inbound: textMessage('user', 'SECRET_ANSWER_PERMISSION_ENABLED', {
        clarificationResponse: {
          requestId: priorRequest.id,
          answer: 'SECRET_ANSWER_PERMISSION_ENABLED',
          answeredAt: '2026-08-14T00:01:00.000Z',
        },
      }),
      history: [textMessage('assistant', 'Need more information.', { clarificationRequest: priorRequest })],
      clarificationResponse: {
        requestId: priorRequest.id,
        answer: 'SECRET_ANSWER_PERMISSION_ENABLED',
        answeredAt: '2026-08-14T00:01:00.000Z',
      },
      clarificationRequest: {
        id: 'follow-up-request',
        kind: 'missing_information',
        sourceStage: 'decide',
        createdAt: '2026-08-14T00:02:00.000Z',
        originalRequest: 'Complete the PDF task.',
        blockingReason: 'The output format is still missing.',
        questions: [{
          id: 'q3',
          field: 'outputFormat',
          prompt: 'Choose the remaining output format.',
          required: true,
        }],
      },
      taskBook: {
        assessment: {
          userNeed: 'Complete the PDF task.',
          complexity: 'standard',
          goal: 'Complete the PDF task.',
          successCriteria: ['A PDF is delivered.'],
          requiresTaskBook: true,
          maxExtraScopeRatio: 1.2,
        },
        goal: 'Complete the PDF task.',
        complexity: 'standard',
        successCriteria: ['A PDF is delivered.'],
        steps: [],
        overdeliveryPolicy: { maxExtraScopeRatio: 1.2, guidance: 'Stay focused.' },
      },
      lastError: { stage: 'execute', message: 'output format unavailable' },
    });

    await stage(ctx);

    expect(ctx.clarificationRequest?.clarificationChain).toMatchObject({
      previousRequestId: 'prior-request',
      previousSourceStage: 'recover',
      answeredFields: ['permission'],
      remainingFields: ['outputFormat'],
      taskGoal: 'Complete the PDF task.',
      failureStage: 'execute',
      attachmentCount: 0,
    });
    expect(payloads[0]).toContain('clarificationChain');
    expect(payloads[0]).not.toContain('SECRET_ANSWER_PERMISSION_ENABLED');
  });

  it('rewrites a model reply when it exactly repeats a recent assistant message', async () => {
    const llm = createMockLlm([
      textResponse('请告诉我目标文件。'),
      textResponse('为了继续处理，请先指定要修改的文件。'),
    ]);
    const stage = createAskUserStage({ llm, model: 'test' });
    const ctx = makeCtx({
      inbound: textMessage('user', '修改那个文件'),
      history: [textMessage('assistant', '请告诉我目标文件。')],
      lastError: { stage: 'decide', message: 'target path missing' },
    });

    await stage(ctx);

    expect(ctx.reply).toBe('为了继续处理，请先指定要修改的文件。');
    expect(ctx.replyProvenance?.rewriteCount).toBe(1);
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('retries an empty high-reasoning response with a larger direct-output budget', async () => {
    const requests: Array<{ maxTokens?: number; thinking?: string; effort?: string }> = [];
    const llm = createMockLlm((request) => {
      requests.push({
        maxTokens: request.max_tokens,
        thinking: request.thinking?.type,
        effort: request.reasoning_effort,
      });
      return requests.length === 1
        ? textResponse('')
        : textResponse('请告诉我需要修改的目标文件。');
    });
    const stage = createAskUserStage({ llm, model: 'deepseek-v4-flash' });
    const ctx = makeCtx({
      inbound: textMessage('user', '修改那个文件'),
      lastError: { stage: 'decide', message: 'target path missing' },
    });
    ctx.resolvedRunConfig = {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      reasoning: 'ultra',
    } as NonNullable<typeof ctx.resolvedRunConfig>;

    const result = await stage(ctx);

    expect(result.next).toBe('finalize');
    expect(ctx.reply).toBe('请告诉我需要修改的目标文件。');
    expect(requests).toEqual([
      { maxTokens: 320, thinking: 'disabled', effort: undefined },
      { maxTokens: 640, thinking: 'disabled', effort: undefined },
    ]);
  });
});
