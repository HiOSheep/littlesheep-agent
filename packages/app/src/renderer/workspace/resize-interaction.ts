// Pointer-driven two-threshold extension-workspace resize interaction.
import '@xterm/xterm/css/xterm.css'
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import { clampNumber } from '../app-shell/navigation'
import { WORKSPACE_PANEL_MOTION_MS } from '../app-shell/preferences'
import { FloatingHelpTip } from '../ui/floating-help'
import { beginResize, endResize } from '../ui/resize'
import {
  WORKSPACE_PANEL_WIDTH_MIN,
  resolveWorkspacePanelDrag,
  resolveWorkspacePanelLayout,
  type WorkspacePanelDragMode
} from '../workspace-layout'

export interface WorkspaceResizeContext {
  workspacePanelCollapsed: boolean
  workspacePanelFullscreen: boolean
  activeDragCleanupRef: MutableRefObject<(() => void) | null>
  workspacePanelSettleTimerRef: MutableRefObject<number | undefined>
  setControlTip: Dispatch<SetStateAction<FloatingHelpTip | null>>
  workspacePanelLayout: ReturnType<typeof resolveWorkspacePanelLayout>
  shellRef: RefObject<HTMLDivElement>
  setWorkspacePanelCollapsed: Dispatch<SetStateAction<boolean>>
  setWorkspacePanelFullscreen: Dispatch<SetStateAction<boolean>>
  setWorkspacePanelWidth: Dispatch<SetStateAction<number>>
  scheduleComposerHeightSync: () => void
}

