import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('workspace panel navigator persistence', () => {
  it('keeps one persistent navigator column outside the active tab view', async () => {
    const source = await readFile(new URL('./panel.tsx', import.meta.url), 'utf8')

    // Two mounts, one column: the persistent navigator beside a file tab, plus the 文件 tab's own
    // body, which is the same navigator so the tab and the column cannot behave differently. The
    // column goes inactive while that tab is active, the way it already does for the review tab's
    // own tree, so the folder tree is on screen exactly once.
    expect(source.match(/<WorkspaceFileNavigator\b/gu)).toHaveLength(2)
    expect(source).toContain('className={`workspace-shared-file-navigator ${activeTab === \'review\' || activeTab === \'artifacts\' ? \'inactive\' : \'\'}`}')
    expect(source).toContain('const hasOpenFileTab = openTabs.some((tab) => Boolean(parseWorkspaceFileTabId(tab)))')
    expect(source).toContain('const navigatorRoot = activeFileTab?.root')
    expect(source).toContain('rememberedNavigatorRoot')
    expect(source).toContain('navigatorSelectedPath')
    expect(source).not.toContain('showSharedFileNavigator')
  })

  it('gives the 文件 tab the same navigator state as the persistent column', async () => {
    const source = await readFile(new URL('./panel.tsx', import.meta.url), 'utf8')
    const wiringStart = source.indexOf('const navigatorWiring = {')
    expect(wiringStart, 'the panel owns one navigator wiring').toBeGreaterThan(-1)
    const wiring = source.slice(wiringStart, source.indexOf('\n  }', wiringStart))

    // Same component, same session: one root, one expansion set, one selection, one open handoff,
    // one collapse/width setting. Both mounts spread this one object, so the tab body cannot drift
    // into a second reading of the disk.
    for (const binding of [
      'workspacePath: navigatorRoot',
      'usingTemporaryRoot: navigatorUsesTemporaryRoot',
      'expandedPaths,',
      'selectedPath: navigatorSelectedPath',
      'onOpenFileTab: (root: string, path: string) => {',
      'onNavigatorCollapsedChange: onFileNavigatorCollapsedChange',
      'onNavigatorWidthChange: onFileNavigatorWidthChange',
      'onExpandedPathsChange,',
    ]) {
      expect(wiring, binding).toContain(binding)
    }
    expect(source.match(/<WorkspaceFileNavigator \{\.\.\.navigatorWiring\} \/>/gu)).toHaveLength(2)
  })

  it('keeps visited workspace tabs mounted and switches visibility without unloading them', async () => {
    const source = await readFile(new URL('./panel.tsx', import.meta.url), 'utf8')
    const styles = await readFile(new URL('../styles/04-workspace.css', import.meta.url), 'utf8')
    const terminal = await readFile(new URL('./terminal.tsx', import.meta.url), 'utf8')
    const browser = await readFile(new URL('./browser.tsx', import.meta.url), 'utf8')

    expect(source).toContain('const [mountedTabs, setMountedTabs] = useState<WorkspacePanelTabId[]>')
    expect(source).toContain('const mountedWorkspaceTabs = mountedTabs.filter((tab) => openTabs.includes(tab))')
    expect(source).toContain('const workspaceViewTabs =')
    expect(source).toContain('workspaceViewTabs.map((tab) =>')
    expect(source).toContain("isActive ? 'active content-fade' : 'cached'")
    expect(source).toContain("{...(!isActive ? { inert: '' } : {})}")
    expect(source).toContain('active={isActive}')
    expect(source).not.toContain('warm-cache')

    expect(styles).toContain('.workspace-panel-view.workspace-tab-view.cached')
    expect(styles).toContain('position: absolute')
    expect(styles).toContain('visibility: hidden')
    expect(styles).toContain('.workspace-panel-view.workspace-tab-view.active')

    expect(terminal).toContain('active?: boolean')
    expect(terminal).toContain('const activeRef = useRef(active)')
    expect(terminal).toContain('if (!disposed && activeRef.current) inputController.queue(data)')
    expect(terminal).toContain('terminalInputEnabledRef.current = enabled')
    expect(browser).toContain('active?: boolean')
    expect(browser).toContain('if (!active) return')
  })
})
