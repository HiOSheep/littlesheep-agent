// UX-28 item 5: a capped list has to read as "showing the first N of M", not as a bare
// fraction, and the row counts have to admit when they are incomplete.
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { reviewSummaryLabel } from './review-tree'

describe('review tree truncation summary', () => {
  it('names both what is shown and what exists', () => {
    expect(reviewSummaryLabel({ fileCount: 2_000, totalFileCount: 2_500, filesTruncated: true }))
      .toBe('显示前 2000 个，共 2500 个文件')
  })

  it('stays a plain count when nothing was capped', () => {
    expect(reviewSummaryLabel({ fileCount: 3, totalFileCount: 3, filesTruncated: false })).toBe('3 个文件')
    // Even if the flags disagree, a non-truncated view never claims a cap.
    expect(reviewSummaryLabel({ fileCount: 3, totalFileCount: 9, filesTruncated: false })).toBe('3 个文件')
  })

  it('is what the tree renders', async () => {
    const source = await readFile(new URL('./review-tree.tsx', import.meta.url), 'utf8')
    expect(source).toContain('reviewSummaryLabel({ fileCount, totalFileCount, filesTruncated })')
    expect(source).not.toContain('`${fileCount}/${totalFileCount}`')
  })
})
