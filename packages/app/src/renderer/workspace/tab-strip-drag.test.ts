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
    expect(styles).toMatch(/body\.workspace-tab-dragging \.workspace-active-item:not\(\.is-dragging\):not\(\.active\):hover,[\s\S]*?background:\s*transparent;/u)
    expect(styles).toMatch(/body\.workspace-tab-dragging \.workspace-active-item:not\(\.is-dragging\):hover \.workspace-active-label\.is-overflowing \.workspace-active-label-text,[\s\S]*?transform:\s*none;[\s\S]*?transition:\s*none;/u)
    expect(styles).toMatch(/body\.workspace-tab-dragging \.workspace-active-item:not\(\.is-dragging\) \.workspace-active-close:hover,[\s\S]*?background:\s*transparent;/u)
  })

  it('maps vertical wheel input to horizontal tab-strip scrolling without intercepting non-overflowing or boundary input', async () => {
    const tabStrip = await readFile(new URL('./tab-strip.tsx', import.meta.url), 'utf8')

    expect(tabStrip).toContain('function handleTabStripWheel(event: ReactWheelEvent<HTMLDivElement>)')
    expect(tabStrip).toContain('onWheel={handleTabStripWheel}')
    expect(tabStrip).toContain('strip.scrollWidth <= strip.clientWidth')
    expect(tabStrip).toContain('Math.abs(event.deltaX) > Math.abs(event.deltaY)')
    expect(tabStrip).toContain('previousScrollLeft + delta')
    expect(tabStrip).toContain('event.preventDefault()')
    expect(tabStrip).toContain('strip.scrollLeft = nextScrollLeft')
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
