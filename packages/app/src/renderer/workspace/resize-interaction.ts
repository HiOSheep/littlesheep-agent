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
  const { workspacePanelCollapsed, workspacePanelFullscreen, activeDragCleanupRef, setControlTip, workspacePanelLayout, shellRef, setWorkspacePanelCollapsed, setWorkspacePanelFullscreen, setWorkspacePanelWidth, scheduleComposerHeightSync } = context

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
    let thresholdAnimationTimer: number | undefined
    let pendingVisualWidth = startWidth
    beginResize('column')
    shellRef.current?.classList.add('workspace-panel-drag-live')
    try {
      resizer.setPointerCapture(pointerId)
    } catch {
      // Window listeners keep the drag active when pointer capture is unavailable.
    }

    const applyDragFrame = () => {
      frameHandle = undefined
      shellRef.current?.style.setProperty('--workspace-panel-width', `${pendingVisualWidth}px`)
    }

    const scheduleDragFrame = (visualWidth: number) => {
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

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      window.removeEventListener('blur', handlePointerUp)
      activeDragCleanupRef.current = null
      if (frameHandle !== undefined) {
        window.cancelAnimationFrame(frameHandle)
        applyDragFrame()
      }
      if (resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId)

      const shell = shellRef.current
      flushSync(() => {
        if (draftMode === 'collapsed') {
          setWorkspacePanelCollapsed(true)
          setWorkspacePanelFullscreen(false)
          return
        }
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
      )
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
      if (resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId)
      shellRef.current?.classList.remove(
        'workspace-panel-drag-live',
        'workspace-panel-drag-collapsed',
        'workspace-panel-drag-fullscreen',
        'workspace-panel-threshold-animating',
      )
      endResize('column')
      activeDragCleanupRef.current = null
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    window.addEventListener('blur', handlePointerUp)

}
