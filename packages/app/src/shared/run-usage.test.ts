import { describe, expect, it } from 'vitest'
import type { ContextSnapshot } from '@littlesheep/types'
import { aggregateRunUsage } from './run-usage'

describe('aggregateRunUsage', () => {
  it('sums all provider calls and their provider-only duration', () => {
    const snapshots = [
      snapshot('one', 1_000, 100, 600, 25, 2_000),
      snapshot('two', 500, 50, 400, 10, 1_000),
    ]
    expect(aggregateRunUsage(snapshots)).toEqual(expect.objectContaining({
      promptTokens: 1_500,
      completionTokens: 150,
      cachedPromptTokens: 1_000,
      reasoningTokens: 35,
      providerDurationMs: 3_000,
      requestCount: 2,
      usageReportedRequestCount: 2,
      usageCompleteness: 'complete',
    }))
  })

  it('marks a missing Provider usage record as partial instead of zero', () => {
    const missing = { ...snapshot('missing', 0, 0, 0, 0, 0), providerUsage: undefined }
    expect(aggregateRunUsage([snapshot('known', 100, 10, 20, 2, 100), missing])).toMatchObject({
      promptTokens: 100,
      completionTokens: 10,
      requestCount: 2,
      usageReportedRequestCount: 1,
      usageCompleteness: 'partial',
    })
  })

  it('does not present unsupported cache-write data as zero', () => {
    const usage = aggregateRunUsage([snapshot('one', 100, 10, 0, 0, 100)])
    expect(usage).not.toHaveProperty('cacheWriteTokens')
  })

  it('sums the provider-reported uncached input only when every call reports it', () => {
    const withSplit = (id: string, promptTokens: number, cached: number, uncached: number) => {
      const base = snapshot(id, promptTokens, 10, cached, 1, 100)
      return {
        ...base,
        providerUsage: { ...base.providerUsage!, uncachedPromptTokens: uncached },
      } as ContextSnapshot
    }

    expect(aggregateRunUsage([
      withSplit('one', 1_000, 600, 400),
      withSplit('two', 500, 400, 100),
    ])).toMatchObject({
      promptTokens: 1_500,
      cachedPromptTokens: 1_000,
      uncachedPromptTokens: 500,
    })

    // A call without the split must not present the others as zero.
    expect(aggregateRunUsage([
      withSplit('one', 1_000, 600, 400),
      snapshot('two', 500, 10, 400, 1, 100),
    ])).not.toHaveProperty('uncachedPromptTokens')
  })

  it('HA-03-04 prefers the complete run aggregate over a bounded diagnostic tail', () => {
    const tail = [snapshot('tail', 10, 2, 5, 1, 100)]
    const aggregate = {
      source: 'provider' as const,
      promptTokens: 650,
      completionTokens: 130,
      totalTokens: 780,
      requestCount: 65,
      timedRequestCount: 65,
      timedCompletionTokens: 130,
      providerDurationMs: 6_500,
    }
    expect(aggregateRunUsage(tail, aggregate)).toBe(aggregate)
  })
})

function snapshot(
  id: string,
  promptTokens: number,
  completionTokens: number,
  cachedPromptTokens: number,
  reasoningTokens: number,
  durationMs: number,
): ContextSnapshot {
  return {
    version: 1,
    id,
    runId: 'run',
    sessionId: 'session' as ContextSnapshot['sessionId'],
    provider: 'deepseek',
    model: 'deepseek-flash',
    createdAt: new Date(0).toISOString(),
    budget: { status: 'known', maxContextTokens: 10_000, reservedOutputTokens: 1_000, availablePromptTokens: 9_000, compressionThresholdRatio: 0.8 },
    items: [],
    totalItemCount: 0,
    itemsTruncated: false,
    compressionRecommended: false,
    providerUsage: {
      version: 1,
      source: 'provider',
      provider: 'deepseek',
      model: 'deepseek-flash',
      promptTokens,
      completionTokens,
      cachedPromptTokens,
      reasoningTokens,
      durationMs,
      reportedAt: new Date(0).toISOString(),
    },
  }
}
