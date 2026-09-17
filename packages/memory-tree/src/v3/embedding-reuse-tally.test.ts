import { describe, expect, it } from 'vitest'
import {
  EmbeddingReuseTally,
  addEmbeddingReuseCounts,
  embeddingReuseObserved,
  embeddingReuseOutcome,
  emptyEmbeddingReuseCounts,
} from './embedding-reuse-tally.js'

describe('embedding reuse accounting', () => {
  it('classifies a re-written unchanged atom as reused and changed content as queued', () => {
    expect(embeddingReuseOutcome({ eligible: true, changed: false, previousStatus: 'ready' })).toBe('reused')
    expect(embeddingReuseOutcome({ eligible: true, changed: false, previousStatus: 'stale' })).toBe('reused')
    expect(embeddingReuseOutcome({ eligible: true, changed: true, previousStatus: 'ready' })).toBe('queued')
    expect(embeddingReuseOutcome({ eligible: true, changed: false, previousStatus: undefined })).toBe('queued')
    expect(embeddingReuseOutcome({ eligible: false, changed: true, previousStatus: 'ready' })).toBe('disabled')
  })

  it('drains per-write outcomes and resets between drains', () => {
    const tally = new EmbeddingReuseTally()
    tally.record('reused')
    tally.record('reused')
    tally.record('queued')

    const first = tally.drain()
    expect(first).toEqual({ reused: 2, queued: 1, disabled: 0 })
    expect(embeddingReuseObserved(first)).toBe(true)
    expect(tally.drain()).toEqual({ reused: 0, queued: 0, disabled: 0 })
    expect(embeddingReuseObserved(emptyEmbeddingReuseCounts())).toBe(false)
  })

  it('sums per-write counts without inventing work for disabled embeddings', () => {
    const total = addEmbeddingReuseCounts(
      { reused: 1, queued: 2, disabled: 0 },
      { reused: 3, queued: 0, disabled: 5 },
    )
    expect(total).toEqual({ reused: 4, queued: 2, disabled: 5 })
    expect(addEmbeddingReuseCounts(total, undefined)).toBe(total)
  })
})
