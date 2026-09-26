// Owns renderer layout state, two-threshold resize interactions, workspace tabs, drafts, and recovery mirrors.
import '@xterm/xterm/css/xterm.css'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { APPLICATION_PERSISTENCE_FLUSH_EVENT } from '../../shared/application-state-contracts'
import {
  saveWorkspaceFile,
  type RuntimeState,
  type WorkspacePreview,
} from '../api'
import { clampNumber } from '../app-shell/navigation'
import {
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  TWO_STAGE_RESIZE_MOTION_MS,
  WORKSPACE_PANEL_WIDTH_KEY,
  readBooleanPreference,
  readNumberPreference,
  writeBooleanPreference,
  writeNumberPreference,
} from '../app-shell/preferences'
import { syncComposerInputHeight } from '../composer/input-size'
import { beginSidebarResizeInteraction } from '../sidebar/resize-interaction'
import { FloatingHelpTip } from '../ui/floating-help'
import {
  WORKSPACE_PANEL_WIDTH_DEFAULT,
  WORKSPACE_PANEL_WIDTH_MAX,
  WORKSPACE_PANEL_WIDTH_MIN,
  RESPONSIVE_LAYOUT_PREFERENCE_MAX,
  RESPONSIVE_LAYOUT_PREFERENCE_MIN,
  isWorkspacePanelReopenHotzone,
  resolveResponsiveWidth,
  resolveWorkspacePanelLayout,
  toResponsiveWidthPreference,
} from '../workspace-layout'
import {
  WINDOW_RESIZE_END_EVENT,
  WINDOW_RESIZE_SETTLE_DELAY_MS,
  WINDOW_RESIZE_START_EVENT,
} from '../ui/resize'
import {
  DEFAULT_WORKSPACE_PANEL_TABS,
  WORKSPACE_PANEL_OPEN_TABS_MAX,
  parseWorkspaceFileTabId,
  type WorkspaceFileDraftState,
  type WorkspaceFileTabId,
  type WorkspacePanelTabId,
  type WorkspaceReviewRequest,
} from '../workspace-persistence'
import { saveWorkspaceFileBeforeClose } from './file-close'
import { workspaceFilePreviewCache } from './file-preview-cache'
import { isSamePath, workspaceBreadcrumbs } from './path-utils'
import { beginWorkspacePanelResizeInteraction } from './resize-interaction'
import { useWorkspaceBrowserController } from './use-browser-controller'
import { isWorkspaceBrowserTabId } from './browser-tabs'
import { useWorkspaceSessionLayouts } from './use-workspace-session-layouts'

