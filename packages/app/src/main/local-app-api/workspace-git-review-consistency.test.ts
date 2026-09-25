// UX-27 item 2: a review read that races with a change must be re-read, and one that
// keeps racing must say so instead of being presented as a fresh snapshot.
import { describe, expect, it } from 'vitest'
import {
  readConsistentReview,
  reviewStatusHash,
  sameReviewFacts,
  type ReviewConsistencyFacts,
} from './workspace-git-review-consistency'

const facts = (overrides: Partial<ReviewConsistencyFacts> = {}): ReviewConsistencyFacts => ({
  head: 'a'.repeat(40),
  indexModifiedAt: 1_700_000_000_000,
  indexSize: 512,
  statusHash: 'deadbeefdeadbeef',
  ...overrides,
})

describe('review read consistency', () => {
  it('compares the facts that actually indicate a state change', () => {
    expect(sameReviewFacts(facts(), facts())).toBe(true)
    expect(sameReviewFacts(facts(), facts({ head: 'b'.repeat(40) }))).toBe(false)
    expect(sameReviewFacts(facts(), facts({ indexModifiedAt: 1_700_000_000_001 }))).toBe(false)
    expect(sameReviewFacts(facts(), facts({ indexSize: 513 }))).toBe(false)
    // Working-tree edits leave HEAD and the index alone, so the status fingerprint is
    // the only fact that can catch an edit landing during the read.
    expect(sameReviewFacts(facts(), facts({ statusHash: 'feedfacefeedface' }))).toBe(false)
  })

  it('fingerprints status output without keeping it', () => {
    const first = reviewStatusHash(' M a.txt\0?? b.txt\0')
    expect(first).toHaveLength(16)
    expect(reviewStatusHash(' M a.txt\0?? b.txt\0')).toBe(first)
    expect(reviewStatusHash(' M a.txt\0')).not.toBe(first)
  })

  it('accepts a read that saw the same repository before and after', async () => {
    const result = await readConsistentReview({
      readFacts: async () => facts(),
      readOnce: async () => ({ value: 'snapshot', facts: facts() }),
    })

    expect(result.stable).toBe(true)
    expect(result.attempts).toBe(1)
    expect(result.value).toBe('snapshot')
  })

  it('re-reads when the repository changed during the read', async () => {
    let factsCall = 0
    let reads = 0
    const result = await readConsistentReview({
      // The change lands during the first read: it starts at v1, everything after it
      // (including that attempt's post-check) sees v2.
      readFacts: async () => {
        factsCall += 1
        return factsCall === 1 ? facts() : facts({ statusHash: 'feedfacefeedface' })
      },
      readOnce: async () => {
        reads += 1
        return reads === 1
          ? { value: 'stale', facts: facts() }
          : { value: 'fresh', facts: facts({ statusHash: 'feedfacefeedface' }) }
      },
    })

    expect(result.stable).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.value).toBe('fresh')
  })

  it('gives up after the bounded attempts and reports the read as unstable', async () => {
    let counter = 0
    const result = await readConsistentReview({
      readFacts: async () => {
        counter += 1
        return facts({ statusHash: counter.toString(16).padStart(16, '0') })
      },
      readOnce: async () => ({ value: 'always racing', facts: facts({ statusHash: '0'.repeat(16) }) }),
    })

    expect(result.stable).toBe(false)
    expect(result.attempts).toBe(2)
    // The evidence survives: the caller can show the data *and* say it is not settled.
    expect(result.value).toBe('always racing')
  })

  it('never loops beyond the configured attempts', async () => {
    let reads = 0
    let counter = 0
    const result = await readConsistentReview({
      maxAttempts: 3,
      readFacts: async () => {
        counter += 1
        return facts({ indexSize: counter })
      },
      readOnce: async () => {
        reads += 1
        return { value: reads, facts: facts({ indexSize: -reads }) }
      },
    })

    expect(reads).toBe(3)
    expect(result.attempts).toBe(3)
    expect(result.stable).toBe(false)
  })
})
