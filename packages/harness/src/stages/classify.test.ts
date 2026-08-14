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
});
