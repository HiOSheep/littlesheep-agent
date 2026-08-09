import { describe, expect, it } from 'vitest';
import type { ReplyProvenance } from '@littlesheep/types';
import { makeCtx } from './tests/helpers.js';
import { clearReplyState, writeReplyState } from './reply-state.js';

const provenance: ReplyProvenance = {
  version: 1,
  source: 'llm',
  purpose: 'reply',
  modelRequestId: 'request-1',
  modelRequestIndex: 1,
  provider: 'test',
  model: 'test-model',
  generatedAt: '2026-08-10T00:00:00.000Z',
  rewriteCount: 0,
};

describe('reply state boundary', () => {
  it('commits visible text and provenance together', () => {
    const ctx = makeCtx({ reply: 'old' });

    writeReplyState(ctx, 'reply', { reply: 'new', replyProvenance: provenance });

    expect(ctx.reply).toBe('new');
    expect(ctx.replyProvenance).toEqual(provenance);
  });

  it('validates the whole batch before mutating context', () => {
    const ctx = makeCtx({ reply: 'old', replyProvenance: provenance });

    expect(() => writeReplyState(ctx, 'finalize', {
      reply: 'must not publish',
      replyProvenance: undefined,
    })).toThrow(/cannot be written during 'finalize'/);

    expect(ctx.reply).toBe('old');
    expect(ctx.replyProvenance).toEqual(provenance);
  });

  it('clears both fields through the same stage-checked entry point', () => {
    const ctx = makeCtx({ reply: 'draft', replyProvenance: provenance });

    clearReplyState(ctx, 'execute');

    expect(ctx.reply).toBeUndefined();
    expect(ctx.replyProvenance).toBeUndefined();
  });

  it('rejects unknown reply fields without mutation', () => {
    const ctx = makeCtx({ reply: 'old', replyProvenance: provenance });

    expect(() => writeReplyState(ctx, 'reply', {
      reply: 'new',
      // @ts-expect-error regression coverage for runtime callers
      unexpected: 'value',
    })).toThrow(/Unknown reply state field/);

    expect(ctx.reply).toBe('old');
    expect(ctx.replyProvenance).toEqual(provenance);
  });
});
