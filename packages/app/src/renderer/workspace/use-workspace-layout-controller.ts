// Owns renderer layout state, two-threshold resize interactions, workspace tabs, drafts, and recovery mirrors.
import '@xterm/xterm/css/xterm.css'
import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { readWorkspaceLayoutSnapshot, saveWorkspaceLayoutSnapshot, type RuntimeState } from '../api'
import { clampNumber } from '../app-shell/navigation'
import { SIDEBAR_COLLAPSED_KEY, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, TWO_STAGE_RESIZE_MOTION_MS, WORKSPACE_FILE_NAVIGATOR_COLLAPSED_KEY, WORKSPACE_PANEL_COLLAPSED_KEY, WORKSPACE_PANEL_FULLSCREEN_KEY, WORKSPACE_PANEL_TAB_KEY, WORKSPACE_PANEL_WIDTH_KEY, readBooleanPreference, readNumberPreference, readWorkspaceFileDraftsPreference, readWorkspaceLayoutFallbackMarkers, readWorkspaceOpenRequestPreference, readWorkspacePanelOpenTabsPreference, readWorkspacePanelTabPreference, shouldApplyWorkspaceLayoutFallback, writeBooleanPreference, writeNumberPreference, writeStringPreference, writeWorkspaceFileDraftsPreference, writeWorkspaceOpenRequestPreference, writeWorkspacePanelOpenTabsPreference } from '../app-shell/preferences'
import { syncComposerInputHeight } from '../composer/input-size'
import { beginSidebarResizeInteraction } from '../sidebar/resize-interaction'
import { FloatingHelpTip } from '../ui/floating-help'
import {
  WORKSPACE_PANEL_WIDTH_DEFAULT,
  WORKSPACE_PANEL_WIDTH_MAX,
  WORKSPACE_PANEL_WIDTH_MIN,
  isWorkspacePanelReopenHotzone,
  resolveWorkspacePanelLayout
} from '../workspace-layout'
import {
  DEFAULT_WORKSPACE_PANEL_TABS,
  WORKSPACE_PANEL_OPEN_TABS_MAX,
  dedupeWorkspacePanelTabs,
  hydrateWorkspaceLayoutFallbackSnapshot,
  parseWorkspaceFileTabId,
  serializeWorkspaceFileDrafts,
  shouldUseWorkspaceLayoutFallback,
  type WorkspaceFileDraftState,
  type WorkspaceFileTabId,
  type WorkspaceOpenRequest,
  type WorkspacePanelTabId
} from '../workspace-persistence'
import { isSamePath } from './path-utils'
import { beginWorkspacePanelResizeInteraction } from './resize-interaction'
import { useWorkspaceBrowserController } from './use-browser-controller'
import { isWorkspaceBrowserTabId } from './browser-tabs'

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

  const browserController = useWorkspaceBrowserController({
    workspacePanelTab,
    setWorkspacePanelTab,
    workspacePanelOpenTabs,
    setWorkspacePanelOpenTabs,
    setWorkspacePanelCollapsed,
    setRuntimeError,
  })
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
    if (workspacePanelOpenTabs.length === 0) return
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
    beginSidebarResizeInteraction(event, { activeDragCleanupRef, setControlTip, sidebarCollapsed, sidebarWidth, shellRef, sidebarSettleTimerRef, sidebarSettleFrameRef, setSidebarWidth, setSidebarCollapsed, scheduleComposerHeightSync })
  }

  function nudgeSidebar(delta: number) {
    setSidebarWidth((value) => clampNumber(value + delta, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX))
  }

  function toggleSidebar() {
    setControlTip(null)
    setSidebarCollapsed((value) => !value)
  }
  function beginWorkspacePanelResize(event: React.PointerEvent<HTMLDivElement>) {
    beginWorkspacePanelResizeInteraction(event, { workspacePanelCollapsed, workspacePanelFullscreen, activeDragCleanupRef, setControlTip, workspacePanelLayout, shellRef, setWorkspacePanelCollapsed, setWorkspacePanelFullscreen, setWorkspacePanelWidth, scheduleComposerHeightSync })
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
    if (isWorkspaceBrowserTabId(tab)) browserController.ensureWorkspaceBrowserTab(tab)
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
    if (isWorkspaceBrowserTabId(tab) && tab !== 'browser') browserController.removeWorkspaceBrowserTab(tab)
    if (parseWorkspaceFileTabId(tab)) {
      setWorkspaceFileDrafts((drafts) => {
        if (!drafts[tab]) return drafts
        const next = { ...drafts }
        delete next[tab]
        return next
      })
    }
    if (nextTabs.length === 0) {
      setWorkspacePanelOpenTabs([])
      setWorkspacePanelTab(DEFAULT_WORKSPACE_PANEL_TABS[0] ?? 'review')
      setWorkspacePanelCollapsed(false)
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

  return { sidebarCollapsed, setSidebarCollapsed, workspacePanelCollapsed, setWorkspacePanelCollapsed, workspacePanelReopenActive, setWorkspacePanelReopenActive, workspacePanelFullscreen, setWorkspacePanelFullscreen, workspacePanelTab, setWorkspacePanelTab, workspacePanelOpenTabs, setWorkspacePanelOpenTabs, ...browserController, workspaceOpenRequest, setWorkspaceOpenRequest, workspaceFileDrafts, setWorkspaceFileDrafts, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed, workspaceExpandedPaths, setWorkspaceExpandedPaths, pendingDirtyCloseTab, setPendingDirtyCloseTab, inputRef, shellRef, sidebarWidth, setSidebarWidth, workspacePanelWidth, setWorkspacePanelWidth, workspacePanelLayout, layoutStyle, beginSidebarResize, nudgeSidebar, toggleSidebar, beginWorkspacePanelResize, toggleWorkspacePanel, updateWorkspacePanelReopenPresence, toggleWorkspacePanelFullscreen, nudgeWorkspacePanel, openWorkspacePanelTab, updateWorkspaceFileDraft, closeWorkspacePanelTab, defaultWorkspacePath, workspacePanelRoot, workspacePanelUsingTemporaryRoot }
}

export type WorkspaceLayoutController = ReturnType<typeof useWorkspaceLayoutController>
