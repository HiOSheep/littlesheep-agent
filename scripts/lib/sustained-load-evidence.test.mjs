import { describe, expect, it } from 'vitest'
import {
  FORMAL_DEFAULT_DURATION_SECONDS,
  createSustainedResourceAggregate,
  parseSustainedLoadOptions,
} from './sustained-load-evidence.mjs'

describe('sustained load evidence', () => {
  it('keeps diagnostic and formal modes explicitly separate', () => {
    expect(parseSustainedLoadOptions([])).toEqual({
      mode: 'diagnostic',
      durationSeconds: 120,
      sampleIntervalMs: 1_000,
      progressIntervalMs: 1_000,
    })
    expect(parseSustainedLoadOptions(['--mode=formal'])).toEqual({
      mode: 'formal',
      durationSeconds: FORMAL_DEFAULT_DURATION_SECONDS,
      sampleIntervalMs: 5_000,
      progressIntervalMs: 5_000,
    })
    expect(() => parseSustainedLoadOptions(['--mode=formal', '--duration-seconds=1200']))
      .toThrow(/between 3600 and 21600/u)
  })

  it('retains at most 24 aggregate trend windows', () => {
    const start = Date.parse('2026-08-03T00:00:00.000Z')
    const aggregate = createAggregate({ formal: false, start, durationMs: 120_000 })
    for (let index = 0; index < 200; index += 1) {
      aggregate.add(snapshot(start + index * 1_000, { rssBytes: 100_000_000 }), { tick: index })
    }
    aggregate.assertHealthy()
    expect(aggregate.summary().trend.windows.length).toBeLessThanOrEqual(24)
  })

  it('accepts a stable formal run and rejects a sustained second-half leak', () => {
    const start = Date.parse('2026-08-03T00:00:00.000Z')
    const durationMs = 2 * 60 * 60_000
    const stable = createAggregate({ formal: true, start, durationMs })
    const leaking = createAggregate({ formal: true, start, durationMs })
    for (let index = 0; index < 24; index += 1) {
      const sampledAt = start + index * (durationMs / 24) + 1_000
      stable.add(snapshot(sampledAt, { rssBytes: 300_000_000 }), { tick: index })
      leaking.add(snapshot(sampledAt, {
        rssBytes: 300_000_000 + index * 12 * 1024 * 1024,
      }), { tick: index })
    }
    expect(() => stable.assertHealthy()).not.toThrow()
    expect(() => leaking.assertHealthy()).toThrow(/rssBytes trend exceeds/u)
  })

  it('does not turn a transiently unavailable progress file into a false regression', () => {
    const start = Date.parse('2026-08-03T00:00:00.000Z')
    const aggregate = createAggregate({ formal: false, start, durationMs: 120_000 })
    aggregate.add(snapshot(start + 1_000), { tick: 10 })
    aggregate.add(snapshot(start + 2_000), undefined)
    aggregate.add(snapshot(start + 3_000), { tick: 11 })

    aggregate.assertHealthy()
    expect(aggregate.summary().missingProgressSamples).toBe(1)
    expect(aggregate.summary().violations).toEqual([])
    expect(aggregate.summary().last.progressTick).toBe(11)
  })
})

function createAggregate({ formal, start, durationMs }) {
  return createSustainedResourceAggregate({
    expectedListenerCount: 2,
    maxSourceCount: 2,
    maxRetiredRunnerCount: 1,
    formal,
    startedAtMs: start,
    durationMs,
  })
}

function snapshot(sampledAtMs, overrides = {}) {
  return {
    sampledAt: new Date(sampledAtMs).toISOString(),
    process: {
      rssBytes: overrides.rssBytes ?? 300_000_000,
      heapUsedBytes: 80_000_000,
      activeHandleCount: 8,
      activeRequestCount: 0,
    },
    electron: {
      workingSetBytes: 500_000_000,
      privateBytes: 400_000_000,
      processCount: 4,
    },
    runtime: {
      aggregatedActiveRunCount: 1,
      retiredRunnerCount: 1,
      activitySourceCount: 2,
      activityListenerCount: 2,
    },
  }
}
