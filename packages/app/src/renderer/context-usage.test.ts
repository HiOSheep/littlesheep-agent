import { readRendererStyleSource } from './style-source-test-utils'
import { describe, expect, it } from 'vitest'
import type { ContextSnapshot } from '@littlesheep/types'
import { formatLocalTokenizerState } from './composer/context-usage-indicator'
import { buildContextUsage, buildContextUsageSnapshot } from './context-usage'

function contextSnapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    version: 1,
    id: 'context-1',
    runId: 'run-1',
    sessionId: 'session-1' as ContextSnapshot['sessionId'],
    provider: 'openai',
    model: 'gpt-5.5',
    createdAt: '2026-07-13T01:00:00.000Z',
    budget: {
      status: 'known',
      maxContextTokens: 1_050_000,
      reservedOutputTokens: 4096,
      availablePromptTokens: 1_045_904,
      compressionThresholdRatio: 0.8,
    },
    items: [],
    totalItemCount: 0,
    itemsTruncated: false,
    compressionRecommended: false,
    ...overrides,
  }
}

describe('context usage presentation model', () => {
  it('keeps the usage popover content-sized and wraps it at the viewport boundary', async () => {
    const styles = await readRendererStyleSource()
    const popoverRule = styles.match(/\.context-usage-popover\s*\{([\s\S]*?)\n\}/u)?.[1] ?? ''

    expect(popoverRule).toContain('flex: 0 0 auto')
    expect(popoverRule).toContain('width: max-content')
    expect(popoverRule).toContain('max-width: min(360px, calc(100vw - 24px))')
    expect(popoverRule).toContain('white-space: normal')
    expect(popoverRule).toContain('overflow-wrap: anywhere')
  })

  it('keeps provider and exact local ledgers separate and draws the ring from current local usage', () => {
    const snapshot = buildContextUsageSnapshot('openai/gpt-5.5', undefined, [contextSnapshot({
      localTokenLedger: {
        version: 1,
        source: 'local',
        accuracy: 'exact',
        provider: 'openai',
        model: 'gpt-5.5',
        tokenizerId: 'openai-exact-v1',
        promptTokens: 11_800,
        countedAt: '2026-07-13T01:00:00.000Z',
      },
      providerUsage: {
        version: 1,
        source: 'provider',
        provider: 'openai',
        model: 'gpt-5.5',
        promptTokens: 12_000,
        completionTokens: 500,
        totalTokens: 12_500,
        localCalibration: {
          version: 1,
          tokenizerId: 'openai-exact-v1',
          localPromptTokens: 11_800,
          differenceTokens: 200,
          relativeDifference: 1 / 60,
          status: 'drift',
        },
        reportedAt: '2026-07-13T01:00:02.000Z',
      },
    })])

    expect(snapshot).toMatchObject({
      provider: { usedTokens: 12_000 },
      local: { usedTokens: 11_800, tokenizerId: 'openai-exact-v1' },
    })
    expect(buildContextUsage('openai/gpt-5.5', snapshot)).toMatchObject({
      source: 'local',
      usedTokens: 11_800,
      providerUsedTokens: 12_000,
      providerDifferenceTokens: 200,
      providerCalibrationStatus: 'drift',
      localUsedTokens: 11_800,
      maxTokens: 1_050_000,
      percent: 1,
      available: true,
    })
  })

  it('uses an exact local ledger only when provider usage is absent', () => {
    const snapshot = buildContextUsageSnapshot('openai/gpt-5.5', undefined, [contextSnapshot({
      localTokenLedger: {
        version: 1,
        source: 'local',
        accuracy: 'exact',
        provider: 'openai',
        model: 'gpt-5.5',
        tokenizerId: 'openai-exact-v1',
        promptTokens: 250_000,
        countedAt: '2026-07-13T01:00:00.000Z',
      },
    })])

    expect(buildContextUsage('openai/gpt-5.5', snapshot)).toMatchObject({
      source: 'local',
      usedTokens: 250_000,
      percent: 24,
      available: true,
    })
  })

  it('does not call a verified tokenizer unavailable just because this session has no new count yet', () => {
    const usage = buildContextUsage('deepseek/deepseek-v4-flash', null)

    expect(usage).toMatchObject({
      source: 'none',
      available: false,
      localTokenizerState: 'not_counted',
      maxTokens: 1_000_000,
    })
    expect(usage.localUnavailableReason).toBeUndefined()
  })

  it('keeps the same not-counted wording when an old session only has provider usage', () => {
    const snapshot = buildContextUsageSnapshot('deepseek/deepseek-v4-flash', undefined, [contextSnapshot({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      providerUsage: {
        version: 1,
        source: 'provider',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        promptTokens: 968,
        completionTokens: 20,
        totalTokens: 988,
        reportedAt: '2026-08-01T01:00:02.000Z',
      },
    })])
    const usage = buildContextUsage('deepseek/deepseek-v4-flash', snapshot)

    expect(usage.localTokenizerState).toBe('not_counted')
    expect(formatLocalTokenizerState(usage)).toBe('本会话尚无本地计数')
  })

  it('uses the reply-bearing request instead of a later internal capture request', () => {
    const executeSnapshot = contextSnapshot({
      id: 'context-execute',
      providerUsage: {
        version: 1,
        source: 'provider',
        provider: 'openai',
        model: 'gpt-5.5',
        promptTokens: 12_000,
        completionTokens: 500,
        totalTokens: 12_500,
        reportedAt: '2026-07-13T01:00:02.000Z',
      },
    })
    const captureSnapshot = contextSnapshot({
      id: 'context-capture',
      providerUsage: {
        version: 1,
        source: 'provider',
        provider: 'openai',
        model: 'gpt-5.5',
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        reportedAt: '2026-07-13T01:00:05.000Z',
      },
    })
    const requests = [
      { stage: 'execute', contextSnapshotId: 'context-execute' },
      { stage: 'capture', contextSnapshotId: 'context-capture' },
    ] as Parameters<typeof buildContextUsageSnapshot>[3]

    const snapshot = buildContextUsageSnapshot(
      'openai/gpt-5.5',
      { promptTokens: 12_000, completionTokens: 500, source: 'provider' },
      [executeSnapshot, captureSnapshot],
      requests,
    )

    expect(snapshot?.provider?.usedTokens).toBe(12_000)
  })

  it('treats an ASK_USER composition call as reply-bearing context', () => {
    const askSnapshot = contextSnapshot({
      id: 'context-ask-user',
      providerUsage: {
        version: 1,
        source: 'provider',
        provider: 'openai',
        model: 'gpt-5.5',
        promptTokens: 800,
        completionTokens: 60,
        totalTokens: 860,
        reportedAt: '2026-07-13T01:00:02.000Z',
      },
    })
    const requests = [
      { stage: 'ask_user', contextSnapshotId: 'context-ask-user' },
    ] as Parameters<typeof buildContextUsageSnapshot>[3]

    const snapshot = buildContextUsageSnapshot(
      'openai/gpt-5.5',
      { promptTokens: 800, completionTokens: 60, source: 'provider' },
      [askSnapshot],
      requests,
    )

    expect(snapshot?.provider?.usedTokens).toBe(800)
  })

  it('does not fabricate usage for unavailable counters or a different model', () => {
    const snapshot = buildContextUsageSnapshot('openai/gpt-5.5', undefined, [contextSnapshot({
      safetyEstimate: {
        version: 1,
        source: 'local',
        accuracy: 'conservative',
        purpose: 'overflow_protection',
        provider: 'openai',
        model: 'gpt-5.5',
        estimatorId: 'utf8-safety-v1',
        estimatedPromptTokens: 250_000,
        calculatedAt: '2026-07-13T01:00:00.000Z',
        displayable: false,
      },
      localTokenLedger: {
        version: 1,
        source: 'local',
        accuracy: 'unavailable',
        provider: 'openai',
        model: 'gpt-5.5',
        reason: 'No exact tokenizer is registered.',
        countedAt: '2026-07-13T01:00:00.000Z',
      },
    })])

    expect(buildContextUsage('openai/gpt-5.5', snapshot)).toMatchObject({
      source: 'none',
      usedTokens: 0,
      available: false,
      localTokenizerState: 'unavailable',
      localUnavailableReason: 'No exact tokenizer is registered.',
    })
    expect(buildContextUsage('deepseek/deepseek-v4-pro', snapshot)).toMatchObject({
      source: 'none',
      usedTokens: 0,
      available: false,
      localTokenizerState: 'not_counted',
    })
  })
})
