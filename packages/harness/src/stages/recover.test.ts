// @littlesheep/harness — stages/recover.test.ts
import { describe, it, expect } from 'vitest';
import { createRecoverStage } from './recover.js';
import { createMockLlm, textResponse, makeCtx } from '../tests/helpers.js';
import { textMessage } from '@littlesheep/types';

const deps = { model: 'test' };

describe('recoverStage', () => {
  it('retry action → execute, with revisedPlan', async () => {
    const llm = createMockLlm(textResponse(
      '{"action":"retry","revisedPlan":[{"description":"new step"}],"reason":"try again"}',
    ));
    const stage = createRecoverStage({ ...deps, llm });
    const ctx = makeCtx({
      recoveryAttempts: 0,
      maxRecoveryAttempts: 3,
      lastError: { stage: 'execute', message: 'fail' },
      inbound: textMessage('user', 'go'),
    });
    const res = await stage(ctx);
    expect(res.next).toBe('execute');
    expect(res.ok).toBe(true);
    expect(ctx.recoveryAttempts).toBe(1);
    expect(ctx.plan).toEqual([{ description: 'new step' }]);
    expect(ctx.modelRequests?.map((request) => request.stage)).toEqual(['recover']);
  });

  it('retry without revisedPlan keeps existing plan', async () => {
    const llm = createMockLlm(textResponse('{"action":"retry"}'));
    const stage = createRecoverStage({ ...deps, llm });
    const ctx = makeCtx({
      recoveryAttempts: 0,
      plan: [{ description: 'old plan' }],
      lastError: { stage: 'execute', message: 'fail' },
      inbound: textMessage('user', 'go'),
    });
    const res = await stage(ctx);
    expect(res.next).toBe('execute');
    expect(ctx.plan).toEqual([{ description: 'old plan' }]);
  });

  it('includes the active Soul when recovery wording may reach the user', async () => {
    const systemPrompts: string[] = [];
    const llm = createMockLlm((request) => {
      systemPrompts.push(String(request.messages[0]?.content ?? ''));
      return textResponse('{"action":"retry","reason":"try again"}');
    });
    const stage = createRecoverStage({ ...deps, llm });
    const ctx = makeCtx({
      recoveryAttempts: 0,
      lastError: { stage: 'execute', message: 'fail' },
      inbound: textMessage('user', '继续'),
      bootstrap: { 'SOUL.md': 'SOUL_SENTINEL_RECOVER_VOICE' },
    });

    await stage(ctx);

    expect(systemPrompts[0]).toContain('SOUL_SENTINEL_RECOVER_VOICE');
  });

  it('escalate action → ask_user', async () => {
    const llm = createMockLlm(textResponse('{"action":"escalate","reason":"stuck"}'));
    const stage = createRecoverStage({ ...deps, llm });
    const ctx = makeCtx({
      recoveryAttempts: 0,
      lastError: { stage: 'execute', message: 'fail' },
      inbound: textMessage('user', 'go'),
    });
    const res = await stage(ctx);
    expect(res.next).toBe('ask_user');
  });

  it('publishes an escalation question from the same recovery model call', async () => {
    const llm = createMockLlm(textResponse(JSON.stringify({
      action: 'escalate',
      reason: 'A target is required before retrying.',
      userMessage: 'Which target should I use for the retry?',
    })));
    const stage = createRecoverStage({ ...deps, llm });
    const ctx = makeCtx({
      recoveryAttempts: 0,
      lastError: { stage: 'execute', message: 'missing target' },
      inbound: textMessage('user', 'continue'),
    });

    const res = await stage(ctx);

    expect(res.next).toBe('finalize');
    expect(ctx.reply).toBe('Which target should I use for the retry?');
    expect(ctx.replyProvenance).toMatchObject({ purpose: 'recover', source: 'llm' });
    expect(ctx.clarificationRequest).toMatchObject({
      sourceStage: 'recover',
      copySource: 'model',
      prompt: 'Which target should I use for the retry?',
    });
  });

  it('abort action → finalize', async () => {
    const llm = createMockLlm(textResponse('{"action":"abort","reason":"I cannot continue safely."}'));
    const stage = createRecoverStage({ ...deps, llm });
    const ctx = makeCtx({
      recoveryAttempts: 0,
      lastError: { stage: 'execute', message: 'fail' },
      inbound: textMessage('user', 'go'),
    });
    const res = await stage(ctx);
    expect(res.next).toBe('finalize');
    expect(ctx.reply).toBe('I cannot continue safely.');
  });

  it('forced escalate when recoveryAttempts exceeds max', async () => {
    const llm = createMockLlm(textResponse('{"action":"retry"}'));
    const stage = createRecoverStage({ ...deps, llm });
    const ctx = makeCtx({
      recoveryAttempts: 3, // already at max (max=3)
      maxRecoveryAttempts: 3,
      lastError: { stage: 'execute', message: 'fail' },
      inbound: textMessage('user', 'go'),
    });
    const res = await stage(ctx);
    expect(res.next).toBe('ask_user');
    expect(res.meta).toMatchObject({ forcedEscalate: true });
    expect(ctx.recoveryAttempts).toBe(4);
    expect(llm.chat).not.toHaveBeenCalled(); // short-circuits before LLM
  });

  it('LLM returns non-JSON → fallback escalate', async () => {
    const llm = createMockLlm([
      textResponse('not json'),
      textResponse('still not'),
      textResponse('nope'),
    ]);
    const stage = createRecoverStage({ ...deps, llm });
    const ctx = makeCtx({
      recoveryAttempts: 0,
      lastError: { stage: 'execute', message: 'fail' },
      inbound: textMessage('user', 'go'),
    });
    const res = await stage(ctx);
    expect(res.next).toBe('ask_user');
    expect(res.meta).toMatchObject({ fallbackEscalate: true });
  });

  it('increments recoveryAttempts on each call', async () => {
    const llm = createMockLlm(textResponse('{"action":"retry"}'));
    const stage = createRecoverStage({ ...deps, llm });
    const ctx = makeCtx({
      recoveryAttempts: 0,
      lastError: { stage: 'execute', message: 'fail' },
      inbound: textMessage('user', 'go'),
    });
    await stage(ctx);
    expect(ctx.recoveryAttempts).toBe(1);
    await stage(ctx);
    expect(ctx.recoveryAttempts).toBe(2);
  });
});
