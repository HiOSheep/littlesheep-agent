// UX-28 item 5: the body carries the limits only when the navigator that normally states
// them is collapsed — and it says nothing when there is no limit to report.
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { reviewLimitNotice } from './review-limits'

const base = {
  navigatorCollapsed: true,
  filesTruncated: true,
  fileCount: 2_000,
  totalFileCount: 2_054,
  truncatedLayers: 0,
}

describe('review limit notice in the body', () => {
  it('states the file cap when the list is off screen', () => {
    const notice = reviewLimitNotice(base)
    expect(notice?.text).toBe('显示前 2000 个，共 2054 个文件。')
    expect(notice?.kinds).toEqual(['files'])
  })

  it('adds the layer cap when a layer was cut', () => {
    const notice = reviewLimitNotice({ ...base, truncatedLayers: 2 })
    expect(notice?.text).toBe('显示前 2000 个，共 2054 个文件；2 个差异层已达上限。')
    expect(notice?.kinds).toEqual(['files', 'layers'])
  })

  it('says nothing while the navigator is expanded, or when nothing is capped', () => {
    expect(reviewLimitNotice({ ...base, navigatorCollapsed: false })).toBeNull()
    expect(reviewLimitNotice({ ...base, filesTruncated: false })).toBeNull()
    expect(reviewLimitNotice({ ...base, filesTruncated: false, truncatedLayers: 1 })?.kinds).toEqual(['layers'])
  })

  it('is what the review view passes to the diff surface', async () => {
    const review = await readFile(new URL('./review.tsx', import.meta.url), 'utf8')
    const diff = await readFile(new URL('./review-diff.tsx', import.meta.url), 'utf8')
    // The view passes the facts; the diff surface derives the sentence (review.tsx is a
    // composition hotspot that must not grow for a one-line notice).
    expect(review).toContain('limits={{ navigatorCollapsed: fileNavigatorCollapsed')
    expect(diff).toContain('reviewLimitNotice({ ...limits')
    expect(diff).toContain('className="workspace-review-limit-notice"')
  })
})
