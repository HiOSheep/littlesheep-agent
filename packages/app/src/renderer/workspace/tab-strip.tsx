// Workspace tab strip: feature tabs, file tabs, and persistent browser tabs.
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { useListReorderAnimation } from '../app-shell/list-motion'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { CloseMiniIcon, FileGlyphIcon, WorkspaceFeatureIcon } from '../ui/icons'
import { OverflowingLabel } from '../ui/overflowing-label'
import { transientTriggerProps } from '../ui/transient'
import {
  isWorkspacePanelTab,
  parseWorkspaceFileTabId,
  type WorkspaceFileDraftState,
  type WorkspaceFileTabId,
  type WorkspacePanelTab,
  type WorkspacePanelTabId,
} from '../workspace-persistence'
import { WorkspaceAddMenu } from './add-menu'
import { isWorkspaceBrowserTabId, type WorkspaceBrowserTab, type WorkspaceBrowserTabId } from './browser-tabs'
import { lastPathSegment } from './path-utils'
import { applyWorkspaceTabSubsetOrder, moveWorkspaceTab } from './tab-order'

type WorkspaceEntry = { id: WorkspacePanelTab; label: string; desc: string }
type DisplayedWorkspaceEntry = {
  label: string
  desc: string
  dirty: boolean
} & (
  | { id: WorkspacePanelTab; kind: 'feature' }
  | { id: WorkspaceFileTabId; kind: 'file' }
  | { id: WorkspaceBrowserTabId; kind: 'browser' }
)

interface WorkspaceTabDragSession {
  tabId: WorkspacePanelTabId
  pointerId: number
  startX: number
  startY: number
  pointerOffsetX: number
  pointerOffsetY: number
  width: number
  sourceElement: HTMLDivElement
  ghostElement: HTMLDivElement | null
  originalVisibleOrder: WorkspacePanelTabId[]
  originalOpenTabs: WorkspacePanelTabId[]
  tabStripContentOrigin: number | null
  tabStripGap: number
  active: boolean
}

const WORKSPACE_TAB_DRAG_THRESHOLD_PX = 4
const WORKSPACE_TAB_AUTO_SCROLL_EDGE_PX = 28
const WORKSPACE_TAB_AUTO_SCROLL_STEP_PX = 14
const WORKSPACE_TAB_PUSH_DURATION_MS = 160

