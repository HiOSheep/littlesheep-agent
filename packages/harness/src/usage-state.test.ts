import { describe, expect, it } from 'vitest';
import { makeCtx } from './tests/helpers.js';
import { writeProviderUsageState, writeUsageState } from './usage-state.js';

describe('usage state boundary', () => {
  it('normalizes and commits provider usage for an allowed stage', () => {
    const ctx = makeCtx();

    writeProviderUsageState(ctx, 'reply', {
      promptTokens: 12,
      completionTokens: 5,
    });

    expect(ctx.usage).toEqual({
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
      source: 'provider',
    });
  });

  it('rejects an unauthorized stage without partially applying the update', () => {
    const ctx = makeCtx();
    ctx.usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2, source: 'provider' };

    expect(() => writeUsageState(ctx, 'finalize', {
      usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24, source: 'provider' },
    })).toThrow(/cannot be written|not allowed/i);

    expect(ctx.usage?.promptTokens).toBe(1);
  });

  it('rejects unknown fields before mutation', () => {
    const ctx = makeCtx();

    expect(() => writeUsageState(ctx, 'reply', {
      // @ts-expect-error runtime guard for an unregistered field
      unknownUsageField: 'invalid',
    })).toThrow(/unknown usage state field/i);

    expect(ctx.usage).toBeUndefined();
  });
});
