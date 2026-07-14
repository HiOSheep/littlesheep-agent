// Owns renderer layout state, two-threshold resize interactions, workspace tabs, drafts, and recovery mirrors.
import '@xterm/xterm/css/xterm.css'
import { useEffect,useLayoutEffect,useMemo,useRef,useState,type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { projectSessions } from '../../shared/session-scope'
import {
createProjectFolder,
deleteProject,
deleteSession,
getPathForFile,
getRuntime,
getSessionMessages,
importAttachment,
listProjects,
listSessions,
readWorkspaceLayoutSnapshot,
rebindProject,
registerProject,
runAgentStream,
saveWorkspaceLayoutSnapshot,
selectAttachments,
selectWorkspace,
updateRuntime,
type ApprovalRequest,
type AttachmentRef,
type PermissionModeId,
type ProjectMeta,
type RuntimeState,
type SessionMeta
} from '../api'
import {
SessionApprovalGrantStore,
createDraftApprovalScopeKey,
sessionApprovalScopeKey,
type ApprovalDecision,
} from '../approval-grants'
import { PendingApprovalPrompt } from '../approval/types'
import { buildArtifactsFromToolCalls,buildTraceData,bumpLiveStepTools,mergeTaskBookIntoLiveSteps,taskStepToLiveStep,updateLastAssistantActivity,upsertLiveStep,upsertLiveTool } from '../chat/activity-model'
import { historyMessageToChatMessage } from '../chat/assistant-turn'
import { ChatMessage,LiveStepStatus } from '../chat/types'
import { syncComposerInputHeight } from '../composer/input-size'
import { formatUserMessage } from '../composer/message-files'
import { splitModelRef } from '../composer/runtime-picker'
import {
buildContextUsage,
buildContextUsageSnapshot,
type ContextUsageSnapshot
} from '../context-usage'
import {
MAX_NAVIGATION_EXPANDED_PATHS,
MAX_NAVIGATION_HISTORY_ENTRIES,
MAX_NAVIGATION_OPEN_TABS,
appendNavigationEntry,
boundStringList,
type NavigationHistoryState,
} from '../navigation-history'
import { DirectModulePage,SettingsPage } from '../settings/types'
import { FloatingHelpTip } from '../ui/floating-help'
import { beginResize,endResize } from '../ui/resize'
import {
WORKSPACE_PANEL_WIDTH_DEFAULT,
WORKSPACE_PANEL_WIDTH_MAX,
WORKSPACE_PANEL_WIDTH_MIN,
isWorkspacePanelReopenHotzone,
resolveWorkspacePanelDrag,
resolveWorkspacePanelLayout,
type WorkspacePanelDragMode,
} from '../workspace-layout'
import {
DEFAULT_WORKSPACE_PANEL_TABS,
WORKSPACE_PANEL_OPEN_TABS_MAX,
alignWorkspacePanelStateToRoot,
dedupeWorkspacePanelTabs,
hydrateWorkspaceLayoutFallbackSnapshot,
parseWorkspaceFileTabId,
rebindWorkspacePanelState,
rebindWorkspacePath,
serializeWorkspaceFileDrafts,
shouldUseWorkspaceLayoutFallback,
workspaceFileTabId,
type WorkspaceFileDraftState,
type WorkspaceFileTabId,
type WorkspaceOpenRequest,
type WorkspacePanelTabId
} from '../workspace-persistence'
import { dataTransferHasFiles,inferAttachmentKind,isSamePath,lastPathSegment,resolveWorkspacePreviewRoot,workspaceTitle } from './path-utils'
import { sortSessionsForSidebar,standaloneSessionsForSidebar,useListReorderAnimation } from '../app-shell/list-motion'
import { clampNumber,navigationSnapshotsEqual,rebindNavigationSnapshotWorkspace,routesEqual } from '../app-shell/navigation'
import { ACTIVE_SESSION_KEY,PINNED_SESSIONS_KEY,SIDEBAR_COLLAPSED_KEY,SIDEBAR_COLLAPSE_THRESHOLD,SIDEBAR_SETTLE_ANIMATION_MS,SIDEBAR_WIDTH_DEFAULT,SIDEBAR_WIDTH_KEY,SIDEBAR_WIDTH_MAX,SIDEBAR_WIDTH_MIN,TWO_STAGE_RESIZE_MOTION_MS,WORKSPACE_FILE_NAVIGATOR_COLLAPSED_KEY,WORKSPACE_PANEL_COLLAPSED_KEY,WORKSPACE_PANEL_FULLSCREEN_KEY,WORKSPACE_PANEL_MOTION_MS,WORKSPACE_PANEL_TAB_KEY,WORKSPACE_PANEL_WIDTH_KEY,readBooleanPreference,readNumberPreference,readStringPreference,readStringSetPreference,readWorkspaceFileDraftsPreference,readWorkspaceLayoutFallbackMarkers,readWorkspaceOpenRequestPreference,readWorkspacePanelOpenTabsPreference,readWorkspacePanelTabPreference,removePreference,shouldApplyWorkspaceLayoutFallback,writeBooleanPreference,writeNumberPreference,writeStringPreference,writeStringSetPreference,writeWorkspaceFileDraftsPreference,writeWorkspaceOpenRequestPreference,writeWorkspacePanelOpenTabsPreference } from '../app-shell/preferences'
import { AppNavigationSnapshot,AppRoute,SidebarPanel } from '../app-shell/types'
import type { Dispatch, SetStateAction } from 'react'

export function useWorkspaceLayoutController({ runtime, currentSession, input, setControlTip, setRuntimeError }: {
  runtime: RuntimeState | null
  currentSession: string | undefined
  input: string
  setControlTip: Dispatch<SetStateAction<FloatingHelpTip | null>>
  setRuntimeError: Dispatch<SetStateAction<string | null>>
}) {
  const projectPath = runtime?.workplace ?? runtime?.workspace ?? ''

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readBooleanPreference(SIDEBAR_COLLAPSED_KEY, false))
  const [workspacePanelCollapsed, setWorkspacePanelCollapsed] = useState(() => readBooleanPreference(WORKSPACE_PANEL_COLLAPSED_KEY, true))
  const [workspacePanelReopenActive, setWorkspacePanelReopenActive] = useState(false)
  const [workspacePanelFullscreen, setWorkspacePanelFullscreen] = useState(() => readBooleanPreference(WORKSPACE_PANEL_FULLSCREEN_KEY, false))
  const [workspacePanelTab, setWorkspacePanelTab] = useState<WorkspacePanelTabId>(() => readWorkspacePanelTabPreference(WORKSPACE_PANEL_TAB_KEY))
  const [workspacePanelOpenTabs, setWorkspacePanelOpenTabs] = useState<WorkspacePanelTabId[]>(() => readWorkspacePanelOpenTabsPreference())
  const [workspaceOpenRequest, setWorkspaceOpenRequest] = useState<WorkspaceOpenRequest | null>(() => readWorkspaceOpenRequestPreference())
  const [workspaceFileDrafts, setWorkspaceFileDrafts] = useState<Record<string, WorkspaceFileDraftState>>(() => readWorkspaceFileDraftsPreference())
  const [workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed] = useState(() => readBooleanPreference(WORKSPACE_FILE_NAVIGATOR_COLLAPSED_KEY, false))
  const [workspaceExpandedPaths, setWorkspaceExpandedPaths] = useState<string[]>([])
  const [pendingDirtyCloseTab, setPendingDirtyCloseTab] = useState<WorkspaceFileTabId | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const composerSyncFrameRef = useRef<number>()
  const activeDragCleanupRef = useRef<(() => void) | null>(null)
  const sidebarSettleFrameRef = useRef<number>()
  const sidebarSettleTimerRef = useRef<number>()
  const workspaceLayoutFallbackNeededRef = useRef(shouldUseWorkspaceLayoutFallback(readWorkspaceLayoutFallbackMarkers()))
  const workspaceLayoutMirrorReadyRef = useRef(false)
  const [workspaceLayoutMirrorReady, setWorkspaceLayoutMirrorReady] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readNumberPreference(SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX),
  )
  const [workspacePanelWidth, setWorkspacePanelWidth] = useState(() =>
    readNumberPreference(
      WORKSPACE_PANEL_WIDTH_KEY,
      WORKSPACE_PANEL_WIDTH_DEFAULT,
      WORKSPACE_PANEL_WIDTH_MIN,
      WORKSPACE_PANEL_WIDTH_MAX,
    ),
  )
  const workspacePanelLayout = useMemo(() => resolveWorkspacePanelLayout({
    viewportWidth,
    sidebarWidth,
    sidebarCollapsed,
    preferredWidth: workspacePanelWidth,
  }), [sidebarCollapsed, sidebarWidth, viewportWidth, workspacePanelWidth])
  const layoutStyle = useMemo(() => ({
    '--sidebar-width': `${sidebarWidth}px`,
    '--workspace-panel-width': `${workspacePanelLayout.width}px`,
    '--two-stage-resize-motion': `${TWO_STAGE_RESIZE_MOTION_MS}ms`,
  }) as CSSProperties, [sidebarWidth, workspacePanelLayout.width])

  useEffect(() => {
    writeNumberPreference(SIDEBAR_WIDTH_KEY, sidebarWidth)
  }, [sidebarWidth])

  useEffect(() => {
    writeNumberPreference(WORKSPACE_PANEL_WIDTH_KEY, workspacePanelWidth)
  }, [workspacePanelWidth])

  useEffect(() => {
    writeBooleanPreference(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed)
  }, [sidebarCollapsed])

  useEffect(() => {
    writeBooleanPreference(WORKSPACE_PANEL_COLLAPSED_KEY, workspacePanelCollapsed)
  }, [workspacePanelCollapsed])

  useEffect(() => {
    writeBooleanPreference(WORKSPACE_PANEL_FULLSCREEN_KEY, workspacePanelFullscreen)
  }, [workspacePanelFullscreen])

  useEffect(() => {
    writeStringPreference(WORKSPACE_PANEL_TAB_KEY, workspacePanelTab)
  }, [workspacePanelTab])

  useEffect(() => {
    writeWorkspacePanelOpenTabsPreference(workspacePanelOpenTabs)
  }, [workspacePanelOpenTabs])

  useEffect(() => {
    setWorkspacePanelOpenTabs((tabs) => (
      tabs.includes(workspacePanelTab)
        ? tabs
        : dedupeWorkspacePanelTabs(
          tabs.length >= WORKSPACE_PANEL_OPEN_TABS_MAX
            ? [...tabs.slice(1), workspacePanelTab]
            : [...tabs, workspacePanelTab],
        )
    ))
  }, [workspacePanelTab])

  useEffect(() => {
    writeWorkspaceOpenRequestPreference(workspaceOpenRequest)
  }, [workspaceOpenRequest])

  useEffect(() => {
    writeBooleanPreference(WORKSPACE_FILE_NAVIGATOR_COLLAPSED_KEY, workspaceFileNavigatorCollapsed)
  }, [workspaceFileNavigatorCollapsed])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeWorkspaceFileDraftsPreference(workspaceFileDrafts, workspacePanelOpenTabs)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [workspaceFileDrafts, workspacePanelOpenTabs])

  useEffect(() => {
    function flushWorkspaceFileDrafts() {
      writeWorkspaceFileDraftsPreference(workspaceFileDrafts, workspacePanelOpenTabs)
    }
    window.addEventListener('pagehide', flushWorkspaceFileDrafts)
    window.addEventListener('beforeunload', flushWorkspaceFileDrafts)
    return () => {
      window.removeEventListener('pagehide', flushWorkspaceFileDrafts)
      window.removeEventListener('beforeunload', flushWorkspaceFileDrafts)
    }
  }, [workspaceFileDrafts, workspacePanelOpenTabs])

  useLayoutEffect(() => {
    syncComposerInputHeight(inputRef.current)
  }, [input, sidebarCollapsed, sidebarWidth, viewportWidth, workspacePanelCollapsed, workspacePanelLayout.width])

  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth)
      setSidebarWidth((value) => clampNumber(value, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX))
      scheduleComposerHeightSync()
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.cancelAnimationFrame(composerSyncFrameRef.current ?? 0)
    }
  }, [])

  useEffect(() => {
    if (!runtime || workspaceLayoutMirrorReadyRef.current) return
    let disposed = false
    async function recoverWorkspaceLayoutFromMirror() {
      try {
        const snapshot = await readWorkspaceLayoutSnapshot()
        if (disposed) return
        const fallback = workspaceLayoutFallbackNeededRef.current
          ? hydrateWorkspaceLayoutFallbackSnapshot(snapshot)
          : null
        const defaultRoot = runtime?.workspace ?? runtime?.workplace ?? projectPath
        if (fallback && shouldApplyWorkspaceLayoutFallback(fallback.workspacePath, defaultRoot, fallback.openRequest)) {
          setWorkspacePanelWidth(clampNumber(
            fallback.width ?? WORKSPACE_PANEL_WIDTH_DEFAULT,
            WORKSPACE_PANEL_WIDTH_MIN,
            WORKSPACE_PANEL_WIDTH_MAX,
          ))
          setWorkspacePanelCollapsed(fallback.collapsed)
          setWorkspacePanelFullscreen(fallback.fullscreen)
          setWorkspacePanelOpenTabs(fallback.openTabs)
          setWorkspacePanelTab(fallback.activeTab)
          setWorkspaceOpenRequest(fallback.openRequest)
          setWorkspaceFileDrafts(fallback.drafts)
          setWorkspaceFileNavigatorCollapsed(fallback.fileNavigatorCollapsed)
        }
      } catch {
        // Layout mirror recovery is best-effort; localStorage remains the primary fast path.
      } finally {
        if (!disposed) {
          workspaceLayoutMirrorReadyRef.current = true
          setWorkspaceLayoutMirrorReady(true)
        }
      }
    }
    void recoverWorkspaceLayoutFromMirror()
    return () => {
      disposed = true
    }
  }, [projectPath, runtime])

  function scheduleComposerHeightSync() {
    window.cancelAnimationFrame(composerSyncFrameRef.current ?? 0)
    composerSyncFrameRef.current = window.requestAnimationFrame(() => {
      composerSyncFrameRef.current = undefined
      syncComposerInputHeight(inputRef.current)
    })
  }

  function beginSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
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
    beginResize('column')
    shellRef.current?.classList.add('sidebar-drag-live')

    const applyDragFrame = () => {
      frameHandle = undefined
      shellRef.current?.style.setProperty('--sidebar-width', `${pendingVisualWidth}px`)
    }

    const scheduleDragFrame = (visualWidth: number) => {
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

  function nudgeSidebar(delta: number) {
    setSidebarWidth((value) => clampNumber(value + delta, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX))
  }

  function toggleSidebar() {
    setControlTip(null)
    setSidebarCollapsed((value) => !value)
  }

  function beginWorkspacePanelResize(event: React.PointerEvent<HTMLDivElement>) {
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

  function toggleWorkspacePanel() {
    setControlTip(null)
    setWorkspacePanelReopenActive(false)
    setWorkspacePanelCollapsed((value) => !value)
    if (workspacePanelFullscreen) setWorkspacePanelFullscreen(false)
  }

  function updateWorkspacePanelReopenPresence(event: React.PointerEvent<HTMLElement>) {
    if (!workspacePanelCollapsed || workspacePanelFullscreen) {
      setWorkspacePanelReopenActive(false)
      return
    }
    const bounds = event.currentTarget.getBoundingClientRect()
    const active = isWorkspacePanelReopenHotzone(event.clientX, bounds.left, bounds.right)
    setWorkspacePanelReopenActive((current) => current === active ? current : active)
  }

  function toggleWorkspacePanelFullscreen() {
    setControlTip(null)
    setWorkspacePanelCollapsed(false)
    setWorkspacePanelFullscreen((value) => !value)
  }

  function nudgeWorkspacePanel(delta: number) {
    setWorkspacePanelWidth(clampNumber(
      workspacePanelLayout.width + delta,
      WORKSPACE_PANEL_WIDTH_MIN,
      workspacePanelLayout.maxSplitWidth,
    ))
  }

  function openWorkspacePanelTab(tab: WorkspacePanelTabId) {
    setControlTip(null)
    if (!workspacePanelOpenTabs.includes(tab) && workspacePanelOpenTabs.length >= WORKSPACE_PANEL_OPEN_TABS_MAX) {
      setRuntimeError(`拓展工作区最多打开 ${WORKSPACE_PANEL_OPEN_TABS_MAX} 个标签`)
      return
    }
    setWorkspacePanelOpenTabs((tabs) => (tabs.includes(tab) ? tabs : [...tabs, tab]))
    setWorkspacePanelTab(tab)
    setWorkspacePanelCollapsed(false)
  }

  function isWorkspaceFileTabDirty(tab: WorkspacePanelTabId): boolean {
    const fileTab = parseWorkspaceFileTabId(tab)
    if (!fileTab) return false
    const draft = workspaceFileDrafts[tab]
    return Boolean(draft && draft.editorText !== draft.savedText)
  }

  function updateWorkspaceFileDraft(tab: WorkspaceFileTabId, draft: WorkspaceFileDraftState | null) {
    setWorkspaceFileDrafts((drafts) => {
      const next = { ...drafts }
      if (draft) {
        next[tab] = draft
      } else {
        delete next[tab]
      }
      return next
    })
  }

  function closeWorkspacePanelTab(tab: WorkspacePanelTabId, options: { force?: boolean } = {}) {
    setControlTip(null)
    if (!options.force && isWorkspaceFileTabDirty(tab)) {
      setPendingDirtyCloseTab(tab as WorkspaceFileTabId)
      setWorkspacePanelCollapsed(false)
      setWorkspacePanelTab(tab)
      return
    }
    const tabIndex = workspacePanelOpenTabs.indexOf(tab)
    const nextTabs = workspacePanelOpenTabs.filter((item) => item !== tab)
    if (parseWorkspaceFileTabId(tab)) {
      setWorkspaceFileDrafts((drafts) => {
        if (!drafts[tab]) return drafts
        const next = { ...drafts }
        delete next[tab]
        return next
      })
    }
    if (nextTabs.length === 0) {
      const fallbackTab = DEFAULT_WORKSPACE_PANEL_TABS[0] ?? 'review'
      setWorkspacePanelOpenTabs(DEFAULT_WORKSPACE_PANEL_TABS)
      setWorkspacePanelTab(fallbackTab)
      setWorkspacePanelCollapsed(true)
      setWorkspacePanelFullscreen(false)
      return
    }
    setWorkspacePanelOpenTabs(nextTabs)
    if (workspacePanelTab === tab) {
      setWorkspacePanelTab(nextTabs[Math.max(0, tabIndex - 1)] ?? nextTabs[0] ?? 'review')
    }
  }

  const defaultWorkspacePath = runtime?.workspace ?? runtime?.workplace ?? projectPath
  const workspacePanelRoot = workspaceOpenRequest?.root ?? defaultWorkspacePath
  const workspacePanelUsingTemporaryRoot = !isSamePath(workspacePanelRoot, defaultWorkspacePath)

  useEffect(() => {
    if (!workspaceLayoutMirrorReady) return
    if (!workspacePanelRoot) return
    const timer = window.setTimeout(() => {
      const openRequest = workspaceOpenRequest
        ? { root: workspaceOpenRequest.root, path: workspaceOpenRequest.path }
        : null
      void saveWorkspaceLayoutSnapshot({
        workspacePath: workspacePanelRoot,
        sessionId: currentSession,
        width: workspacePanelWidth,
        collapsed: workspacePanelCollapsed,
        fullscreen: workspacePanelFullscreen,
        activeTab: workspacePanelTab,
        openTabs: workspacePanelOpenTabs,
        openRequest,
        fileNavigatorCollapsed: workspaceFileNavigatorCollapsed,
        drafts: serializeWorkspaceFileDrafts(workspaceFileDrafts, workspacePanelOpenTabs),
      }).catch(() => undefined)
    }, 500)
    return () => window.clearTimeout(timer)
  }, [
    currentSession,
    workspaceFileDrafts,
    workspaceFileNavigatorCollapsed,
    workspaceOpenRequest,
    workspacePanelCollapsed,
    workspacePanelFullscreen,
    workspacePanelOpenTabs,
    workspacePanelRoot,
    workspacePanelTab,
    workspacePanelWidth,
    workspaceLayoutMirrorReady,
  ])

  useEffect(() => () => {
    window.cancelAnimationFrame(composerSyncFrameRef.current ?? 0)
    window.cancelAnimationFrame(sidebarSettleFrameRef.current ?? 0)
    window.clearTimeout(sidebarSettleTimerRef.current)
    activeDragCleanupRef.current?.()
  }, [])

  return { sidebarCollapsed, setSidebarCollapsed, workspacePanelCollapsed, setWorkspacePanelCollapsed, workspacePanelReopenActive, setWorkspacePanelReopenActive, workspacePanelFullscreen, setWorkspacePanelFullscreen, workspacePanelTab, setWorkspacePanelTab, workspacePanelOpenTabs, setWorkspacePanelOpenTabs, workspaceOpenRequest, setWorkspaceOpenRequest, workspaceFileDrafts, setWorkspaceFileDrafts, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed, workspaceExpandedPaths, setWorkspaceExpandedPaths, pendingDirtyCloseTab, setPendingDirtyCloseTab, inputRef, shellRef, sidebarWidth, setSidebarWidth, workspacePanelWidth, setWorkspacePanelWidth, workspacePanelLayout, layoutStyle, beginSidebarResize, nudgeSidebar, toggleSidebar, beginWorkspacePanelResize, toggleWorkspacePanel, updateWorkspacePanelReopenPresence, toggleWorkspacePanelFullscreen, nudgeWorkspacePanel, openWorkspacePanelTab, updateWorkspaceFileDraft, closeWorkspacePanelTab, defaultWorkspacePath, workspacePanelRoot, workspacePanelUsingTemporaryRoot }
}

export type WorkspaceLayoutController = ReturnType<typeof useWorkspaceLayoutController>