export function beginWorkspacePanelResizeInteraction(
  event: React.PointerEvent<HTMLDivElement>,
  context: WorkspaceResizeContext,
) {
  const { workspacePanelCollapsed, workspacePanelFullscreen, activeDragCleanupRef, workspacePanelSettleTimerRef, setControlTip, workspacePanelLayout, shellRef, setWorkspacePanelCollapsed, setWorkspacePanelFullscreen, setWorkspacePanelWidth, scheduleComposerHeightSync } = context

    if (workspacePanelCollapsed || workspacePanelFullscreen) return
    if (event.button !== 0) return
    event.preventDefault()
    activeDragCleanupRef.current?.()
    setControlTip(null)
    const resizer = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = workspacePanelLayout.width
    let draftWidth = startWidth
    let draftMode: WorkspacePanelDragMode = 'split'
    let frameHandle: number | undefined
    let collapseSettleTimer: number | undefined
    let thresholdAnimationTimer: number | undefined
    let pendingVisualWidth = startWidth
    let appliedVisualWidth = startWidth
    beginResize('column')
    window.clearTimeout(workspacePanelSettleTimerRef.current)
    workspacePanelSettleTimerRef.current = undefined
    shellRef.current?.classList.remove('workspace-panel-collapse-settling', 'workspace-panel-collapse-handoff')
    shellRef.current?.style.removeProperty('--workspace-panel-surface-width')
    shellRef.current?.classList.add('workspace-panel-drag-live')
    try {
      resizer.setPointerCapture(pointerId)
    } catch {
      // Window listeners keep the drag active when pointer capture is unavailable.
    }

    const applyDragFrame = () => {
      frameHandle = undefined
      if (pendingVisualWidth === appliedVisualWidth) return
      shellRef.current?.style.setProperty('--workspace-panel-width', `${pendingVisualWidth}px`)
      appliedVisualWidth = pendingVisualWidth
    }

    const scheduleDragFrame = (visualWidth: number) => {
      if (visualWidth === pendingVisualWidth && frameHandle === undefined) return
      pendingVisualWidth = visualWidth
      if (frameHandle !== undefined) return
      frameHandle = window.requestAnimationFrame(applyDragFrame)
    }

    const finishThresholdAnimation = () => {
      window.clearTimeout(thresholdAnimationTimer)
      shellRef.current?.classList.remove('workspace-panel-threshold-animating')
    }

    const keepThresholdAnimationActive = () => {
      const shell = shellRef.current
      if (!shell) return
      window.clearTimeout(thresholdAnimationTimer)
      if (!shell.classList.contains('workspace-panel-threshold-animating')) {
        shell.classList.add('workspace-panel-threshold-animating')
        // Paint the clamped first-threshold frame before changing the layout mode.
        void shell.offsetWidth
      }
      thresholdAnimationTimer = window.setTimeout(finishThresholdAnimation, WORKSPACE_PANEL_MOTION_MS)
    }

    const applyDraftMode = (nextMode: WorkspacePanelDragMode) => {
      if (nextMode === draftMode) return
      keepThresholdAnimationActive()
      draftMode = nextMode
      shellRef.current?.classList.toggle('workspace-panel-drag-collapsed', nextMode === 'collapsed')
      shellRef.current?.classList.toggle('workspace-panel-drag-fullscreen', nextMode === 'fullscreen')
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const rawWidth = startWidth - (moveEvent.clientX - startX)
      const dragResult = resolveWorkspacePanelDrag(rawWidth, workspacePanelLayout)
      draftWidth = dragResult.width
      if (dragResult.mode !== draftMode) {
        if (frameHandle !== undefined) window.cancelAnimationFrame(frameHandle)
        pendingVisualWidth = draftWidth
        applyDragFrame()
        applyDraftMode(dragResult.mode)
      } else {
        scheduleDragFrame(draftWidth)
      }
    }

    const handlePointerUp = (upEvent: Event) => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      window.removeEventListener('blur', handlePointerUp)
      activeDragCleanupRef.current = null
      if (frameHandle !== undefined) {
        window.cancelAnimationFrame(frameHandle)
        frameHandle = undefined
        applyDragFrame()
      }
      if (resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId)

      const releaseClientX = 'clientX' in upEvent ? Number((upEvent as PointerEvent).clientX) : Number.NaN
      if (Number.isFinite(releaseClientX)) {
        const releaseResult = resolveWorkspacePanelDrag(
          startWidth - (releaseClientX - startX),
          workspacePanelLayout,
        )
        draftMode = releaseResult.mode
        draftWidth = releaseResult.width
        pendingVisualWidth = draftWidth
        if (draftMode === 'collapsed') {
          shellRef.current?.classList.add('workspace-panel-drag-collapsed')
          shellRef.current?.classList.remove('workspace-panel-drag-fullscreen')
        } else if (draftMode === 'fullscreen') {
          shellRef.current?.classList.add('workspace-panel-drag-fullscreen')
          shellRef.current?.classList.remove('workspace-panel-drag-collapsed')
        } else {
          shellRef.current?.classList.remove('workspace-panel-drag-collapsed', 'workspace-panel-drag-fullscreen')
        }
        applyDragFrame()
      }

      const shell = shellRef.current
      if (draftMode === 'collapsed') {
        if (!shell) {
          flushSync(() => {
            setWorkspacePanelCollapsed(true)
            setWorkspacePanelFullscreen(false)
          })
        } else {
          /* Keep the minimum drag width as an explicit visual width while the
             transform finishes. Restore the saved width after the card is out
             of the viewport, avoiding a release-time flash into the chat. */
          shell.style.setProperty('--workspace-panel-surface-width', `${WORKSPACE_PANEL_WIDTH_MIN}px`)
          shell.classList.add('workspace-panel-collapse-settling')
          flushSync(() => {
            setWorkspacePanelCollapsed(true)
            setWorkspacePanelFullscreen(false)
          })
          shell.classList.remove(
            'workspace-panel-drag-live',
            'workspace-panel-drag-collapsed',
            'workspace-panel-drag-fullscreen',
            'workspace-panel-threshold-animating',
          )
          collapseSettleTimer = window.setTimeout(() => {
            const timer = collapseSettleTimer
            collapseSettleTimer = undefined
            if (workspacePanelSettleTimerRef.current === timer) workspacePanelSettleTimerRef.current = undefined
            const currentShell = shellRef.current
            if (!currentShell) return
            currentShell.classList.add('workspace-panel-collapse-handoff')
            currentShell.style.setProperty('--workspace-panel-width', `${workspacePanelLayout.width}px`)
            currentShell.style.removeProperty('--workspace-panel-surface-width')
            currentShell.classList.remove('workspace-panel-collapse-settling')
            void currentShell.offsetWidth
            currentShell.classList.remove('workspace-panel-collapse-handoff')
          }, WORKSPACE_PANEL_MOTION_MS)
          workspacePanelSettleTimerRef.current = collapseSettleTimer
        }
      } else {
        flushSync(() => {
          if (draftMode === 'fullscreen') {
            setWorkspacePanelCollapsed(false)
            setWorkspacePanelFullscreen(true)
            return
          }
          const finalWidth = clampNumber(draftWidth, WORKSPACE_PANEL_WIDTH_MIN, workspacePanelLayout.maxSplitWidth)
          setWorkspacePanelWidth(finalWidth)
          setWorkspacePanelCollapsed(false)
          setWorkspacePanelFullscreen(false)
        })
        shell?.style.setProperty(
          '--workspace-panel-width',
          `${draftMode === 'split' ? draftWidth : workspacePanelLayout.width}px`,
        )
        shell?.classList.remove(
          'workspace-panel-drag-live',
          'workspace-panel-drag-collapsed',
          'workspace-panel-drag-fullscreen',
          'workspace-panel-threshold-animating',
        )
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
      window.clearTimeout(thresholdAnimationTimer)
      if (collapseSettleTimer !== undefined) {
        window.clearTimeout(collapseSettleTimer)
        if (workspacePanelSettleTimerRef.current === collapseSettleTimer) workspacePanelSettleTimerRef.current = undefined
      }
      if (resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId)
      shellRef.current?.classList.remove(
        'workspace-panel-drag-live',
        'workspace-panel-drag-collapsed',
        'workspace-panel-drag-fullscreen',
        'workspace-panel-threshold-animating',
        'workspace-panel-collapse-settling',
        'workspace-panel-collapse-handoff',
      )
      shellRef.current?.style.removeProperty('--workspace-panel-surface-width')
      endResize('column')
      activeDragCleanupRef.current = null
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    window.addEventListener('blur', handlePointerUp)

}