export function useWorkspaceLayoutController({
  runtime,
  currentSession,
  input,
  setControlTip,
  setRuntimeError,
  onRequestFileSaveApproval,
  onWorkspaceArtifactsChanged,
  onWorkspaceFileSaved,
}: {
  runtime: RuntimeState | null
  currentSession: string | undefined
  input: string
  setControlTip: Dispatch<SetStateAction<FloatingHelpTip | null>>
  setRuntimeError: Dispatch<SetStateAction<string | null>>
  onRequestFileSaveApproval: (detail: unknown) => Promise<boolean>
  onWorkspaceArtifactsChanged: () => void
  onWorkspaceFileSaved: (root: string, path: string, preview: WorkspacePreview) => void
}) {
  const defaultWorkspacePath = runtime?.workspace ?? runtime?.workplace ?? ''

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readBooleanPreference(SIDEBAR_COLLAPSED_KEY, false))
  const [workspacePanelReopenActive, setWorkspacePanelReopenActive] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const composerSyncFrameRef = useRef<number>()
  const viewportResizeFrameRef = useRef<number>()
  const viewportResizeEndTimerRef = useRef<number>()
  const activeDragCleanupRef = useRef<(() => void) | null>(null)
  const sidebarSettleFrameRef = useRef<number>()
  const sidebarSettleTimerRef = useRef<number>()
  const workspacePanelSettleTimerRef = useRef<number>()
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [sidebarWidthPreference, setSidebarWidthPreference] = useState(() =>
    readNumberPreference(
      SIDEBAR_WIDTH_KEY,
      SIDEBAR_WIDTH_DEFAULT,
      RESPONSIVE_LAYOUT_PREFERENCE_MIN,
      RESPONSIVE_LAYOUT_PREFERENCE_MAX,
    ),
  )
  const [workspacePanelWidthPreference, setWorkspacePanelWidthPreference] = useState(() =>
    readNumberPreference(
      WORKSPACE_PANEL_WIDTH_KEY,
      WORKSPACE_PANEL_WIDTH_DEFAULT,
      RESPONSIVE_LAYOUT_PREFERENCE_MIN,
      RESPONSIVE_LAYOUT_PREFERENCE_MAX,
    ),
  )
  const sidebarWidth = useMemo(() => resolveResponsiveWidth(
    sidebarWidthPreference,
    viewportWidth,
    SIDEBAR_WIDTH_MIN,
    SIDEBAR_WIDTH_MAX,
  ), [sidebarWidthPreference, viewportWidth])
  const workspacePanelWidth = useMemo(() => resolveResponsiveWidth(
    workspacePanelWidthPreference,
    viewportWidth,
    WORKSPACE_PANEL_WIDTH_MIN,
    WORKSPACE_PANEL_WIDTH_MAX,
  ), [viewportWidth, workspacePanelWidthPreference])
  const setSidebarWidth = useCallback<Dispatch<SetStateAction<number>>>((update) => {
    setSidebarWidthPreference((preference) => {
      const currentWidth = resolveResponsiveWidth(
        preference,
        viewportWidth,
        SIDEBAR_WIDTH_MIN,
        SIDEBAR_WIDTH_MAX,
      )
      const nextWidth = resolveStateAction(update, currentWidth)
      return toResponsiveWidthPreference(nextWidth, viewportWidth, SIDEBAR_WIDTH_MAX)
    })
  }, [viewportWidth])
  const setWorkspacePanelWidth = useCallback<Dispatch<SetStateAction<number>>>((update) => {
    setWorkspacePanelWidthPreference((preference) => {
      const currentWidth = resolveResponsiveWidth(
        preference,
        viewportWidth,
        WORKSPACE_PANEL_WIDTH_MIN,
        WORKSPACE_PANEL_WIDTH_MAX,
      )
      const nextWidth = resolveStateAction(update, currentWidth)
      return toResponsiveWidthPreference(nextWidth, viewportWidth, WORKSPACE_PANEL_WIDTH_MAX)
    })
  }, [viewportWidth])
  const durableLayoutRef = useRef({ sidebarCollapsed, sidebarWidthPreference, workspacePanelWidthPreference })
  durableLayoutRef.current = { sidebarCollapsed, sidebarWidthPreference, workspacePanelWidthPreference }
  const {
    activeWorkspaceSessionKey,
    activeWorkspaceSessionKeyRef,
    workspaceSessionLayoutsRef,
    closingWorkspaceFileTabsRef,
    workspacePanelRoot,
    workspacePanelCollapsed,
    workspacePanelFullscreen,
    workspacePanelTab,
    workspacePanelOpenTabs,
    workspaceOpenRequest,
    workspaceFileDrafts,
    workspaceFileNavigatorCollapsed,
    workspaceFileNavigatorWidth, workspaceReviewNavigatorWidth,
    workspaceExpandedPaths,
    workspaceBrowserTabs,
    setWorkspacePanelCollapsed,
    setWorkspacePanelFullscreen,
    setWorkspacePanelTab,
    setWorkspacePanelOpenTabs,
    setWorkspaceOpenRequest,
    setWorkspaceFileDrafts,
    setWorkspaceSessionFileDrafts,
    setWorkspaceFileNavigatorCollapsed,
    setWorkspaceFileNavigatorWidth, setWorkspaceReviewNavigatorWidth,
    setWorkspaceExpandedPaths,
    setWorkspaceBrowserTabs,
    commitWorkspaceSessionLayout,
    resetWorkspaceSessionLayout,
    removeWorkspaceSessionLayout,
    alignWorkspaceSessionToRoot,
    rebindWorkspaceSessionLayouts,
  } = useWorkspaceSessionLayouts({
    runtime,
    currentSession,
    defaultWorkspacePath,
    workspacePanelWidthPreference,
    setWorkspacePanelWidthPreference,
    setWorkspacePanelReopenActive,
  })
  const browserController = useWorkspaceBrowserController({
    workspaceBrowserTabs,
    setWorkspaceBrowserTabs,
    workspacePanelTab,
    setWorkspacePanelTab,
    workspacePanelOpenTabs,
    setWorkspacePanelOpenTabs,
    setWorkspacePanelCollapsed,
    setRuntimeError,
  })
  const [workspaceReviewRequest, setWorkspaceReviewRequest] = useState<WorkspaceReviewRequest | null>(null)
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
    writeNumberPreference(SIDEBAR_WIDTH_KEY, sidebarWidthPreference)
  }, [sidebarWidthPreference])
  useEffect(() => {
    writeNumberPreference(WORKSPACE_PANEL_WIDTH_KEY, workspacePanelWidthPreference)
  }, [workspacePanelWidthPreference])

  useEffect(() => {
    writeBooleanPreference(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed)
  }, [sidebarCollapsed])

  useEffect(() => {
    const flushLayoutPreferences = () => {
      const state = durableLayoutRef.current
      writeBooleanPreference(SIDEBAR_COLLAPSED_KEY, state.sidebarCollapsed)
      writeNumberPreference(SIDEBAR_WIDTH_KEY, state.sidebarWidthPreference)
      writeNumberPreference(WORKSPACE_PANEL_WIDTH_KEY, state.workspacePanelWidthPreference)
    }
    window.addEventListener(APPLICATION_PERSISTENCE_FLUSH_EVENT, flushLayoutPreferences)
    return () => window.removeEventListener(APPLICATION_PERSISTENCE_FLUSH_EVENT, flushLayoutPreferences)
  }, [])

  useLayoutEffect(() => {
    syncComposerInputHeight(inputRef.current)
  }, [input, sidebarCollapsed, sidebarWidth, viewportWidth, workspacePanelCollapsed, workspacePanelLayout.width])

  useEffect(() => {
    const textarea = inputRef.current
    if (!textarea || typeof ResizeObserver === 'undefined') return

    let observedWidth: number | undefined
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width
      if (nextWidth === undefined) return
      if (observedWidth !== undefined && Math.abs(nextWidth - observedWidth) < 0.5) return
      observedWidth = nextWidth
      scheduleComposerHeightSync()
    })
    observer.observe(textarea)

    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(composerSyncFrameRef.current ?? 0)
    }
  }, [])

  useEffect(() => {
    const beginWindowResize = () => {
      if (document.body.classList.contains('is-window-resizing')) return
      document.body.classList.add('is-window-resizing')
      window.dispatchEvent(new Event(WINDOW_RESIZE_START_EVENT))
    }
    const scheduleWindowResizeEnd = () => {
      window.clearTimeout(viewportResizeEndTimerRef.current)
      viewportResizeEndTimerRef.current = window.setTimeout(() => {
        viewportResizeEndTimerRef.current = undefined
        const settledViewportWidth = window.innerWidth
        applyViewportLayoutVariables(settledViewportWidth)
        setViewportWidth((current) => current === settledViewportWidth ? current : settledViewportWidth)
        document.body.classList.remove('is-window-resizing')
        window.dispatchEvent(new Event(WINDOW_RESIZE_END_EVENT))
        scheduleComposerHeightSync()
      }, WINDOW_RESIZE_SETTLE_DELAY_MS)
    }
    const applyViewportLayoutVariables = (nextViewportWidth: number) => {
      const shell = shellRef.current
      if (!shell || !Number.isFinite(nextViewportWidth) || nextViewportWidth <= 0) return

      const state = durableLayoutRef.current
      const nextSidebarWidth = resolveResponsiveWidth(
        state.sidebarWidthPreference,
        nextViewportWidth,
        SIDEBAR_WIDTH_MIN,
        SIDEBAR_WIDTH_MAX,
      )
      const nextWorkspacePreferenceWidth = resolveResponsiveWidth(
        state.workspacePanelWidthPreference,
        nextViewportWidth,
        WORKSPACE_PANEL_WIDTH_MIN,
        WORKSPACE_PANEL_WIDTH_MAX,
      )
      const nextWorkspaceLayout = resolveWorkspacePanelLayout({
        viewportWidth: nextViewportWidth,
        sidebarWidth: nextSidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
        preferredWidth: nextWorkspacePreferenceWidth,
      })

      // Native window resizing can emit one event per display frame. Updating
      // the shell variables directly keeps the layout continuous without
      // re-rendering the whole application on every frame. React commits the
      // same values once the resize burst settles.
      shell.style.setProperty('--sidebar-width', `${nextSidebarWidth}px`)
      shell.style.setProperty('--workspace-panel-width', `${nextWorkspaceLayout.width}px`)
    }
    const commitResize = () => {
      viewportResizeFrameRef.current = undefined
      const nextViewportWidth = window.innerWidth
      applyViewportLayoutVariables(nextViewportWidth)
    }
    const handleResize = () => {
      beginWindowResize()
      scheduleWindowResizeEnd()
      if (viewportResizeFrameRef.current !== undefined) return
      viewportResizeFrameRef.current = window.requestAnimationFrame(commitResize)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.cancelAnimationFrame(viewportResizeFrameRef.current ?? 0)
      viewportResizeFrameRef.current = undefined
      window.clearTimeout(viewportResizeEndTimerRef.current)
      viewportResizeEndTimerRef.current = undefined
      document.body.classList.remove('is-window-resizing')
      window.cancelAnimationFrame(composerSyncFrameRef.current ?? 0)
    }
  }, [])

  function scheduleComposerHeightSync() {
    if (
      document.body.classList.contains('is-resizing-column')
      || document.body.classList.contains('is-window-resizing')
    ) return
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
    beginWorkspacePanelResizeInteraction(event, { workspacePanelCollapsed, workspacePanelFullscreen, activeDragCleanupRef, workspacePanelSettleTimerRef, setControlTip, workspacePanelLayout, shellRef, setWorkspacePanelCollapsed, setWorkspacePanelFullscreen, setWorkspacePanelWidth, scheduleComposerHeightSync })
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

  /**
   * Opens the review on a specific file. The review request is transient on purpose: it is a
   * navigation intent from one click, not layout state worth restoring on the next launch.
   */
  function openReviewInWorkspace(path: string) {
    if (!path) return
    setControlTip(null)
    openWorkspacePanelTab('review')
    setWorkspaceReviewRequest({ id: Date.now(), path })
  }

  function openWorkspacePanelTab(tab: WorkspacePanelTabId) {
    setControlTip(null)
    if (tab === 'browser') {
      browserController.openWorkspaceBrowserTab('')
      return
    }
    if (!workspacePanelOpenTabs.includes(tab) && workspacePanelOpenTabs.length >= WORKSPACE_PANEL_OPEN_TABS_MAX) {
      setRuntimeError(`拓展工作区最多打开 ${WORKSPACE_PANEL_OPEN_TABS_MAX} 个标签`)
      return
    }
    if (isWorkspaceBrowserTabId(tab)) browserController.ensureWorkspaceBrowserTab(tab)
    setWorkspacePanelOpenTabs((tabs) => (tabs.includes(tab) ? tabs : [...tabs, tab]))
    setWorkspacePanelTab(tab)
    setWorkspacePanelCollapsed(false)
  }

  function updateWorkspaceFileDraft(tab: WorkspaceFileTabId, draft: WorkspaceFileDraftState | null) {
    const closingState = findClosingWorkspaceFileState(activeWorkspaceSessionKey, tab)
    const nextDraft = draft && closingState?.hasSavedVersion
      ? {
          ...draft,
          modifiedAt: closingState.modifiedAt,
          savedText: closingState.savedText,
        }
      : draft
    setWorkspaceFileDrafts((drafts) => {
      const next = { ...drafts }
      if (nextDraft) {
        next[tab] = nextDraft
      } else {
        delete next[tab]
      }
      return next
    })
  }

  function recordSavedWorkspaceFileDraft(
    layoutKey: string,
    tab: WorkspaceFileTabId,
    savedText: string,
    preview: WorkspacePreview,
    closingState: {
      hasSavedVersion: boolean
      savedText: string
      modifiedAt?: number
    },
  ): WorkspaceFileDraftState | undefined {
    closingState.hasSavedVersion = true
    closingState.savedText = savedText
    closingState.modifiedAt = preview.modifiedAt

    let recordedDraft: WorkspaceFileDraftState | undefined
    setWorkspaceSessionFileDrafts(layoutKey, (drafts) => {
      const currentDraft = drafts[tab]
      if (!currentDraft) return drafts
      recordedDraft = {
        ...currentDraft,
        modifiedAt: preview.modifiedAt,
        savedText,
      }
      return { ...drafts, [tab]: recordedDraft }
    })
    return recordedDraft
  }

  function finalizeWorkspacePanelTabClose(layoutKey: string, tab: WorkspacePanelTabId) {
    const layout = workspaceSessionLayoutsRef.current[layoutKey]
    if (!layout) return
    const currentTabs = layout.openTabs
    const tabIndex = currentTabs.indexOf(tab)
    const nextTabs = currentTabs.filter((item) => item !== tab)
    const browserTabs = isWorkspaceBrowserTabId(tab)
      ? layout.browserTabs.filter((item) => item.id !== tab)
      : layout.browserTabs
    let drafts = layout.drafts
    if (parseWorkspaceFileTabId(tab)) {
      if (drafts[tab]) {
        const next = { ...drafts }
        delete next[tab]
        drafts = next
      }
    }
    if (tabIndex < 0) {
      if (browserTabs !== layout.browserTabs || drafts !== layout.drafts) {
        commitWorkspaceSessionLayout(layoutKey, { ...layout, browserTabs, drafts })
      }
      return
    }
    let activeTab = layout.activeTab
    let collapsed = layout.collapsed
    if (nextTabs.length === 0) {
      activeTab = DEFAULT_WORKSPACE_PANEL_TABS[0] ?? 'review'
      collapsed = false
    } else if (activeTab === tab) {
      activeTab = nextTabs[Math.max(0, tabIndex - 1)] ?? nextTabs[0] ?? 'review'
    }
    commitWorkspaceSessionLayout(layoutKey, {
      ...layout,
      activeTab,
      openTabs: nextTabs,
      collapsed,
      drafts,
      browserTabs,
    })
  }

  async function closeWorkspacePanelTab(tab: WorkspacePanelTabId) {
    setControlTip(null)
    const layoutKey = activeWorkspaceSessionKey
    const fileTab = parseWorkspaceFileTabId(tab)
    const draft = fileTab ? workspaceSessionLayoutsRef.current[layoutKey]?.drafts[tab] : undefined
    if (!fileTab || !draft || draft.editorText === draft.savedText) {
      finalizeWorkspacePanelTabClose(layoutKey, tab)
      return
    }
    const fileTabId = tab as WorkspaceFileTabId
    const operationKey = `${layoutKey}\0${fileTabId}`
    if (closingWorkspaceFileTabsRef.current.has(operationKey)) return

    const closingState = {
      layoutKey,
      sessionId: currentSession,
      fileTabId,
      hasSavedVersion: false,
      savedText: '',
    }
    closingWorkspaceFileTabsRef.current.set(operationKey, closingState)
    try {
      await saveWorkspaceFileBeforeClose({
        getDraft: () => workspaceSessionLayoutsRef.current[closingState.layoutKey]?.drafts[fileTabId],
        requestSaveApproval: () => onRequestFileSaveApproval({
          path: fileTab.path,
          root: fileTab.root,
          relativePath: workspaceBreadcrumbs(fileTab.root, fileTab.path).join('/'),
        }),
        saveDraft: async (content, expectedModifiedAt) => {
          const preview = await saveWorkspaceFile(
            fileTab.root,
            fileTab.path,
            content,
            expectedModifiedAt,
            closingState.sessionId,
          )
          workspaceFilePreviewCache.store(fileTab.root, fileTab.path, preview)
          onWorkspaceArtifactsChanged()
          if (activeWorkspaceSessionKeyRef.current === closingState.layoutKey) {
            onWorkspaceFileSaved(fileTab.root, fileTab.path, preview)
          }
          return preview
        },
        recordSavedDraft: (savedText, preview) => (
          recordSavedWorkspaceFileDraft(closingState.layoutKey, fileTabId, savedText, preview, closingState)
        ),
        closeTab: () => finalizeWorkspacePanelTabClose(closingState.layoutKey, tab),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (activeWorkspaceSessionKeyRef.current === closingState.layoutKey) {
        setRuntimeError(`自动保存失败，文件仍保持打开：${message}`)
      }
    } finally {
      closingWorkspaceFileTabsRef.current.delete(operationKey)
    }
  }

  function findClosingWorkspaceFileState(layoutKey: string, tab: WorkspaceFileTabId) {
    for (const state of closingWorkspaceFileTabsRef.current.values()) {
      if (state.layoutKey === layoutKey && state.fileTabId === tab) return state
    }
    return undefined
  }

  const workspacePanelUsingTemporaryRoot = !isSamePath(workspacePanelRoot, defaultWorkspacePath)
  useEffect(() => () => {
    window.cancelAnimationFrame(composerSyncFrameRef.current ?? 0)
    window.cancelAnimationFrame(sidebarSettleFrameRef.current ?? 0)
    window.clearTimeout(sidebarSettleTimerRef.current)
    window.clearTimeout(workspacePanelSettleTimerRef.current)
    workspacePanelSettleTimerRef.current = undefined
    activeDragCleanupRef.current?.()
  }, [])

  return {
    sidebarCollapsed, setSidebarCollapsed,
    workspacePanelCollapsed, setWorkspacePanelCollapsed,
    workspacePanelReopenActive, setWorkspacePanelReopenActive,
    workspacePanelFullscreen, setWorkspacePanelFullscreen,
    workspacePanelTab, setWorkspacePanelTab,
    workspacePanelOpenTabs, setWorkspacePanelOpenTabs,
    ...browserController,
    workspaceOpenRequest, setWorkspaceOpenRequest,
    workspaceReviewRequest, openReviewInWorkspace,
    workspaceFileDrafts, setWorkspaceFileDrafts,
    workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed,
    workspaceFileNavigatorWidth, setWorkspaceFileNavigatorWidth, workspaceReviewNavigatorWidth, setWorkspaceReviewNavigatorWidth,
    workspaceExpandedPaths, setWorkspaceExpandedPaths,
    inputRef, shellRef,
    sidebarWidth, setSidebarWidth,
    workspacePanelWidth, setWorkspacePanelWidth,
    workspacePanelLayout, layoutStyle,
    beginSidebarResize, nudgeSidebar, toggleSidebar,
    beginWorkspacePanelResize, toggleWorkspacePanel, updateWorkspacePanelReopenPresence,
    toggleWorkspacePanelFullscreen, nudgeWorkspacePanel,
    openWorkspacePanelTab, updateWorkspaceFileDraft, closeWorkspacePanelTab,
    resetWorkspaceSessionLayout, removeWorkspaceSessionLayout,
    alignWorkspaceSessionToRoot, rebindWorkspaceSessionLayouts,
    defaultWorkspacePath, workspacePanelRoot, workspacePanelUsingTemporaryRoot,
  }
}

function resolveStateAction<T>(update: SetStateAction<T>, current: T): T {
  return typeof update === 'function'
    ? (update as (value: T) => T)(current)
    : update
}

export type WorkspaceLayoutController = ReturnType<typeof useWorkspaceLayoutController>
