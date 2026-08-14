// @littlesheep/harness — stages/recover.test.ts
import { describe, it, expect } from 'vitest';
import { createRecoverStage } from './recover.js';
import { createMockLlm, textResponse, makeCtx, makeTool } from '../tests/helpers.js';
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

  it('retries DECIDE locally after the first structured decode failure', async () => {
    const llm = createMockLlm(textResponse('{"action":"abort","reason":"core capability damaged"}'));
    const stage = createRecoverStage({ ...deps, llm });
    const ctx = makeCtx({
      recoveryAttempts: 0,
      lastError: { stage: 'decide', message: 'failed to decode decision after 2 attempt(s)' },
      inbound: textMessage('user', '请只回复 OK'),
    });

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'decide', ok: true, meta: { deterministicRetry: true } });
    expect(ctx.reply).toBeUndefined();
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('does not publish a broad abort claim for a repeated structured decode failure', async () => {
    const llm = createMockLlm(textResponse('{"action":"abort","reason":"core capability damaged"}'));
    const stage = createRecoverStage({ ...deps, llm });
    const ctx = makeCtx({
      recoveryAttempts: 1,
      lastError: { stage: 'decide', message: 'failed to decode decision after 2 attempt(s)' },
      inbound: textMessage('user', '执行任务'),
    });

    const result = await stage(ctx);

    expect(result).toMatchObject({ next: 'decide', ok: true, meta: { action: 'retry', coercedAbort: true } });
    expect(ctx.reply).toBeUndefined();
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

  it('tells recovery which run tools can be added to a revised TaskBook step', async () => {
    const recoveryPrompts: string[] = [];
    const llm = createMockLlm((request) => {
      recoveryPrompts.push(String(request.messages.at(-1)?.content ?? ''));
      return textResponse(JSON.stringify({
        action: 'retry',
        revisedPlan: [{ description: 'read the document', tools: ['document_read'] }],
      }));
    });
    const stage = createRecoverStage({ ...deps, llm });
    const ctx = makeCtx({
      tools: [makeTool('document_read', { ok: true, output: 'document body' })],
      recoveryAttempts: 0,
      lastError: {
        stage: 'execute',
        message: 'tool is registered for this run but not available in the current TaskBook step: document_read',
      },
      plan: [{ description: 'create the document', tools: ['document_create'] }],
      inbound: textMessage('user', '读取并生成文档'),
    });

    const result = await stage(ctx);

    expect(result.next).toBe('execute');
    expect(ctx.plan).toEqual([{ description: 'read the document', tools: ['document_read'] }]);
    expect(recoveryPrompts[0]).toContain('Available run tools: document_read');
    expect(recoveryPrompts[0]).toContain('"tools":["document_create"]');
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

  it('honors one bound user retry after the checkpoint exhausted autonomous recovery', async () => {
    const llm = createMockLlm(textResponse('{"action":"escalate","reason":"do not call"}'));
    const stage = createRecoverStage({ ...deps, llm });
    const ctx = makeCtx({
      recoveryAttempts: 3,
      maxRecoveryAttempts: 3,
      lastError: { stage: 'execute', message: 'document_create was denied' },
      inbound: textMessage('user', '权限已经打开了，再试一次'),
    });
    ctx.entryStage = 'recover';
    ctx.resumedFromCheckpointId = 'waiting-document-checkpoint';
    ctx.conversationContinuation = {
      version: 1,
      resolution: 'bound',
      checkpointId: 'waiting-document-checkpoint',
      sourceRunId: 'source-run',
      disposition: 'retry',
      dispositionSource: 'model',
      resumeStage: 'recover',
      resumeRule: 'recover->recover',
    };

    const first = await stage(ctx);

    expect(first).toMatchObject({
      next: 'execute',
      ok: true,
      meta: {
        deterministicContinuationRetry: true,
        attempts: 4,
        failedStage: 'execute',
        resumedFromCheckpointId: 'waiting-document-checkpoint',
      },
    });
    expect(ctx.lastError).toEqual({ stage: 'execute', message: 'document_create was denied' });
    expect(ctx.recoveryAttempts).toBe(4);
    expect(llm.chat).not.toHaveBeenCalled();

    const second = await stage(ctx);

    expect(second).toMatchObject({
      next: 'ask_user',
      ok: true,
      meta: { forcedEscalate: true, attempts: 5 },
    });
    expect(llm.chat).not.toHaveBeenCalled();
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
