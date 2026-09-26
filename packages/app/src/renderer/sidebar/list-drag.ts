// Shared vertical drag-and-drop behavior for sidebar lists.
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { useListReorderAnimation } from '../app-shell/list-motion'

export const SIDEBAR_LIST_DRAG_THRESHOLD_PX = 4
export const SIDEBAR_LIST_AUTO_SCROLL_EDGE_PX = 28
export const SIDEBAR_LIST_AUTO_SCROLL_STEP_PX = 14
/**
 * The sidebar list's push/reorder motion. It is what the reader sees when a click re-sorts the list
 * and when pinning or unpinning moves a row between the pinned and the dated group, so it runs at
 * half the original speed (160ms → 320ms); the drag push shares the same pass and slows with it.
 */
export const SIDEBAR_LIST_PUSH_DURATION_MS = 320

interface SidebarListDragSession {
  itemId: string
  pointerId: number
  startY: number
  pointerOffsetY: number
  width: number
  sourceElement: HTMLDivElement
  ghostElement: HTMLDivElement | null
  originalOrder: string[]
  active: boolean
}

interface SidebarListDragOptions {
  scrollContainerRef?: RefObject<HTMLElement | null>
  onReorder: (orderedIds: string[]) => void
  onDragStart?: () => void
}

export function useSidebarListDrag(
  ids: readonly string[],
  options: SidebarListDragOptions,
) {
  const currentIds = [...ids]
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  const itemRefs = useRef(new Map<string, HTMLDivElement>())
  const dragSessionRef = useRef<SidebarListDragSession | null>(null)
  const dragOrderRef = useRef<string[] | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const suppressClickRef = useRef(false)
  const displayedIds = normalizeDisplayedIds(dragOrder ?? currentIds, currentIds)
  const motionRef = useListReorderAnimation<HTMLDivElement>(displayedIds, {
    duration: SIDEBAR_LIST_PUSH_DURATION_MS,
    easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  })

  useEffect(() => () => dragCleanupRef.current?.(), [])

  function itemRef(itemId: string) {
    return (node: HTMLDivElement | null) => {
      motionRef(itemId)(node)
      if (node) itemRefs.current.set(itemId, node)
      else itemRefs.current.delete(itemId)
    }
  }

  function resolveDropIndex(order: string[], draggedId: string, draggedCenterY: number): number {
    const remaining = order.filter((id) => id !== draggedId)
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]
      const rect = candidate ? itemRefs.current.get(candidate)?.getBoundingClientRect() : undefined
      if (rect && draggedCenterY < rect.top + rect.height / 2) return index
    }
    return remaining.length
  }

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>, itemId: string) {
    if (event.button !== 0 || currentIds.length < 2) return
    if (isSidebarDragIgnoredTarget(event.target)) return
    dragCleanupRef.current?.()

    const sourceElement = event.currentTarget
    const sourceRect = sourceElement.getBoundingClientRect()
    const pointerId = event.pointerId
    const session: SidebarListDragSession = {
      itemId,
      pointerId,
      startY: event.clientY,
      pointerOffsetY: event.clientY - sourceRect.top,
      width: sourceRect.width,
      sourceElement,
      ghostElement: null,
      originalOrder: [...displayedIds],
      active: false,
    }
    dragSessionRef.current = session

    try {
      sourceElement.setPointerCapture(pointerId)
    } catch {
      // Window listeners keep the drag active when pointer capture is unavailable.
    }

    const positionGhost = (clientY: number): number => {
      const ghost = session.ghostElement
      const top = clientY - session.pointerOffsetY
      if (ghost) ghost.style.transform = `translate3d(0, ${top}px, 0)`
      return top + sourceRect.height / 2
    }

    const activateDrag = (clientY: number) => {
      if (session.active) return
      session.active = true
      options.onDragStart?.()
      document.body.classList.add('sidebar-list-dragging')

      const ghost = sourceElement.cloneNode(true) as HTMLDivElement
      ghost.classList.add('sidebar-drag-ghost')
      ghost.setAttribute('aria-hidden', 'true')
      ghost.removeAttribute('role')
      ghost.removeAttribute('tabindex')
      ghost.style.left = `${sourceRect.left}px`
      ghost.style.width = `${sourceRect.width}px`
      ghost.style.height = `${sourceRect.height}px`
      document.body.appendChild(ghost)
      session.ghostElement = ghost
      positionGhost(clientY)

      dragOrderRef.current = [...session.originalOrder]
      setDragOrder(session.originalOrder)
      setDraggingId(itemId)
    }

    const finishDrag = (commit: boolean, updateReactState = true) => {
      if (dragSessionRef.current !== session) return
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      window.removeEventListener('blur', handlePointerCancel)
      if (sourceElement.hasPointerCapture(pointerId)) sourceElement.releasePointerCapture(pointerId)
      session.ghostElement?.remove()
      document.body.classList.remove('sidebar-list-dragging')

      if (commit && session.active) {
        const reordered = dragOrderRef.current ?? session.originalOrder
        if (reordered.some((id, index) => id !== session.originalOrder[index])) {
          options.onReorder(reordered)
        }
        suppressClickRef.current = true
        window.setTimeout(() => {
          suppressClickRef.current = false
        }, 0)
      }

      dragSessionRef.current = null
      dragOrderRef.current = null
      dragCleanupRef.current = null
      if (updateReactState) {
        setDragOrder(null)
        setDraggingId(null)
      }
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      if (!session.active) {
        if (Math.abs(moveEvent.clientY - session.startY) < SIDEBAR_LIST_DRAG_THRESHOLD_PX) return
        activateDrag(moveEvent.clientY)
      }

      moveEvent.preventDefault()
      const scrollContainer = options.scrollContainerRef?.current
      if (scrollContainer) {
        const rect = scrollContainer.getBoundingClientRect()
        if (moveEvent.clientY < rect.top + SIDEBAR_LIST_AUTO_SCROLL_EDGE_PX) {
          scrollContainer.scrollTop -= SIDEBAR_LIST_AUTO_SCROLL_STEP_PX
        } else if (moveEvent.clientY > rect.bottom - SIDEBAR_LIST_AUTO_SCROLL_EDGE_PX) {
          scrollContainer.scrollTop += SIDEBAR_LIST_AUTO_SCROLL_STEP_PX
        }
      }

      const draggedCenterY = positionGhost(moveEvent.clientY)
      const currentOrder = dragOrderRef.current ?? session.originalOrder
      const targetIndex = resolveDropIndex(currentOrder, itemId, draggedCenterY)
      const nextOrder = moveSidebarItem(currentOrder, itemId, targetIndex)
      if (nextOrder.every((id, index) => id === currentOrder[index])) return
      dragOrderRef.current = nextOrder
      setDragOrder(nextOrder)
    }

    const handlePointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return
      finishDrag(true)
    }
    const handlePointerCancel = () => finishDrag(false)

    dragCleanupRef.current = () => finishDrag(false, false)
    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    window.addEventListener('blur', handlePointerCancel)
  }

  function onPointerDown(itemId: string) {
    return (event: ReactPointerEvent<HTMLDivElement>) => beginDrag(event, itemId)
  }

  function onClickCapture(event: ReactMouseEvent<HTMLDivElement>) {
    if (!suppressClickRef.current) return
    event.preventDefault()
    event.stopPropagation()
    suppressClickRef.current = false
  }

  return {
    orderedIds: displayedIds,
    draggingId,
    itemRef,
    onPointerDown,
    onClickCapture,
  }
}

function normalizeDisplayedIds(order: readonly string[], currentIds: readonly string[]): string[] {
  const current = new Set(currentIds)
  return [
    ...order.filter((id, index) => current.has(id) && order.indexOf(id) === index),
    ...currentIds.filter((id) => !order.includes(id)),
  ]
}

export function moveSidebarItem(items: readonly string[], draggedItem: string, targetIndex: number): string[] {
  const sourceIndex = items.indexOf(draggedItem)
  if (sourceIndex < 0) return [...items]
  const next = [...items]
  next.splice(sourceIndex, 1)
  const insertAt = Math.max(0, Math.min(Math.trunc(targetIndex), next.length))
  next.splice(insertAt, 0, draggedItem)
  return next
}

function isSidebarDragIgnoredTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('[data-sidebar-drag-ignore], input, textarea, select, [contenteditable="true"]')) {
    return true
  }
  return Boolean(target.closest('button, a') && !target.closest('[data-sidebar-drag-source]'))
}
