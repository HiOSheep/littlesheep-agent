import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'


describe('workspace file navigator tooltips', () => {
  it('does not show name and path summaries for file tree rows', async () => {
    const source = await readFile(new URL('./file-navigator.tsx', import.meta.url), 'utf8')
    const treeRows = source.slice(source.indexOf('export function WorkspaceTreeRows'))

    expect(treeRows).not.toContain('buildFloatingHelpTip')
    expect(treeRows).not.toContain('buildFloatingHelpTipFromElement')
    expect(treeRows).not.toContain('onTipChange')
    expect(treeRows).not.toContain('const tip = `${entry.name}\\n${entry.path}`')
    expect(source).toContain("buildFloatingHelpTip('刷新文件树'")
  })

  it('does not show path or status summaries for review tree rows', async () => {
    const source = await readFile(new URL('./review-tree.tsx', import.meta.url), 'utf8')
    const treeRows = source.slice(source.indexOf('function WorkspaceReviewTreeRow'))

    expect(treeRows).not.toContain('buildFloatingHelpTip')
    expect(treeRows).not.toContain('buildFloatingHelpTipFromElement')
    expect(treeRows).not.toContain('onTipChange')
    expect(treeRows).not.toContain('title={statusText}')
    expect(treeRows).toContain('aria-label={statusText}')
    expect(source).not.toContain('title={repositoryLabel}')
    expect(source).not.toContain('title={workspacePath}')
    expect(source).toContain("buildFloatingHelpTip('刷新 Git 更改'")
  })
})
