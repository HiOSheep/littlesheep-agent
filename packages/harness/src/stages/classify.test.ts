import { describe, expect, it } from 'vitest';
import { textMessage } from '@littlesheep/types';
import { createClassifyStage } from './classify.js';
import { createMockLlm, makeCtx, textResponse } from '../tests/helpers.js';

describe('classifyStage', () => {
  it('bypasses the generic classifier for a structurally bound checkpoint answer', async () => {
    const llm = createMockLlm(textResponse('{"activity":"clarify"}'));
    const stage = createClassifyStage({ llm, model: 'test/model' });
    const ctx = makeCtx({
      inbound: textMessage('user', 'Permission is available; retry.', {
        clarificationResponse: {
          requestId: 'request-1',
          answer: 'Permission is available; retry.',
          answeredAt: '2026-08-14T00:00:00.000Z',
        },
      }),
      clarificationResponse: {
        requestId: 'request-1',
        answer: 'Permission is available; retry.',
        answeredAt: '2026-08-14T00:00:00.000Z',
      },
    });
    ctx.resumedFromCheckpointId = 'checkpoint-1';

    await expect(stage(ctx)).resolves.toMatchObject({
      next: 'decide',
      ok: true,
      meta: { continuationGuard: true, checkpointId: 'checkpoint-1', requestId: 'request-1' },
    });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('corrects a classifier respond result to execute for a fresh Web request', async () => {
    const llm = createMockLlm(textResponse('{"activity":"respond","confidence":0.9,"reason":"chat"}'));
    const stage = createClassifyStage({ llm, model: 'test/model', rulesConfidenceThreshold: 2 });
    const ctx = makeCtx({ inbound: textMessage('user', '查一下今天的公开新闻') });

    await expect(stage(ctx)).resolves.toMatchObject({ next: 'decide', ok: true });
    expect(ctx.classification).toMatchObject({ activity: 'execute', retrievalIntent: 'web_search' });
  });

  it('corrects a classifier execute result to respond for a capability question', async () => {
    const llm = createMockLlm(textResponse('{"activity":"execute","confidence":0.9,"reason":"search"}'));
    const stage = createClassifyStage({ llm, model: 'test/model', rulesConfidenceThreshold: 2 });
    const ctx = makeCtx({ inbound: textMessage('user', 'LS 支持网络搜索吗？') });

    await expect(stage(ctx)).resolves.toMatchObject({ next: 'reply', ok: true });
    expect(ctx.classification).toMatchObject({ activity: 'respond', retrievalIntent: 'capability_question' });
  });

  it.each([
    ['搜索我的项目文件里有哪些 web_search 调用', 'local_workspace'],
    ['你还记得我上次的决定吗？', 'local_memory'],
  ])('keeps %s on a local retrieval route', async (message, retrievalIntent) => {
    const llm = createMockLlm(textResponse('{"activity":"execute","confidence":0.9,"reason":"local"}'));
    const stage = createClassifyStage({ llm, model: 'test/model', rulesConfidenceThreshold: 2 });
    const ctx = makeCtx({ inbound: textMessage('user', message) });

    await expect(stage(ctx)).resolves.toMatchObject({ next: 'decide', ok: true });
    expect(ctx.classification).toMatchObject({ activity: 'execute', retrievalIntent });
  });
});
