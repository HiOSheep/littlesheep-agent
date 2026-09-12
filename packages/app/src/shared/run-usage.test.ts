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
    }))
  })

  it('does not present unsupported cache-write data as zero', () => {
    const usage = aggregateRunUsage([snapshot('one', 100, 10, 0, 0, 100)])
    expect(usage).not.toHaveProperty('cacheWriteTokens')
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
