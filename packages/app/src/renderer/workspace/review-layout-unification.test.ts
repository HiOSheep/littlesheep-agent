import { access, readFile } from 'node:fs/promises'
import { readRendererStyleSource } from '../style-source-test-utils'
import { describe, expect, it } from 'vitest'

describe('workspace review layout unification', () => {
  it('reuses the file navigator shell and removes the old activity subpage', async () => {
    const review = await source('./review.tsx')
    const fileNavigator = await source('./file-navigator.tsx')
    const reviewTree = await source('./review-tree.tsx')
    const panel = await source('./panel.tsx')
    const styles = await readRendererStyleSource()

    expect(fileNavigator).toContain('<WorkspaceNavigatorFrame')
    expect(reviewTree).toContain('<WorkspaceNavigatorFrame')
    expect(review).toContain('workspace-review workspace-files')
    expect(review).toContain('fileNavigatorCollapsed')
    expect(review).not.toContain('activityView')
    expect(review).not.toContain("'activity'")
    expect(review).not.toContain('现场')
    expect(panel).not.toContain('WorkspaceOverview')
    expect(styles).not.toContain('.workspace-review-view-switch')
    expect(styles).not.toContain('.workspace-review-activity')
    expect(styles).not.toContain('.workspace-overview')
    await expect(access(new URL('./overview.tsx', import.meta.url))).rejects.toThrow()
    await expect(access(new URL('./activity.ts', import.meta.url))).rejects.toThrow()
  })

  it('persists explicit inline and side-by-side Monaco review modes', async () => {
    const review = await source('./review.tsx')
    const diff = await source('./review-diff.tsx')
    const preferences = await source('../app-shell/preferences.ts')

    expect(preferences).toContain('WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY')
    expect(review).toContain('readBooleanPreference(WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY, true)')
    expect(review).toContain('writeBooleanPreference(WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY, sideBySide)')
    expect(diff).toContain('renderSideBySide: sideBySide')
    expect(diff).toContain('useInlineViewWhenSpaceIsLimited: sideBySide')
    expect(diff).toContain('onSideBySideChange(!sideBySide)')
    expect(diff).toContain('aria-pressed={sideBySide}')
  })

  it('keeps the side-by-side scroll rail out of the shared horizontal layout', async () => {
    const review = await source('./review.tsx')
    const styles = await readRendererStyleSource()

    expect(review).toMatch(/<div className="workspace-review-content">[\s\S]*?<WorkspaceReviewDiff[\s\S]*?\{sideBySide && <WorkspaceReviewScrollRail targetRef=\{reviewScrollRef\} \/>\}[\s\S]*?<\/div>/u)
    expect(styles).toMatch(/\.workspace-review-content\s*\{[\s\S]*?position:\s*relative;[\s\S]*?flex:\s*1 1 0;/u)
    expect(styles).toMatch(/\.workspace-review-scroll-rail\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?right:\s*0;[\s\S]*?bottom:\s*0;/u)
  })

  it('keeps review line-change totals while excluding per-file size metadata', async () => {
    const reviewTree = await source('./review-tree.tsx')
    const review = await source('./review.tsx')
    const lineCounts = await source('./review-line-counts.tsx')
    const fileTree = await source('./workspace-tree-rows.tsx')
    const styles = await readRendererStyleSource()

    expect(reviewTree).toContain("import { ReviewLineCounts } from './review-line-counts'")
    expect(reviewTree).toContain('<ReviewLineCounts additions={additions} deletions={deletions} available={countsComplete} />')
    expect(reviewTree).toContain('additions={node.additions}')
    expect(reviewTree).toContain('deletions={node.deletions}')
    expect(reviewTree).toContain('available={node.countAvailable}')
    expect(review).toContain('countsComplete={snapshot?.countsComplete ?? false}')
    expect(review).toContain('additions={filteredFiles.reduce((total, file) => total + file.additions, 0)}')
    expect(review).toContain('deletions={filteredFiles.reduce((total, file) => total + file.deletions, 0)}')
    expect(lineCounts).toContain("+{available ? additions : '?'}")
    expect(lineCounts).toContain("-{available ? deletions : '?'}")
    expect(fileTree).not.toContain('formatFileSize')
    expect(fileTree).not.toContain('workspace-tree-size')
    expect(styles).toMatch(/\.workspace-review-tree-row\s*\{[\s\S]*?grid-template-columns:\s*15px 18px minmax\(0, 1fr\) auto;/u)
    expect(styles).toMatch(/\.workspace-review-tree-row\.file\s*\{[\s\S]*?grid-template-columns:\s*18px 18px minmax\(0, 1fr\) auto;/u)
    expect(styles).not.toContain('.workspace-tree-size {')
  })

  it('gives the review leading column its own persisted width (UX-18)', async () => {
    const panel = await source('./panel.tsx')
    const sessionLayouts = await source('./use-workspace-session-layouts.ts')
    const persistence = await source('../workspace-persistence.ts')
    const dockView = await source('../app-shell/workspace-dock-view.tsx')

    // Review gets the review width and writes back to the review field; the shared file
    // navigator keeps the file-navigator field, so the two can never move each other.
    expect(panel).toContain('fileNavigatorWidth={reviewNavigatorWidth}')
    expect(panel).toContain('onFileNavigatorWidthChange={onReviewNavigatorWidthChange}')
    expect(panel).toContain('navigatorWidth={fileNavigatorWidth}')
    expect(panel).toContain('onNavigatorWidthChange={onFileNavigatorWidthChange}')
    expect(sessionLayouts).toContain("setField('reviewNavigatorWidth', update)")
    expect(persistence).toContain('reviewNavigatorWidth: WORKSPACE_FILE_NAVIGATOR_WIDTH_DEFAULT')
    expect(persistence).toContain('reviewNavigatorWidth: normalizeWorkspaceFileNavigatorWidth(item.reviewNavigatorWidth)')
    expect(dockView).toContain('reviewNavigatorWidth={workspaceReviewNavigatorWidth}')
    expect(dockView).toContain('onReviewNavigatorWidthChange={setWorkspaceReviewNavigatorWidth}')
  })

  it('draws the same depth guides for expanded review folders as the file navigator', async () => {
    const reviewTree = await source('./review-tree.tsx')
    const styles = await readRendererStyleSource()

    expect(reviewTree).toContain("className={`workspace-review-tree-branch ${expanded ? 'expanded' : ''}`}")
    expect(reviewTree).toContain("'--workspace-tree-depth': depth")
    expect(styles).toMatch(/\.workspace-tree-entry\.expanded::before,\s*\.workspace-review-tree-branch\.expanded::before\s*\{/u)
    expect(styles).toContain('.workspace-review-tree-branch {\n  position: relative;')
  })

  it('keeps review layer status in the file header without a separate tinted row', async () => {
    const reviewDiff = await source('./review-diff.tsx')
    const styles = await readRendererStyleSource()

    expect(reviewDiff).toContain('const EMPTY_LAYER_KINDS: WorkspaceReviewDiffLayer[\'kind\'][] = []')
    expect(reviewDiff).toContain('layerKinds={diff?.layers.map((layer) => layer.kind) ?? EMPTY_LAYER_KINDS}')
    expect(reviewDiff).toContain('className="workspace-review-diff-title-main"')
    expect(reviewDiff).toContain('className="workspace-review-diff-layer-status"')
    expect(reviewDiff).toContain('layerKinds.map((kind) => LAYER_LABELS[kind]).join(\' / \')')
    expect(reviewDiff).not.toContain('workspace-review-layer-header')
    expect(styles).toMatch(/\.workspace-review-diff-title-main\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?gap:\s*6px;/u)
    expect(styles).toMatch(/\.workspace-review-diff-layer-status\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?text-overflow:\s*ellipsis;/u)
    expect(styles).not.toContain('.workspace-review-layer-header')
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
