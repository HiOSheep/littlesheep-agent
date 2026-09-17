import { describe, expect, it } from 'vitest'
import type { ExecutionLog } from '@littlesheep/runner'
import { projectRunCacheObservations, summarizeCacheCallGroups } from './cache-call-observations'

function logWith(calls: Array<{ index: number; stage: string; cached: number; reasons: string[] }>): ExecutionLog {
  return {
    modelRequests: calls.map((call) => ({
      requestIndex: call.index,
      stage: call.stage,
      cacheObservation: {
        providerPrompt: {
          kind: 'provider_prompt',
          status: call.cached === 0 ? 'miss' : 'partial',
          requestCount: 1,
          tokenCount: 1_000,
          cachedTokenCount: call.cached,
          uncachedTokenCount: 1_000 - call.cached,
          hitRatio: call.cached / 1_000,
        },
        invalidationReasons: call.reasons,
      },
    })),
  } as unknown as ExecutionLog
}

describe('summarizeCacheCallGroups', () => {
  it('separates the conversation from auxiliary stages and weights by tokens', () => {
    const groups = summarizeCacheCallGroups([
      { requestIndex: 1, stage: 'classify', status: 'miss', promptTokens: 900, cachedPromptTokens: 0, reasons: [] },
      { requestIndex: 2, stage: 'execute', status: 'partial', promptTokens: 1_000, cachedPromptTokens: 600, reasons: [] },
      { requestIndex: 3, stage: 'reply', status: 'partial', promptTokens: 1_000, cachedPromptTokens: 800, reasons: [] },
      { requestIndex: 4, stage: 'verify', status: 'hit', promptTokens: 100, cachedPromptTokens: 100, reasons: [] },
    ])

    expect(groups?.mainConversation).toEqual({ calls: 2, promptTokens: 2_000, cachedPromptTokens: 1_400, hitRatio: 0.7 })
    expect(groups?.auxiliary).toEqual({ calls: 2, promptTokens: 1_000, cachedPromptTokens: 100, hitRatio: 0.1 })
    expect(summarizeCacheCallGroups([])).toBeUndefined()
    expect(summarizeCacheCallGroups(undefined)).toBeUndefined()
  })

  it('omits a ratio when no call reported token counts', () => {
    const groups = summarizeCacheCallGroups([
      { requestIndex: 1, stage: 'reply', status: 'unavailable', reasons: [] },
    ])

    expect(groups?.mainConversation.hitRatio).toBeUndefined()
    expect(groups?.mainConversation.calls).toBe(1)
  })
})

describe('projectRunCacheObservations', () => {
  it('returns nothing when the run exposed no cache observations', () => {
    expect(projectRunCacheObservations(undefined)).toBeUndefined()
    expect(projectRunCacheObservations({ modelRequests: [] } as unknown as ExecutionLog)).toBeUndefined()
  })

  it('keeps the payload bounded and ranks the top invalidation reasons', () => {
    const calls = Array.from({ length: 20 }, (_, index) => ({
      index: index + 1,
      stage: 'execute',
      cached: index % 2 === 0 ? 0 : 800,
      reasons: index < 3 ? ['tool_schema_changed'] : index < 5 ? ['memory_revision_changed'] : [],
    }))

    const projected = projectRunCacheObservations(logWith(calls))

    expect(projected?.calls).toHaveLength(12)
    expect(projected?.callsTruncated).toBe(true)
    expect(projected?.calls[0]?.requestIndex).toBe(9)
    expect(projected?.topReasons).toEqual([
      { reason: 'tool_schema_changed', count: 3 },
      { reason: 'memory_revision_changed', count: 2 },
    ])
  })
})
