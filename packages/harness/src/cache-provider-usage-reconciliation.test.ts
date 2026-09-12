import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@littlesheep/llm';
import type { DurableHarnessEvent, RunContext } from '@littlesheep/types';
import { reduceDurableRunProjection } from './durable-kernel.js';
import { readProviderUsage } from './durable-projection-codec.js';
import {
  bindExactContextTokenCounter,
  flushModelRequestLifecycles,
  prepareModelRequest,
  recordProviderUsage,
} from './model-observability.js';
import { makeCtx } from './tests/helpers.js';

const TOKENIZER_ID = 'deepseek-v4-provider-calibrated-tokenizer-v2';

function request(): ChatRequest {
  return {
    // deepseek-v4-pro is the only DeepSeek name that still owns the calibrated
    // V4 exact counter; V4.1-served names report an unavailable tokenizer.
    model: 'deepseek-v4-pro',
    messages: [
      { role: 'system', content: 'stable policy text' },
      { role: 'user', content: 'bounded user input' },
    ],
    stream: false,
    temperature: 0,
    max_tokens: 200,
  };
}

function resolvedConfig(ctx: RunContext): NonNullable<RunContext['resolvedRunConfig']> {
  return {
    version: 1,
    runId: ctx.runId,
    resolvedAt: '2026-09-09T00:00:00.000Z',
    origin: 'test',
    behaviorModeId: 'general',
    permissionPolicyId: 'research',
    workflowStrategyId: 'core-flow',
    contextStrategyId: 'context-v1',
    memoryStrategyId: 'index-first-v1',
    toolSelectionStrategyId: 'registered-tools-v1',
    outputContractId: 'user-reply-v1',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    reasoning: 'auto',
    parameters: {},
    availableToolNames: [],
    approvalRequiredToolNames: [],
    userOverrides: {},
    projectOverrides: {},
  };
}

function durableRecorder(ctx: RunContext): DurableHarnessEvent[] {
  const events: DurableHarnessEvent[] = [];
  ctx.appendDurableEvent = async (input) => {
    events.push({
      version: 1,
      eventId: input.eventId ?? `${ctx.runId}:event:${events.length + 1}`,
      idempotencyKey: input.idempotencyKey,
      sessionId: String(ctx.sessionId),
      runId: ctx.runId,
      cursor: events.length + 1,
      type: input.type,
      source: input.source,
      occurredAt: input.occurredAt ?? '2026-09-09T00:00:00.000Z',
      payload: input.payload,
    });
  };
  return events;
}

async function project(localPromptTokens: number, providerPromptTokens: number) {
  const ctx = makeCtx();
  ctx.cacheObservationKey = 'cache-provider-reconciliation-key';
  ctx.resolvedRunConfig = resolvedConfig(ctx);
  bindExactContextTokenCounter(ctx, {
    id: TOKENIZER_ID,
    supports: (provider, model) => provider === 'deepseek' && model === 'deepseek-v4-pro',
    countRequest: () => localPromptTokens,
  });
  const events = durableRecorder(ctx);
  await ctx.appendDurableEvent?.({
    type: 'run_accepted',
    source: 'runtime',
    eventId: `${ctx.runId}:accepted`,
    idempotencyKey: `${ctx.runId}:accepted`,
    payload: {},
  });
  const prepared = prepareModelRequest(ctx, 'reply', request());
  recordProviderUsage(ctx, prepared, {
    promptTokens: providerPromptTokens,
    completionTokens: 7,
    totalTokens: providerPromptTokens + 7,
    cachedPromptTokens: 4,
  });
  await flushModelRequestLifecycles(ctx);
  return { ctx, events, projection: reduceDurableRunProjection(events) };
}

