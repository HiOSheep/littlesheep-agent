// Pointer-driven two-threshold sidebar resize interaction.
import '@xterm/xterm/css/xterm.css'
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import { clampNumber } from '../app-shell/navigation'
import { SIDEBAR_COLLAPSE_THRESHOLD, SIDEBAR_SETTLE_ANIMATION_MS, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from '../app-shell/preferences'
import { FloatingHelpTip } from '../ui/floating-help'
import { beginResize, endResize } from '../ui/resize'

export interface SidebarResizeContext {
  activeDragCleanupRef: MutableRefObject<(() => void) | null>
  setControlTip: Dispatch<SetStateAction<FloatingHelpTip | null>>
  sidebarCollapsed: boolean
  sidebarWidth: number
  shellRef: RefObject<HTMLDivElement>
  sidebarSettleTimerRef: MutableRefObject<number | undefined>
  sidebarSettleFrameRef: MutableRefObject<number | undefined>
  setSidebarWidth: Dispatch<SetStateAction<number>>
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>
  scheduleComposerHeightSync: () => void
}

export function beginSidebarResizeInteraction(
  event: React.PointerEvent<HTMLDivElement>,
  context: SidebarResizeContext,
) {
  const { activeDragCleanupRef, setControlTip, sidebarCollapsed, sidebarWidth, shellRef, sidebarSettleTimerRef, sidebarSettleFrameRef, setSidebarWidth, setSidebarCollapsed, scheduleComposerHeightSync } = context

    if (sidebarCollapsed) return
    if (event.button !== 0) return
    event.preventDefault()
    activeDragCleanupRef.current?.()
    setControlTip(null)
    const startX = event.clientX
    const startWidth = sidebarWidth
    let draftWidth = startWidth
    let draftCollapsed = false
    let frameHandle: number | undefined
    let settleTimer: number | undefined
    let thresholdAnimationTimer: number | undefined
    let pendingVisualWidth = startWidth
    let appliedVisualWidth = startWidth
    beginResize('column')
    shellRef.current?.classList.add('sidebar-drag-live')

    const applyDragFrame = () => {
      frameHandle = undefined
      if (pendingVisualWidth === appliedVisualWidth) return
      shellRef.current?.style.setProperty('--sidebar-width', `${pendingVisualWidth}px`)
      appliedVisualWidth = pendingVisualWidth
    }

    const scheduleDragFrame = (visualWidth: number) => {
      if (visualWidth === pendingVisualWidth && frameHandle === undefined) return
      pendingVisualWidth = visualWidth
      if (frameHandle !== undefined) return
      frameHandle = window.requestAnimationFrame(applyDragFrame)
    }

    const clearSettlingClassSoon = () => {
      window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => {
        sidebarSettleTimerRef.current = undefined
        shellRef.current?.classList.remove('sidebar-settling')
      }, SIDEBAR_SETTLE_ANIMATION_MS)
      sidebarSettleTimerRef.current = settleTimer
    }

    const startThresholdAnimation = () => {
      window.clearTimeout(thresholdAnimationTimer)
      shellRef.current?.classList.add('sidebar-threshold-animating')
      thresholdAnimationTimer = window.setTimeout(() => {
        shellRef.current?.classList.remove('sidebar-threshold-animating')
      }, SIDEBAR_SETTLE_ANIMATION_MS)
    }

    const resetSidebarPreviewVars = () => {
      shellRef.current?.style.setProperty('--sidebar-content-opacity', '1')
      shellRef.current?.style.setProperty('--sidebar-content-shift', '0px')
      shellRef.current?.style.setProperty('--sidebar-cover-opacity', '0')
      shellRef.current?.style.setProperty('--sidebar-resizer-opacity', '1')
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const rawWidth = startWidth + moveEvent.clientX - startX
      const nextCollapsed = rawWidth <= SIDEBAR_COLLAPSE_THRESHOLD
      if (nextCollapsed !== draftCollapsed) {
        startThresholdAnimation()
      }
      draftCollapsed = nextCollapsed

      if (draftCollapsed) {
        shellRef.current?.classList.add('sidebar-drag-collapsed')
        draftWidth = SIDEBAR_WIDTH_MIN
        scheduleDragFrame(SIDEBAR_WIDTH_MIN)
        return
      }

      shellRef.current?.classList.remove('sidebar-drag-collapsed')
      draftWidth = rawWidth < SIDEBAR_WIDTH_MIN ? SIDEBAR_WIDTH_MIN : clampNumber(rawWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
      scheduleDragFrame(draftWidth)
    }

    const settleSidebarOpen = (finalWidth: number) => {
      const shell = shellRef.current
      if (!shell) {
        setSidebarWidth(finalWidth)
        return
      }

      shell.classList.remove('sidebar-drag-live')
      shell.classList.remove('sidebar-drag-collapsed')
      shell.classList.remove('sidebar-threshold-animating')
      shell.classList.add('sidebar-settling')
      sidebarSettleFrameRef.current = window.requestAnimationFrame(() => {
        sidebarSettleFrameRef.current = undefined
        shell.style.setProperty('--sidebar-width', `${finalWidth}px`)
        resetSidebarPreviewVars()
        setSidebarWidth(finalWidth)
        setSidebarCollapsed(false)
        clearSettlingClassSoon()
      })
    }

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      window.removeEventListener('blur', handlePointerUp)
      activeDragCleanupRef.current = null
      window.clearTimeout(thresholdAnimationTimer)
      if (frameHandle !== undefined) {
        window.cancelAnimationFrame(frameHandle)
        frameHandle = undefined
        applyDragFrame()
      }

      if (draftCollapsed) {
        shellRef.current?.classList.add('sidebar-collapsed')
        shellRef.current?.classList.remove(
          'sidebar-drag-live',
          'sidebar-drag-collapsed',
          'sidebar-settling',
          'sidebar-threshold-animating',
        )
        shellRef.current?.style.setProperty('--sidebar-width', `${sidebarWidth}px`)
        resetSidebarPreviewVars()
        setSidebarCollapsed(true)
      } else {
        const finalWidth = clampNumber(draftWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
        settleSidebarOpen(finalWidth)
      }
      endResize('column')
      scheduleComposerHeightSync()
    }

    activeDragCleanupRef.current = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      window.removeEventListener('blur', handlePointerUp)
      if (frameHandle !== undefined) window.cancelAnimationFrame(frameHandle)
      window.clearTimeout(settleTimer)
      window.clearTimeout(thresholdAnimationTimer)
      shellRef.current?.classList.remove(
        'sidebar-drag-live',
        'sidebar-drag-collapsed',
        'sidebar-settling',
        'sidebar-threshold-animating',
      )
      resetSidebarPreviewVars()
      endResize('column')
      activeDragCleanupRef.current = null
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    window.addEventListener('blur', handlePointerUp)

}
