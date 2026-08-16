// Pointer interaction for the right-side file navigator shared by files and review.
import type { MutableRefObject, RefObject } from 'react'
import { beginResize, endResize } from '../ui/resize'
import {
  resolveWorkspaceFileNavigatorDrag,
  type WorkspaceFileNavigatorLayout,
} from '../workspace-layout'

export interface WorkspaceNavigatorResizeContext {
  collapsed: boolean
  layout: WorkspaceFileNavigatorLayout
  navigatorRef: RefObject<HTMLElement>
  activeDragCleanupRef: MutableRefObject<(() => void) | null>
  onCollapse: () => void
  onTipChange: () => void
  onWidthChange: (width: number) => void
}

export function beginWorkspaceNavigatorResizeInteraction(
  event: React.PointerEvent<HTMLDivElement>,
  context: WorkspaceNavigatorResizeContext,
) {
  if (context.collapsed || event.button !== 0) return
  if (!context.navigatorRef.current) return
  const navigator = context.navigatorRef.current!

  event.preventDefault()
  context.activeDragCleanupRef.current?.()
  context.onTipChange()

  const resizer = event.currentTarget
  const pointerId = event.pointerId
  const startX = event.clientX
  const startWidth = context.layout.width
  let draftWidth = startWidth
  let draftCollapsed = false
  let pendingVisualWidth = startWidth
  let appliedVisualWidth = startWidth
  let frameHandle: number | undefined

  beginResize('column')
  navigator.classList.add('navigator-drag-live')
  try {
    resizer.setPointerCapture(pointerId)
  } catch {
    // Window listeners keep the drag active when pointer capture is unavailable.
  }

  const applyDragFrame = () => {
    frameHandle = undefined
    if (pendingVisualWidth === appliedVisualWidth) return
    navigator.style.setProperty('--workspace-files-navigator-width', `${pendingVisualWidth}px`)
    appliedVisualWidth = pendingVisualWidth
  }

  const scheduleDragFrame = (width: number) => {
    pendingVisualWidth = width
    if (frameHandle !== undefined) return
    frameHandle = window.requestAnimationFrame(applyDragFrame)
  }

  const removeListeners = () => {
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    window.removeEventListener('pointercancel', handlePointerUp)
    window.removeEventListener('blur', handlePointerUp)
  }

  const releasePointer = () => {
    try {
      if (resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId)
    } catch {
      // The owning element can disappear when a tab changes during the drag.
    }
  }

  const finishFrame = () => {
    if (frameHandle === undefined) return
    window.cancelAnimationFrame(frameHandle)
    frameHandle = undefined
    applyDragFrame()
  }

  function handlePointerMove(moveEvent: PointerEvent) {
    // This navigator is attached to the right edge, so leftward movement grows it.
    const rawWidth = startWidth - (moveEvent.clientX - startX)
    const result = resolveWorkspaceFileNavigatorDrag(rawWidth, context.layout)
    draftWidth = result.width
    draftCollapsed = result.collapsed
    scheduleDragFrame(draftWidth)
  }

  function handlePointerUp() {
    removeListeners()
    context.activeDragCleanupRef.current = null
    finishFrame()
    releasePointer()

    if (draftCollapsed) {
      // Match the sidebar contract: collapsing never overwrites the last open width.
      navigator.style.setProperty('--workspace-files-navigator-width', `${startWidth}px`)
      context.onCollapse()
    } else {
      navigator.style.setProperty('--workspace-files-navigator-width', `${draftWidth}px`)
      context.onWidthChange(draftWidth)
    }

    navigator.classList.remove('navigator-drag-live')
    endResize('column')
  }

  context.activeDragCleanupRef.current = () => {
    removeListeners()
    if (frameHandle !== undefined) window.cancelAnimationFrame(frameHandle)
    navigator.style.setProperty('--workspace-files-navigator-width', `${startWidth}px`)
    navigator.classList.remove('navigator-drag-live')
    releasePointer()
    endResize('column')
    context.activeDragCleanupRef.current = null
  }

  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('pointercancel', handlePointerUp)
  window.addEventListener('blur', handlePointerUp)
}
