// "Was the repository still the same while we were reading it?" (UX-27 item 2)
//
// A review snapshot is assembled from several Git commands (status, staged diff,
// unstaged diff, untracked counting). Those commands are *not* one atomic snapshot of
// the repository — a save, a `git add` or a commit can land between them, and the
// result would then describe a state that never existed. This module takes the facts
// that make that detectable, reads once, and reads again while they disagree, within a
// fixed number of attempts.
//
// The facts are deliberately cheap and few:
//   - `HEAD` (a commit or branch switch moves it),
//   - the index file's `mtime`/`size` (staging and commits write it),
//   - a fingerprint of `git status --porcelain -z` (working-tree edits do not touch
//     the index, so without this an edit during the read would go unnoticed).
// This is a collection-level consistency check. A second save to an already dirty file
// can leave HEAD, index metadata and porcelain status unchanged, so this fingerprint
// cannot detect that particular race. The UI must not describe it as an atomic read of
// the current file contents. A content-level check would require bounded per-file facts.
//
// The orchestration takes its readers as arguments so the retry rule is testable
// without Git, and the caller keeps ownership of what "one read" means.

import { createHash } from 'node:crypto'

export interface ReviewConsistencyFacts {
  /** Commit `HEAD` points at, or null when the repository has no commits yet. */
  head: string | null
  /** Index file modification time in ms, or null when it cannot be read. */
  indexModifiedAt: number | null
  /** Index file size, or null when it cannot be read. */
  indexSize: number | null
  /** Fingerprint of the working-tree status output. */
  statusHash: string
}

/** Two fact sets describe the same repository state. */
export function sameReviewFacts(a: ReviewConsistencyFacts, b: ReviewConsistencyFacts): boolean {
  return a.head === b.head
    && a.indexModifiedAt === b.indexModifiedAt
    && a.indexSize === b.indexSize
    && a.statusHash === b.statusHash
}

/** Stable fingerprint of a `git status --porcelain -z` payload. */
export function reviewStatusHash(stdout: string): string {
  return createHash('sha1').update(stdout, 'utf8').digest('hex').slice(0, 16)
}

export interface ReviewConsistencyResult<T> {
  value: T
  /** False when every attempt raced with a change: the caller must not present it as fresh. */
  stable: boolean
  attempts: number
  before: ReviewConsistencyFacts
  after: ReviewConsistencyFacts
}

export interface ReviewConsistencyOptions<T> {
  /** Facts for the repository *now* (cheap: HEAD, index stat, status hash). */
  readFacts: () => Promise<ReviewConsistencyFacts>
  /** One full read, which also reports the status fingerprint it observed. */
  readOnce: () => Promise<{ value: T; facts: ReviewConsistencyFacts }>
  /** Bounded: two attempts by default is one retry, never an unbounded refresh loop. */
  maxAttempts?: number
}

/**
 * Read, verify, and retry while the repository keeps changing.
 *
 * The result is returned either way: a caller that cannot produce a consistent read
 * still has evidence to show (UX-27 item 4 wants the old data *labelled*, not hidden),
 * and `stable: false` is what says so.
 */
export async function readConsistentReview<T>(
  options: ReviewConsistencyOptions<T>,
): Promise<ReviewConsistencyResult<T>> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2)
  let before = await options.readFacts()
  let last: { value: T; facts: ReviewConsistencyFacts } | null = null
  let attempts = 0
  while (attempts < maxAttempts) {
    attempts += 1
    last = await options.readOnce()
    const after = await options.readFacts()
    // The read is consistent when the repository looked the same before it and after
    // it, and when the status it observed is the status that is there now.
    if (sameReviewFacts(before, after) && sameReviewFacts(last.facts, after)) {
      return { value: last.value, stable: true, attempts, before, after }
    }
    before = after
  }
  if (!last) throw new Error('review read produced no result')
  return { value: last.value, stable: false, attempts, before, after: await options.readFacts() }
}
