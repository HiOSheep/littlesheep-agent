// @littlesheep/harness — stages/finalize.test.ts
import { describe, it, expect } from 'vitest';
import { createFinalizeStage } from './finalize.js';
import { createMockSessionManager, makeCtx } from '../tests/helpers.js';
import { textMessage } from '@littlesheep/types';

const replyProvenance = {
  version: 1 as const,
  source: 'llm' as const,
  purpose: 'reply' as const,
  modelRequestId: 'model-request-1',
  modelRequestIndex: 1,
  provider: 'test-provider',
  model: 'test-model',
  generatedAt: '2026-07-17T00:00:00.000Z',
  rewriteCount: 0,
};

describe('finalizeStage', () => {
  it('builds assistant Message from ctx.reply, pushes to produced, transitions to exit', async () => {
    const sm = createMockSessionManager();
    const stage = createFinalizeStage({ sessionManager: sm });
    const ctx = makeCtx({
      reply: 'hello back',
      replyProvenance,
      sessionId: 's1',
      initialMemoryContext: 'The project uses pnpm and the repository root is the workspace.',
    });
    const res = await stage(ctx);
    expect(res.next).toBe('exit');
    expect(res.ok).toBe(true);
    expect(ctx.produced).toHaveLength(1);
    expect(ctx.produced[0].role).toBe('assistant');
    expect(ctx.produced[0].content).toEqual([{ type: 'text', text: 'hello back' }]);
    expect(ctx.produced[0].replyProvenance).toEqual(replyProvenance);
    expect(ctx.memoryContinuityAssessment?.status).toBe('unavailable');
    expect(ctx.memoryContinuityAssessment?.method).toBe('answer-evidence-v1');
    expect(ctx.memoryContinuityAssessment?.missingSignals).toContain(
      'reply_context_observability_unavailable',
    );
    expect(sm.append).toHaveBeenCalledWith('s1', ctx.produced);
  });

  it('rejects an empty or unprovenanced reply instead of persisting a placeholder', async () => {
    const sm = createMockSessionManager();
    const stage = createFinalizeStage({ sessionManager: sm });
    const ctx = makeCtx({ reply: '' });
    const result = await stage(ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing or untraceable Provider API/);
    expect(ctx.produced).toEqual([]);
    expect(ctx.memoryContinuityAssessment?.status).toBe('unavailable');
    expect(sm.append).not.toHaveBeenCalled();
  });

  it('rejects reply provenance that cannot be traced to a real model request', async () => {
    const sm = createMockSessionManager();
    const stage = createFinalizeStage({ sessionManager: sm });
    const ctx = makeCtx({
      reply: 'This text has only a forged provenance object.',
      replyProvenance,
      modelRequests: [],
    });

    const result = await stage(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/untraceable Provider API/);
    expect(ctx.produced).toEqual([]);
    expect(sm.append).not.toHaveBeenCalled();
  });

  it('treats sessionManager.append failure as a runtime failure', async () => {
    const sm = createMockSessionManager({ appendThrows: new Error('disk full') });
    const stage = createFinalizeStage({ sessionManager: sm });
    const ctx = makeCtx({ reply: 'ok', replyProvenance });
    const res = await stage(ctx);
    expect(res.ok).toBe(false);
    expect(res.next).toBe('exit');
    expect(ctx.produced).toHaveLength(1); // msg still pushed before persist
    expect(res.error).toMatch(/could not persist/);
  });

  it('settles the durable final reply only after the session write', async () => {
    const sm = createMockSessionManager();
    const events: string[] = [];
    const stage = createFinalizeStage({ sessionManager: sm });
    const ctx = makeCtx({
      reply: 'durable answer',
      replyProvenance,
      appendDurableEvent: async (event) => {
        events.push(event.type);
      },
    });

    const res = await stage(ctx);

    expect(res.ok).toBe(true);
    expect(events).toEqual(['final_reply_proposed', 'final_reply_settled']);
    expect(sm.append).toHaveBeenCalledTimes(1);
  });

  it('meta.produced reflects produced count (preexisting + new)', async () => {
    const sm = createMockSessionManager();
    const stage = createFinalizeStage({ sessionManager: sm });
    const ctx = makeCtx({
      reply: 'x',
      replyProvenance,
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
      replyProvenance: { ...replyProvenance, purpose: 'ask_user' },
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
