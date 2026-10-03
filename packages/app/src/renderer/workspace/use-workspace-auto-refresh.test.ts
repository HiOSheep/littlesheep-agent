import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_FILE_REFRESH_MS,
  WORKSPACE_REVIEW_REFRESH_MS,
  WORKSPACE_TREE_REFRESH_MS,
} from './use-workspace-auto-refresh'

const here = (name: string) => readFile(new URL(name, import.meta.url), 'utf8')

describe('workspace auto refresh', () => {
  it('ticks on its interval, only while the window is visible', async () => {
    const hook = await here('./use-workspace-auto-refresh.ts')

    expect(hook).toContain('const timer = window.setInterval(tick, intervalMs)')
    expect(hook).toContain("if (visible()) latest.current()")
    expect(hook).toContain("document.visibilityState === 'visible'")
    // Coming back to the window is an immediate tick, not a wait for the next interval.
    expect(hook).toContain("window.addEventListener('focus', tick)")
    expect(hook).toContain("document.addEventListener('visibilitychange', tick)")
    // The callback lives in a ref so a surface re-rendering its handler does not restart the timer.
    expect(hook).toContain('const latest = useRef(refresh)')
    expect(hook).toContain('}, [enabled, intervalMs])')
  })

  it('keeps a directory listing cheap, a Git snapshot slow, and a stat probe small', () => {
    expect(WORKSPACE_TREE_REFRESH_MS).toBe(4000)
    expect(WORKSPACE_FILE_REFRESH_MS).toBe(4000)
    expect(WORKSPACE_REVIEW_REFRESH_MS).toBe(15000)
    // The review already owned a slower interval than the two listings; it must not become the
    // fastest of the three.
    expect(WORKSPACE_REVIEW_REFRESH_MS).toBeGreaterThan(WORKSPACE_TREE_REFRESH_MS)
  })

  it('wires every workspace surface to refresh itself, with no refresh control left', async () => {
    const navigator = await here('./file-navigator.tsx')
    const fileView = await here('./file-view.tsx')
    const review = await here('./review.tsx')
    const reviewTree = await here('./review-tree.tsx')
    const panel = await here('./panel.tsx')

    expect(navigator).toContain('useWorkspaceAutoRefresh(refreshTree, WORKSPACE_TREE_REFRESH_MS)')
    expect(navigator).not.toContain('刷新文件树')
    expect(navigator).not.toContain('RefreshIcon')
    // The open file asks the cheap question first and only re-reads when the answer changed; unsaved
    // edits keep their draft and go through the disk notice instead.
    expect(fileView).toContain('const stat = await statWorkspaceFile(root, path)')
    expect(fileView).toContain('if (previewModifiedAt === undefined || stat.modifiedAt === previewModifiedAt) return')
    expect(fileView).toContain('if (!draftIsClean) return')
    expect(fileView).toContain('useWorkspaceAutoRefresh(autoReload, WORKSPACE_FILE_REFRESH_MS, active)')
    // The review keeps its interval, gated on the tab being the one on screen.
    expect(review).toContain('if (!active) return')
    expect(reviewTree).not.toContain('刷新 Git 更改')
    expect(reviewTree).not.toContain('RefreshIcon')
    // Cached tabs must not poll: the panel tells both file-backed surfaces whose turn it is.
    expect(panel).toContain('active={isActive}')
  })
})
