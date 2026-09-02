import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'


describe('workspace file navigator tooltips', () => {
  it('does not show name and path summaries for file tree rows', async () => {
    const source = await readFile(new URL('./file-navigator.tsx', import.meta.url), 'utf8')
    const treeRows = await readFile(new URL('./workspace-tree-rows.tsx', import.meta.url), 'utf8')

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

describe('workspace file navigator loading lifecycle', () => {
  it('invalidates root requests and clears stale loading markers when the navigator is hidden', async () => {
    const source = await readFile(new URL('./file-navigator.tsx', import.meta.url), 'utf8')
    const rootLoadingEffect = source.slice(
      source.indexOf('useLayoutEffect(() => {'),
      source.indexOf('useEffect(() => {', source.indexOf('useLayoutEffect(() => {')),
    )

    expect(rootLoadingEffect).toContain('if (requestId === directoryRequestRef.current) directoryRequestRef.current += 1')
    expect(rootLoadingEffect).toContain('setLoadingDirs((value) => value.size === 0 ? value : new Set())')
  })

  it('loads persisted expanded directories after the root snapshot is restored', async () => {
    const source = await readFile(new URL('./file-navigator.tsx', import.meta.url), 'utf8')

    expect(source).toContain('for (const path of expandedPaths)')
    expect(source).toContain('if (!isPathInsideOrSameClient(path, workspacePath) || directories[path]) continue')
    expect(source).toContain('void loadDirectory(path)')
  })
})
