import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { readRendererStyleSource } from '../style-source-test-utils'


describe('sidebar pointer reordering', () => {
  it('uses a thresholded ghost drag while keeping each source row in layout', async () => {
    const drag = await readFile(new URL('./list-drag.ts', import.meta.url), 'utf8')
    const styles = await readRendererStyleSource()

    expect(drag).toContain('SIDEBAR_LIST_DRAG_THRESHOLD_PX = 4')
    expect(drag).toContain('sourceElement.cloneNode(true)')
    expect(drag).toContain("document.body.classList.add('sidebar-list-dragging')")
    expect(drag).toContain("window.addEventListener('pointermove', handlePointerMove, { passive: false })")
    expect(drag).toContain('moveSidebarItem(currentOrder, itemId, targetIndex)')
    expect(drag).toContain("target.closest('[data-sidebar-drag-source]')")
    expect(styles).toMatch(/\.session-item\.is-dragging,[\s\S]*?\.project-group\.is-dragging\s*\{[^}]*opacity:\s*0;/u)
    expect(styles).toMatch(/\.sidebar-drag-ghost\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*320;[^}]*pointer-events:\s*none;[^}]*transition:\s*none;/u)
    expect(styles).toMatch(/body\.sidebar-list-dragging,[\s\S]*?user-select:\s*none !important;/u)
  })

  it('keeps standalone, project, and project-conversation drag targets inside their own lists', async () => {
    const conversation = await readFile(new URL('../app-shell/conversation-section-view.tsx', import.meta.url), 'utf8')
    const projects = await readFile(new URL('./project-section.tsx', import.meta.url), 'utf8')

    expect(conversation).toContain('const pinnedDrag = useSidebarListDrag(')
    expect(conversation).toContain('const unpinnedDrag = useSidebarListDrag(')
    expect(conversation).toContain('pinnedSessionIds.has(s.id) ? pinnedDrag : unpinnedDrag')
    expect(projects).toContain('const projectDrag = useSidebarListDrag(')
    expect(projects).toContain('const pinnedDrag = useSidebarListDrag(')
    expect(projects).toContain('const unpinnedDrag = useSidebarListDrag(')
    expect(projects).toContain('data-sidebar-drag-source')
    expect(projects).toContain('onReorderSessions={onReorderSessions}')
  })
})
