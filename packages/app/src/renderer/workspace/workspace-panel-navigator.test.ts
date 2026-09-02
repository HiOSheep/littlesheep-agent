import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('workspace panel navigator persistence', () => {
  it('keeps one ordinary navigator outside the active tab view', async () => {
    const source = await readFile(new URL('./panel.tsx', import.meta.url), 'utf8')

    expect(source.match(/<WorkspaceFileNavigator\b/gu)).toHaveLength(1)
    expect(source).toContain('className={`workspace-shared-file-navigator ${activeTab === \'review\' ? \'inactive\' : \'\'}`}')
    expect(source).toContain('const hasOpenFileTab = openTabs.some((tab) => Boolean(parseWorkspaceFileTabId(tab)))')
    expect(source).toContain('const navigatorRoot = activeFileTab?.root')
    expect(source).toContain('rememberedNavigatorRoot')
    expect(source).toContain('navigatorSelectedPath')
    expect(source).not.toContain('showSharedFileNavigator')
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
