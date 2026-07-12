// @littlesheep/harness — stages/finalize.test.ts
import { describe, it, expect } from 'vitest';
import { createFinalizeStage } from './finalize.js';
import { createMockSessionManager, makeCtx } from '../tests/helpers.js';
import { textMessage } from '@littlesheep/types';

describe('finalizeStage', () => {
  it('builds assistant Message from ctx.reply, pushes to produced, transitions to exit', async () => {
    const sm = createMockSessionManager();
    const stage = createFinalizeStage({ sessionManager: sm });
    const ctx = makeCtx({ reply: 'hello back', sessionId: 's1' });
    const res = await stage(ctx);
    expect(res.next).toBe('exit');
    expect(res.ok).toBe(true);
    expect(ctx.produced).toHaveLength(1);
    expect(ctx.produced[0].role).toBe('assistant');
    expect(ctx.produced[0].content).toEqual([{ type: 'text', text: 'hello back' }]);
    expect(sm.append).toHaveBeenCalledWith('s1', ctx.produced);
  });

  it('uses "(no reply)" placeholder when ctx.reply is empty', async () => {
    const sm = createMockSessionManager();
    const stage = createFinalizeStage({ sessionManager: sm });
    const ctx = makeCtx({ reply: '' });
    await stage(ctx);
    expect(ctx.produced[0].content).toEqual([{ type: 'text', text: '(no reply)' }]);
  });

  it('sessionManager.append failure does NOT block (returns ok:true)', async () => {
    const sm = createMockSessionManager({ appendThrows: new Error('disk full') });
    const stage = createFinalizeStage({ sessionManager: sm });
    const ctx = makeCtx({ reply: 'ok' });
    const res = await stage(ctx);
    expect(res.ok).toBe(true);
    expect(res.next).toBe('exit');
    expect(ctx.produced).toHaveLength(1); // msg still pushed before persist
  });

  it('meta.produced reflects produced count (preexisting + new)', async () => {
    const sm = createMockSessionManager();
    const stage = createFinalizeStage({ sessionManager: sm });
    const ctx = makeCtx({
      reply: 'x',
      produced: [textMessage('user', 'preexisting')],
    });
    const res = await stage(ctx);
    expect(res.meta?.produced).toBe(2); // 1 preexisting + 1 new assistant
    expect(sm.append).toHaveBeenCalledTimes(1);
  });

  it('persists a clarification request on the assistant message', async () => {
    const sm = createMockSessionManager();
    const stage = createFinalizeStage({ sessionManager: sm });
    const ctx = makeCtx({
      reply: 'Which file?',
      clarificationRequest: {
        id: 'run-1:clarification',
        kind: 'missing_information',
        sourceStage: 'decide',
        createdAt: '2026-07-10T00:00:00.000Z',
        originalRequest: 'edit it',
        blockingReason: 'target missing',
        questions: [{
          id: 'question-1', field: 'path', prompt: 'Which file?', required: true,
        }],
      },
    });

    await stage(ctx);

    expect(ctx.produced[0]?.clarificationRequest?.id).toBe('run-1:clarification');
  });
});