describe('CACHE-07 provider and local token reconciliation', () => {
  it('records exact local calibration on the same durable request', async () => {
    const { ctx, events, projection } = await project(100, 100);

    expect(projection.modelRequests[0]?.providerUsage).toMatchObject({
      promptTokens: 100,
      reconciliation: 'exact_match',
      localCalibration: {
        version: 1,
        tokenizerId: TOKENIZER_ID,
        localPromptTokens: 100,
        differenceTokens: 0,
        relativeDifference: 0,
        status: 'exact_match',
      },
    });
    expect(projection.modelRequests[0]?.providerUsage?.localCalibration)
      .toEqual(ctx.contextSnapshots?.[0]?.providerUsage?.localCalibration);
    expect(JSON.stringify(events)).not.toContain('stable policy text');
    expect(JSON.stringify(events)).not.toContain('bounded user input');
  });

  it('records within-tolerance drift without reclassifying it as a mismatch', async () => {
    const { projection } = await project(1_000, 1_004);

    expect(projection.modelRequests[0]?.providerUsage).toMatchObject({
      reconciliation: 'within_tolerance',
      localCalibration: {
        localPromptTokens: 1_000,
        differenceTokens: 4,
        relativeDifference: 4 / 1_004,
        status: 'within_tolerance',
      },
    });
  });

  it('maps drift beyond tolerance to a mismatch while keeping both ledger values', async () => {
    const { projection } = await project(1_000, 1_030);

    expect(projection.modelRequests[0]?.providerUsage).toMatchObject({
      promptTokens: 1_030,
      reconciliation: 'mismatch',
      localCalibration: {
        localPromptTokens: 1_000,
        differenceTokens: 30,
        relativeDifference: 30 / 1_030,
        status: 'drift',
      },
    });
  });
});

describe('CACHE-07 durable local calibration codec', () => {
  const base = {
    promptTokens: 100,
    completionTokens: 5,
    cacheStatus: 'miss' as const,
  };

  it('rejects reconciliation evidence without local calibration', () => {
    expect(() => readProviderUsage({
      ...base,
      reconciliation: 'exact_match',
    })).toThrow(/requires local calibration evidence/);
  });

  it('rejects calibration whose difference does not match the provider prompt tokens', () => {
    expect(() => readProviderUsage({
      ...base,
      reconciliation: 'exact_match',
      localCalibration: {
        version: 1,
        tokenizerId: TOKENIZER_ID,
        localPromptTokens: 100,
        differenceTokens: 3,
        relativeDifference: 0.03,
        status: 'exact_match',
      },
    })).toThrow(/difference does not match/);
  });

  it('rejects calibration status that disagrees with reconciliation', () => {
    expect(() => readProviderUsage({
      ...base,
      reconciliation: 'exact_match',
      localCalibration: {
        version: 1,
        tokenizerId: TOKENIZER_ID,
        localPromptTokens: 130,
        differenceTokens: -30,
        relativeDifference: 0.3,
        status: 'drift',
      },
    })).toThrow(/does not match local calibration/);
  });

  it('rejects an inconsistent relative difference', () => {
    expect(() => readProviderUsage({
      ...base,
      reconciliation: 'within_tolerance',
      localCalibration: {
        version: 1,
        tokenizerId: TOKENIZER_ID,
        localPromptTokens: 100,
        differenceTokens: 0,
        relativeDifference: 0.5,
        status: 'within_tolerance',
      },
    })).toThrow(/relative difference is inconsistent/);
  });

  it('accepts an aligned calibration and preserves unavailable without evidence', () => {
    expect(readProviderUsage({
      promptTokens: 1_004,
      completionTokens: 5,
      cacheStatus: 'miss',
      reconciliation: 'within_tolerance',
      localCalibration: {
        version: 1,
        tokenizerId: TOKENIZER_ID,
        localPromptTokens: 1_000,
        differenceTokens: 4,
        relativeDifference: 4 / 1_004,
        status: 'within_tolerance',
      },
    })).toMatchObject({
      reconciliation: 'within_tolerance',
      localCalibration: {
        tokenizerId: TOKENIZER_ID,
        localPromptTokens: 1_000,
      },
    });
    expect(readProviderUsage({
      ...base,
      reconciliation: 'unavailable',
    })).toMatchObject({ reconciliation: 'unavailable' });
  });
});
