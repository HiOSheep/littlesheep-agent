import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('workspace session view isolation', () => {
  it('remounts transient workspace views when the active conversation changes', async () => {
    const dockView = await source('../app-shell/workspace-dock-view.tsx')

    expect(dockView).toContain("import { workspaceSessionKey } from '../workspace-persistence'")
    expect(dockView).toContain('key={workspaceSessionKey(currentSession)}')
  })

  it('reapplies the owning conversation draft even when both conversations open the same file', async () => {
    const fileView = await source('./file-view.tsx')
    const previewPane = await source('./preview-pane.tsx')

    expect(fileView).toContain('sessionId={sessionId}')
    expect(previewPane).toMatch(
      /\}, \[sessionId, preview\?\.path, preview\?\.modifiedAt, editable, isMarkdown, isHtml\]\)/u,
    )
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
