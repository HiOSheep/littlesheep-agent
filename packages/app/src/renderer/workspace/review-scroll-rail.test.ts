import { readFile } from 'node:fs/promises'
import { readRendererStyleSource } from '../style-source-test-utils'
import { describe, expect, it } from 'vitest'

describe('workspace review scroll rail', () => {
  it('places a synchronized side-by-side scrollbar between the diff and file navigator', async () => {
    const review = await source('./review.tsx')
    const diff = await source('./review-diff.tsx')
    const rail = await source('./review-scroll-rail.tsx')
    const styles = await readRendererStyleSource()

    expect(review).toContain("className={`workspace-review workspace-files ${sideBySide ? 'is-side-by-side' : ''}`}")
    expect(review).toContain('<WorkspaceReviewScrollRail targetRef={reviewScrollRef} />')
    expect(diff).toContain('scrollRef: RefObject<HTMLDivElement>')
    expect(diff).toContain('ref={scrollRef} className="workspace-review-diff-scroll"')
    expect(rail).toContain('target.scrollTop = rail.scrollTop')
    expect(rail).toContain('rail.scrollTop = nextTop')
    expect(rail).toContain('new ResizeObserver(scheduleProxySizeUpdate)')
    expect(rail).toContain('new MutationObserver(scheduleProxySizeUpdate)')
    expect(styles).toMatch(/\.workspace-review\.is-side-by-side \.workspace-review-diff-scroll\s*\{[\s\S]*?scrollbar-width:\s*none;/u)
    expect(styles).toMatch(/\.workspace-review-content\s*\{[\s\S]*?position:\s*relative;[\s\S]*?flex:\s*1 1 0;/u)
    expect(styles).toMatch(/\.workspace-review-scroll-rail\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*var\(--workspace-page-leading-row-height\);[\s\S]*?right:\s*0;[\s\S]*?bottom:\s*0;[\s\S]*?width:\s*11px;[\s\S]*?overflow-y:\s*auto;/u)
    expect(styles).not.toMatch(/\.workspace-review-scroll-rail\s*\{[\s\S]*?flex:\s*0 0 11px;/u)
    expect(styles).toContain('.workspace-review-scroll-rail > div')
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
