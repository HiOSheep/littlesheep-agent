import { access, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('workspace review layout unification', () => {
  it('reuses the file navigator shell and removes the old activity subpage', async () => {
    const review = await source('./review.tsx')
    const fileNavigator = await source('./file-navigator.tsx')
    const reviewTree = await source('./review-tree.tsx')
    const panel = await source('./panel.tsx')
    const styles = await source('../styles.css')

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
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
