import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/**
 * The workspace file editor states its save result in one status line. A save
 * reloads the preview, and that reset used to clear the "已保存" confirmation in the
 * same tick, so the user never saw it (measured in the UX-09 walkthrough). The
 * confirmation is now remembered per path and consumed by the reset it caused, so
 * switching files or an external change still clears the line.
 */
describe('workspace preview save status', () => {
  it('keeps the confirmation across the save-triggered refresh only', async () => {
    const pane = await readFile(new URL('./preview-pane.tsx', import.meta.url), 'utf8')

    expect(pane).toContain('const savedStatusPathRef = useRef<string | null>(null)')
    expect(pane).toMatch(/setSaveMessage\('已保存'\)[\s\S]{0,160}savedStatusPathRef\.current = preview\.path/u)
    expect(pane).toMatch(
      /if \(savedStatusPathRef\.current === preview\?\.path\) savedStatusPathRef\.current = null\s*else \{\s*setSaveMessage\(''\); setSaveError\(''\)/u,
    )
    // A failed save still reports in place, with the draft kept for a retry.
    expect(pane).toContain("setSaveError(workspaceErrorMessage(err, '文件保存失败，请稍后重试。'))")
  })
})
