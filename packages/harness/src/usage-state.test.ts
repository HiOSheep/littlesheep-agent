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
      timedRequestCount: 0,
      timedCompletionTokens: 0,
      cacheReportedRequestCount: 0,
      usageReportedRequestCount: 1,
      usageCompleteness: 'complete',
      requestCount: 1,
      source: 'provider',
    });
  });

  it('HA-03-07 counts a completed request whose Provider omitted usage without inventing tokens', () => {
    const ctx = makeCtx();
    writeProviderUsageState(ctx, 'reply', undefined);

    expect(ctx.usage).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      requestCount: 1,
      usageReportedRequestCount: 0,
      usageCompleteness: 'unknown',
    });

    writeProviderUsageState(ctx, 'reply', { promptTokens: 10, completionTokens: 2 });
    expect(ctx.usage).toMatchObject({
      promptTokens: 10,
      completionTokens: 2,
      requestCount: 2,
      usageReportedRequestCount: 1,
      usageCompleteness: 'partial',
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

  it('HA-03-04 keeps a complete aggregate beyond the bounded request snapshot window', () => {
    const ctx = makeCtx();
    for (let index = 0; index < 65; index += 1) {
      writeProviderUsageState(ctx, 'reply', {
        promptTokens: 10,
        completionTokens: 2,
        cachedPromptTokens: 5,
        durationMs: 100,
        observedAttemptCount: index === 0 ? 2 : 1,
      });
    }

    expect(ctx.usage).toMatchObject({
      promptTokens: 650,
      completionTokens: 130,
      cachedPromptTokens: 325,
      providerDurationMs: 6_500,
      timedCompletionTokens: 130,
      timedRequestCount: 65,
      observedAttemptCount: 66,
      requestCount: 65,
      usageReportedRequestCount: 65,
      usageCompleteness: 'complete',
    });
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
