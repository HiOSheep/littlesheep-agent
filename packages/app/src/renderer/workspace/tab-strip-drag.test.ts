import { readFile } from 'node:fs/promises'
import { readRendererStyleSource } from '../style-source-test-utils'
import { describe, expect, it } from 'vitest'


describe('workspace tab pointer reordering', () => {
  it('keeps the dragged tab under the pointer while its source remains a layout placeholder', async () => {
    const tabStrip = await readFile(new URL('./tab-strip.tsx', import.meta.url), 'utf8')
    const styles = await readRendererStyleSource()

    expect(tabStrip).toContain('WORKSPACE_TAB_DRAG_THRESHOLD_PX = 4')
    expect(tabStrip).toContain('sourceElement.cloneNode(true)')
    expect(tabStrip).toContain('positionGhost(moveEvent.clientX, moveEvent.clientY)')
    expect(tabStrip).toContain("window.addEventListener('pointermove', handlePointerMove, { passive: false })")
    expect(tabStrip).toContain('moveWorkspaceTab(currentOrder, tabId, targetIndex)')
    expect(tabStrip).toContain('WORKSPACE_TAB_PUSH_DURATION_MS = 160')
    expect(tabStrip).toContain('useListReorderAnimation<HTMLDivElement>(')
    expect(tabStrip).toContain('tabMotionRef(entry.id)(element)')
    expect(tabStrip).toContain('tabStripContentOrigin')
    expect(tabStrip).toContain('resolveDropIndex(currentOrder, tabId, draggedCenterX, session)')
    expect(tabStrip).toContain('getBoundingClientRect().width')
    expect(styles).toMatch(/\.workspace-active-item\.is-dragging\s*\{[^}]*opacity:\s*0;/u)
    expect(styles).toMatch(/\.workspace-active-drag-ghost\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*320;[^}]*pointer-events:\s*none;[^}]*transition:\s*none;/u)
  })

  it('commits the reordered session tabs without turning close clicks into drags', async () => {
    const tabStrip = await readFile(new URL('./tab-strip.tsx', import.meta.url), 'utf8')
    const panel = await readFile(new URL('./panel.tsx', import.meta.url), 'utf8')
    const dock = await readFile(new URL('../app-shell/workspace-dock-view.tsx', import.meta.url), 'utf8')

    expect(tabStrip).toContain('applyWorkspaceTabSubsetOrder(')
    expect(tabStrip).toContain('onTabsReorder(reorderedOpenTabs)')
    expect(tabStrip).toContain('onPointerDown={(event) => event.stopPropagation()}')
    expect(panel).toContain('onTabsReorder={onTabsReorder}')
    expect(dock).toContain('onTabsReorder={setWorkspacePanelOpenTabs}')
  })
})