export function WorkspaceTabStrip({
  activeTab,
  openTabs,
  browserTabs,
  fileDrafts,
  workspaceEntries,
  onTabChange,
  onTabsReorder,
  onCloseTab,
  onOpenBrowserTab,
  onTipChange,
}: {
  activeTab: WorkspacePanelTabId
  openTabs: WorkspacePanelTabId[]
  browserTabs: WorkspaceBrowserTab[]
  fileDrafts: Record<string, WorkspaceFileDraftState>
  workspaceEntries: WorkspaceEntry[]
  onTabChange: (tab: WorkspacePanelTabId) => void
  onTabsReorder: (tabs: WorkspacePanelTabId[]) => void
  onCloseTab: (tab: WorkspacePanelTabId) => void | Promise<void>
  onOpenBrowserTab: (url: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const browserEntry = (tabId: WorkspaceBrowserTabId): DisplayedWorkspaceEntry => {
    const tab = browserTabs.find((item) => item.id === tabId)
    return {
      id: tabId,
      label: tab?.title || '浏览器',
      desc: tab?.url || '新建浏览器标签',
      kind: 'browser' as const,
      dirty: false,
    }
  }
  const workspaceEntryById = new Map(workspaceEntries.map((entry) => [entry.id, entry]))
  const visibleTabs = openTabs
    .map<DisplayedWorkspaceEntry | null>((tab) => {
      const fileTab = parseWorkspaceFileTabId(tab)
      if (fileTab) {
        return {
          id: tab as WorkspaceFileTabId,
          label: lastPathSegment(fileTab.path),
          desc: fileTab.path,
          kind: 'file' as const,
          dirty: Boolean(fileDrafts[tab]?.editorText !== fileDrafts[tab]?.savedText),
        }
      }
      if (isWorkspaceBrowserTabId(tab)) return browserEntry(tab)
      const entry = isWorkspacePanelTab(tab) ? workspaceEntryById.get(tab) : undefined
      return entry ? { ...entry, kind: 'feature' as const, dirty: false } : null
    })
    .filter((entry): entry is DisplayedWorkspaceEntry => Boolean(entry))
  const [draggingTabId, setDraggingTabId] = useState<WorkspacePanelTabId | null>(null)
  const [dragOrder, setDragOrder] = useState<WorkspacePanelTabId[] | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<WorkspacePanelTabId, HTMLDivElement>())
  const dragSessionRef = useRef<WorkspaceTabDragSession | null>(null)
  const dragOrderRef = useRef<WorkspacePanelTabId[] | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const suppressClickRef = useRef(false)
  const visibleEntryById = new Map(visibleTabs.map((entry) => [entry.id, entry]))
  const visibleTabIds = visibleTabs.map((entry) => entry.id)
  const displayedTabs = (dragOrder ?? visibleTabIds)
    .map((tabId) => visibleEntryById.get(tabId))
    .filter((entry): entry is DisplayedWorkspaceEntry => Boolean(entry))
  const tabMotionRef = useListReorderAnimation<HTMLDivElement>(
    displayedTabs.map((entry) => entry.id),
    {
      duration: WORKSPACE_TAB_PUSH_DURATION_MS,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    },
  )

  useEffect(() => () => dragCleanupRef.current?.(), [])

  function handleTabStripWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const strip = event.currentTarget
    if (strip.scrollWidth <= strip.clientWidth) return

    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.deltaY
    if (delta === 0) return

    const previousScrollLeft = strip.scrollLeft
    const maxScrollLeft = strip.scrollWidth - strip.clientWidth
    const nextScrollLeft = Math.max(
      0,
      Math.min(maxScrollLeft, previousScrollLeft + delta),
    )
    if (nextScrollLeft === previousScrollLeft) return

    event.preventDefault()
    strip.scrollLeft = nextScrollLeft
  }

  function resolveDropIndexFromRects(
    order: WorkspacePanelTabId[],
    draggedTab: WorkspacePanelTabId,
    draggedCenterX: number,
  ): number {
    const remainingTabs = order.filter((tab) => tab !== draggedTab)
    for (let index = 0; index < remainingTabs.length; index += 1) {
      const tab = remainingTabs[index]
      if (!tab) continue
      const rect = tabRefs.current.get(tab)?.getBoundingClientRect()
      if (rect && draggedCenterX < rect.left + rect.width / 2) return index
    }
    return remainingTabs.length
  }

  function resolveDropIndex(
    order: WorkspacePanelTabId[],
    draggedTab: WorkspacePanelTabId,
    draggedCenterX: number,
    session: WorkspaceTabDragSession,
  ): number {
    const strip = stripRef.current
    if (!strip || session.tabStripContentOrigin === null) {
      return resolveDropIndexFromRects(order, draggedTab, draggedCenterX)
    }

    const stripRect = strip.getBoundingClientRect()
    let left = stripRect.left + session.tabStripContentOrigin - strip.scrollLeft
    let insertIndex = 0
    for (const tab of order) {
      const element = tabRefs.current.get(tab)
      const width = element?.getBoundingClientRect().width ?? 0
      if (tab !== draggedTab && draggedCenterX < left + width / 2) return insertIndex
      left += width + session.tabStripGap
      if (tab !== draggedTab) insertIndex += 1
    }
    return insertIndex
  }

  function beginTabDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    tabId: WorkspacePanelTabId,
  ) {
    if (event.button !== 0 || visibleTabs.length < 2) return
    if ((event.target as HTMLElement).closest('button')) return
    dragCleanupRef.current?.()

    const sourceElement = event.currentTarget
    const sourceRect = sourceElement.getBoundingClientRect()
    const strip = stripRef.current
    const stripRect = strip?.getBoundingClientRect()
    const firstTabRect = tabRefs.current.get(visibleTabIds[0] ?? tabId)?.getBoundingClientRect()
    const tabStripContentOrigin = strip && stripRect && firstTabRect
      ? firstTabRect.left - stripRect.left + strip.scrollLeft
      : null
    const tabStripGap = strip
      ? Number.parseFloat(window.getComputedStyle(strip).columnGap || window.getComputedStyle(strip).gap) || 0
      : 0
    const pointerId = event.pointerId
    const session: WorkspaceTabDragSession = {
      tabId,
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      pointerOffsetX: event.clientX - sourceRect.left,
      pointerOffsetY: event.clientY - sourceRect.top,
      width: sourceRect.width,
      sourceElement,
      ghostElement: null,
      originalVisibleOrder: [...visibleTabIds],
      originalOpenTabs: [...openTabs],
      tabStripContentOrigin,
      tabStripGap,
      active: false,
    }
    dragSessionRef.current = session

    try {
      sourceElement.setPointerCapture(pointerId)
    } catch {
      // Window listeners keep the drag active when pointer capture is unavailable.
    }

    const positionGhost = (clientX: number, clientY: number): number => {
      const ghost = session.ghostElement
      const left = clientX - session.pointerOffsetX
      const top = clientY - session.pointerOffsetY
      if (ghost) ghost.style.transform = `translate3d(${left}px, ${top}px, 0)`
      return left + session.width / 2
    }

    const activateDrag = (clientX: number, clientY: number) => {
      if (session.active) return
      session.active = true
      onTipChange(null)
      document.body.classList.add('workspace-tab-dragging')

      const ghost = sourceElement.cloneNode(true) as HTMLDivElement
      ghost.classList.remove('is-dragging')
      ghost.classList.add('workspace-active-drag-ghost')
      ghost.setAttribute('aria-hidden', 'true')
      ghost.removeAttribute('role')
      ghost.removeAttribute('tabindex')
      ghost.style.width = `${sourceRect.width}px`
      ghost.style.height = `${sourceRect.height}px`
      document.body.appendChild(ghost)
      session.ghostElement = ghost
      positionGhost(clientX, clientY)

      dragOrderRef.current = [...session.originalVisibleOrder]
      setDragOrder(session.originalVisibleOrder)
      setDraggingTabId(tabId)
    }

    const finishDrag = (commit: boolean, updateReactState = true) => {
      if (dragSessionRef.current !== session) return
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      window.removeEventListener('blur', handlePointerCancel)
      if (sourceElement.hasPointerCapture(pointerId)) sourceElement.releasePointerCapture(pointerId)
      session.ghostElement?.remove()
      document.body.classList.remove('workspace-tab-dragging')

      if (commit && session.active) {
        const reorderedVisibleTabs = dragOrderRef.current ?? session.originalVisibleOrder
        const reorderedOpenTabs = applyWorkspaceTabSubsetOrder(
          session.originalOpenTabs,
          reorderedVisibleTabs,
        )
        if (reorderedOpenTabs.some((tab, index) => tab !== session.originalOpenTabs[index])) {
          onTabsReorder(reorderedOpenTabs)
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
        setDraggingTabId(null)
      }
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      if (!session.active) {
        const distance = Math.hypot(
          moveEvent.clientX - session.startX,
          moveEvent.clientY - session.startY,
        )
        if (distance < WORKSPACE_TAB_DRAG_THRESHOLD_PX) return
        activateDrag(moveEvent.clientX, moveEvent.clientY)
      }

      moveEvent.preventDefault()
      const strip = stripRef.current
      if (strip) {
        const stripRect = strip.getBoundingClientRect()
        if (moveEvent.clientX < stripRect.left + WORKSPACE_TAB_AUTO_SCROLL_EDGE_PX) {
          strip.scrollLeft -= WORKSPACE_TAB_AUTO_SCROLL_STEP_PX
        } else if (moveEvent.clientX > stripRect.right - WORKSPACE_TAB_AUTO_SCROLL_EDGE_PX) {
          strip.scrollLeft += WORKSPACE_TAB_AUTO_SCROLL_STEP_PX
        }
      }

      const draggedCenterX = positionGhost(moveEvent.clientX, moveEvent.clientY)
      const currentOrder = dragOrderRef.current ?? session.originalVisibleOrder
      const targetIndex = resolveDropIndex(currentOrder, tabId, draggedCenterX, session)
      const nextOrder = moveWorkspaceTab(currentOrder, tabId, targetIndex)
      if (nextOrder.every((tab, index) => tab === currentOrder[index])) return
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

  return (
    <div
      ref={stripRef}
      className="workspace-tab-strip"
      role="tablist"
      aria-label="拓展功能区"
      onWheel={handleTabStripWheel}
    >
      {displayedTabs.map((entry) => {
        const active = entry.id === activeTab
        const dragging = entry.id === draggingTabId
        return (
          <div
            ref={(element) => {
              if (element) tabRefs.current.set(entry.id, element)
              else tabRefs.current.delete(entry.id)
              tabMotionRef(entry.id)(element)
            }}
            key={entry.id}
            className={`workspace-active-item ${active ? 'active' : ''} ${entry.kind === 'file' && entry.dirty ? 'file-dirty' : ''} ${dragging ? 'is-dragging' : ''}`}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            aria-grabbed={dragging || undefined}
            onPointerDown={(event) => beginTabDrag(event, entry.id)}
            onClick={() => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false
                return
              }
              onTabChange(entry.id)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onTabChange(entry.id)
            }}
            onMouseEnter={(event) => {
              if (!dragSessionRef.current?.active) {
                onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))
              }
            }}
            onMouseMove={(event) => {
              if (!dragSessionRef.current?.active) {
                onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))
              }
            }}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(entry.desc, event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            {entry.kind === 'file'
              ? <FileGlyphIcon name={entry.label} />
              : <WorkspaceFeatureIcon id={entry.kind === 'browser' ? 'browser' : entry.id} />}
            <OverflowingLabel
              label={entry.label}
              className="workspace-active-label"
              textClassName="workspace-active-label-text"
            />
            <button
              {...transientTriggerProps()}
              className="workspace-active-close"
              type="button"
              aria-label={`关闭${entry.label}标签`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                void onCloseTab(entry.id)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                event.stopPropagation()
                void onCloseTab(entry.id)
              }}
            >
              <CloseMiniIcon />
            </button>
          </div>
        )
      })}
      <WorkspaceAddMenu
        entries={workspaceEntries}
        activeTab={isWorkspacePanelTab(activeTab) && displayedTabs.some((entry) => entry.id === activeTab) ? activeTab : null}
        openTabs={displayedTabs.map((entry) => entry.id).filter(isWorkspacePanelTab)}
        onSelect={onTabChange}
        onOpenBrowserTab={onOpenBrowserTab}
        onTipChange={onTipChange}
      />
    </div>
  )
}
