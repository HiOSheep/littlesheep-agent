// Pointer-driven two-threshold sidebar resize interaction.
import '@xterm/xterm/css/xterm.css'
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import { flushSync } from 'react-dom'
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
    let collapseSettleTimer: number | undefined
    let thresholdAnimationTimer: number | undefined
    let pendingVisualWidth = startWidth
    let appliedVisualWidth = startWidth
    beginResize('column')
    window.cancelAnimationFrame(sidebarSettleFrameRef.current ?? 0)
    sidebarSettleFrameRef.current = undefined
    window.clearTimeout(sidebarSettleTimerRef.current)
    sidebarSettleTimerRef.current = undefined
    shellRef.current?.classList.remove('sidebar-collapse-settling', 'sidebar-collapse-handoff')
    shellRef.current?.style.removeProperty('--sidebar-surface-width')
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

    const handlePointerUp = (upEvent: Event) => {
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

      const releaseClientX = 'clientX' in upEvent ? Number((upEvent as PointerEvent).clientX) : Number.NaN
      if (Number.isFinite(releaseClientX)) {
        const rawWidth = startWidth + releaseClientX - startX
        const nextCollapsed = rawWidth <= SIDEBAR_COLLAPSE_THRESHOLD
        draftCollapsed = nextCollapsed
        draftWidth = nextCollapsed
          ? SIDEBAR_WIDTH_MIN
          : rawWidth < SIDEBAR_WIDTH_MIN
            ? SIDEBAR_WIDTH_MIN
            : clampNumber(rawWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
        pendingVisualWidth = draftWidth
        if (nextCollapsed) {
          shellRef.current?.classList.add('sidebar-drag-collapsed')
        } else {
          shellRef.current?.classList.remove('sidebar-drag-collapsed')
        }
        applyDragFrame()
      }

      if (draftCollapsed) {
        const shell = shellRef.current
        if (!shell) {
          flushSync(() => setSidebarCollapsed(true))
        } else {
          /* Keep the minimum drag width as an explicit visual width while the
             transform finishes. The durable saved width is restored only once
             the surface is already outside the viewport. */
          shell.style.setProperty('--sidebar-surface-width', `${SIDEBAR_WIDTH_MIN}px`)
          shell.classList.add('sidebar-collapse-settling')
          flushSync(() => setSidebarCollapsed(true))
          shell.classList.remove(
            'sidebar-drag-live',
            'sidebar-drag-collapsed',
            'sidebar-settling',
            'sidebar-threshold-animating',
          )
          resetSidebarPreviewVars()
          collapseSettleTimer = window.setTimeout(() => {
            const timer = collapseSettleTimer
            collapseSettleTimer = undefined
            if (sidebarSettleTimerRef.current === timer) sidebarSettleTimerRef.current = undefined
            const currentShell = shellRef.current
            if (!currentShell) return
            currentShell.classList.add('sidebar-collapse-handoff')
            currentShell.style.setProperty('--sidebar-width', `${sidebarWidth}px`)
            currentShell.style.removeProperty('--sidebar-surface-width')
            currentShell.classList.remove('sidebar-collapse-settling')
            void currentShell.offsetWidth
            currentShell.classList.remove('sidebar-collapse-handoff')
          }, SIDEBAR_SETTLE_ANIMATION_MS)
          sidebarSettleTimerRef.current = collapseSettleTimer
        }
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
      if (collapseSettleTimer !== undefined) {
        window.clearTimeout(collapseSettleTimer)
        if (sidebarSettleTimerRef.current === collapseSettleTimer) sidebarSettleTimerRef.current = undefined
      }
      shellRef.current?.classList.remove(
        'sidebar-drag-live',
        'sidebar-drag-collapsed',
        'sidebar-settling',
        'sidebar-threshold-animating',
        'sidebar-collapse-settling',
        'sidebar-collapse-handoff',
      )
      shellRef.current?.style.removeProperty('--sidebar-surface-width')
      resetSidebarPreviewVars()
      endResize('column')
      activeDragCleanupRef.current = null
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    window.addEventListener('blur', handlePointerUp)

}
