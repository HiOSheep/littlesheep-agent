// Locks the AGENTS.md contract: a user-visible Agent reply is only ever the
// text a real Provider call produced. Runtime may reject a duplicate, ask for
// at most two real regenerations, or fail closed — it never authors a
// template, and a registry failure never fabricates a reply.
import { describe, expect, it, vi } from 'vitest';
import { asSessionId, textMessage, type RunContext } from '@littlesheep/types';
import {
  MAX_VISIBLE_REPLY_REWRITES,
  acceptUniqueUserFacingReply,
  reserveUserFacingReplyOnce,
  UserFacingReplyError,
} from './user-facing-reply.js';

const REPLAY_TIME = '2026-09-11T00:00:00.000Z';

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run-reply',
    sessionId: asSessionId('session-reply'),
    model: 'test/model',
    history: [],
    produced: [],
    runtimeNow: () => new Date(REPLAY_TIME),
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

describe('user-facing reply acceptance', () => {
  it('publishes the model text once and records its Provider provenance', async () => {
    const reserve = vi.fn(async () => true);
    const ctx = context({ reserveUserFacingReplySettlement: reserve });

    const reply = await reserveUserFacingReplyOnce(ctx, 'reply', '  Fresh model reply  ');

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

  it('fails closed instead of inventing text when the registry cannot reserve', async () => {
    const ctx = context({
      reserveUserFacingReplySettlement: async () => { throw new Error('registry offline'); },
    });

    await expect(reserveUserFacingReplyOnce(ctx, 'reply', 'Model reply'))
      .rejects.toMatchObject({ reason: 'reply_registry_failed' });
    expect(ctx.reply).toBeUndefined();
  });

  it('rejects an empty model reply and a missing Provider provenance', async () => {
    await expect(reserveUserFacingReplyOnce(context(), 'reply', '   '))
      .rejects.toMatchObject({ reason: 'empty_model_reply' });
    await expect(reserveUserFacingReplyOnce(context({ modelRequests: [] }), 'reply', 'text'))
      .rejects.toMatchObject({ reason: 'missing_model_request_provenance' });
  });

  it('rejects DSML control syntax at the final publication boundary', async () => {
    const control = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="exec"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
    await expect(reserveUserFacingReplyOnce(context(), 'reply', control))
      .rejects.toMatchObject({ reason: 'invalid_control_markup' });
  });

  it('asks the Provider to regenerate a duplicate rather than reusing published text', async () => {
    const seen: string[] = [];
    const ctx = context({
      history: [textMessage('assistant', 'Same reply')],
      reserveUserFacingReplySettlement: async () => true,
    });

    const reply = await acceptUniqueUserFacingReply(ctx, 'reply', 'Same reply', async (input) => {
      seen.push(input.generatedReply);
      expect(input.avoidReplies).toContain('Same reply');
      expect(input.attempt).toBe(1);
      return 'A genuinely new reply';
    });

    expect(seen).toEqual(['Same reply']);
    expect(reply).toBe('A genuinely new reply');
    expect(ctx.replyProvenance?.rewriteCount).toBe(1);
  });

  it('fails closed after the bounded regenerations still repeat published text', async () => {
    const ctx = context({
      reserveUserFacingReplySettlement: async () => false,
    });
    const rewrite = vi.fn(async () => 'Still duplicated');

    await expect(acceptUniqueUserFacingReply(ctx, 'reply', 'Duplicated', rewrite))
      .rejects.toMatchObject({ reason: 'duplicate_model_reply' });
    expect(rewrite).toHaveBeenCalledTimes(MAX_VISIBLE_REPLY_REWRITES);
    expect(ctx.reply).toBeUndefined();
  });

  it('fails closed when the regeneration call itself fails', async () => {
    const ctx = context({ reserveUserFacingReplySettlement: async () => false });

    await expect(acceptUniqueUserFacingReply(ctx, 'reply', 'Duplicated', async () => {
      throw new Error('provider timeout');
    })).rejects.toMatchObject({ reason: 'rewrite_failed' });
    expect(ctx.reply).toBeUndefined();
  });

  it('never returns Runtime-authored text as the Agent reply', async () => {
    const ctx = context({ reserveUserFacingReplySettlement: async () => false });
    let caught: unknown;
    try {
      await acceptUniqueUserFacingReply(ctx, 'reply', 'Duplicated', async () => 'Duplicated');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UserFacingReplyError);
    expect(ctx.reply).toBeUndefined();
    expect(ctx.finalReplySettlement).toBeUndefined();
  });
});
