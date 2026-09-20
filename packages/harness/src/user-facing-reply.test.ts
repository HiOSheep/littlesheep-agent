// Locks the AGENTS.md contract: a user-visible Agent reply is only ever the
// text a real Provider call produced. Runtime never authors a template, never
// fabricates a reply on a registry failure, and never regenerates wording just
// to avoid repeating an earlier turn — the same correct answer may be repeated.
import { describe, expect, it, vi } from 'vitest';
import { asSessionId, textMessage, type RunContext } from '@littlesheep/types';
import { publishUserFacingReply } from './user-facing-reply.js';

const REPLAY_TIME = '2026-09-11T00:00:00.000Z';

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run-reply',
    sessionId: asSessionId('session-reply'),
    model: 'test/model',
    history: [],
    produced: [],
    runtimeNow: () => new Date(REPLAY_TIME),
    toolContext: { log: vi.fn() },
    modelRequests: [{
      id: 'request-reply',
      requestIndex: 0,
      provider: 'test',
      model: 'test/model',
      callContract: { purpose: 'reply' },
    }],
    ...overrides,
  } as unknown as RunContext;
}

describe('user-facing reply publication', () => {
  it('publishes the model text once and records its Provider provenance', async () => {
    const reserve = vi.fn(async () => true);
    const ctx = context({ reserveUserFacingReplySettlement: reserve });

    const reply = await publishUserFacingReply(ctx, 'reply', '  Fresh model reply  ');

    expect(reply).toBe('Fresh model reply');
    expect(ctx.reply).toBe('Fresh model reply');
    expect(ctx.replyProvenance).toMatchObject({
      source: 'llm',
      purpose: 'reply',
      modelRequestId: 'request-reply',
      rewriteCount: 0,
    });
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('publishes wording that repeats an earlier turn instead of regenerating it', async () => {
    const reserve = vi.fn(async () => true);
    const ctx = context({
      history: [textMessage('assistant', 'Same reply')],
      reserveUserFacingReplySettlement: reserve,
    });

    const reply = await publishUserFacingReply(ctx, 'reply', 'Same reply');

    expect(reply).toBe('Same reply');
    expect(ctx.reply).toBe('Same reply');
    expect(ctx.replyProvenance?.rewriteCount).toBe(0);
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('treats a text-only ledger repeat as published rather than refused', async () => {
    const reserve = vi.fn(async () => false);
    const ctx = context({ reserveUserFacingReply: reserve });

    const reply = await publishUserFacingReply(ctx, 'reply', 'Same reply');

    expect(reply).toBe('Same reply');
    expect(ctx.reply).toBe('Same reply');
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(ctx.toolContext.log).toHaveBeenCalledWith('warn', expect.stringContaining('repeats text'));
  });

  it('refuses a second, different reply for one settlement instead of double publishing', async () => {
    const ctx = context({ reserveUserFacingReplySettlement: async () => false });

    const reply = await publishUserFacingReply(ctx, 'reply', 'Conflicting reply');

    expect(reply).toBeUndefined();
    expect(ctx.reply).toBeUndefined();
    expect(ctx.finalReplySettlement).toBeUndefined();
  });

  it('fails closed instead of inventing text when the registry cannot reserve', async () => {
    const ctx = context({
      reserveUserFacingReplySettlement: async () => { throw new Error('registry offline'); },
    });

    await expect(publishUserFacingReply(ctx, 'reply', 'Model reply'))
      .rejects.toMatchObject({ reason: 'reply_registry_failed' });
    expect(ctx.reply).toBeUndefined();
  });

  it('rejects an empty model reply and a missing Provider provenance', async () => {
    await expect(publishUserFacingReply(context(), 'reply', '   '))
      .rejects.toMatchObject({ reason: 'empty_model_reply' });
    await expect(publishUserFacingReply(context({ modelRequests: [] }), 'reply', 'text'))
      .rejects.toMatchObject({ reason: 'missing_model_request_provenance' });
  });

  it('requires the pinned Provider request when a caller supplies one', async () => {
    await expect(publishUserFacingReply(
      context(),
      'reply',
      'text',
      undefined,
      'request-that-never-happened',
    )).rejects.toMatchObject({ reason: 'missing_model_request_provenance' });
  });

  it('rejects control markup at the final publication boundary', async () => {
    // Built from an encoded literal so the control syntax never appears as
    // plain source text in this repository or its diffs.
    const control = decodeURIComponent(
      '%3C%EF%BD%9C%EF%BD%9CDSML%EF%BD%9C%EF%BD%9Cinvoke%3E',
    );
    await expect(publishUserFacingReply(context(), 'reply', control))
      .rejects.toMatchObject({ reason: 'invalid_control_markup' });
  });
});
