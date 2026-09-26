// Top-level renderer orchestration. Domain hooks are extracted from this compatibility controller incrementally.
import '@xterm/xterm/css/xterm.css'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  listProjects,
  listSessions,
  selectWorkspace,
  type AttachmentRef,
  type PermissionModeId,
  type ProjectMeta,
  type RuntimeState,
  type SessionMeta,
  type WorkspacePreview
} from '../api'
import { updateSessionPermissionMode } from '../api/sessions'
import { useApprovalController } from '../approval/use-approval-controller'
import { createRunActions, type RunActionContext } from '../chat/run-actions'
import { ChatMessage } from '../chat/types'
import { buildContextUsage, type ContextUsageSnapshot } from '../context-usage'
import { createProjectActions } from '../sidebar/project-actions'
import { createSessionActions, type CachedSessionHistory, type SessionHistoryWindow } from '../sidebar/session-actions'
import { useRuntimeTaskEvents } from '../runtime-events/use-runtime-task-events'
import { latestRunActivity, useTitlebarTask } from './titlebar-task'
import { useCheckpointRecovery } from '../runtime-recovery/use-checkpoint-recovery'
import { FloatingHelpTip } from '../ui/floating-help'
import { useFrameCoalescedState } from '../ui/use-frame-coalesced-state'
import { WORKSPACE_PANEL_OPEN_TABS_MAX, workspaceFileTabId, workspaceSessionKey } from '../workspace-persistence'
import { isSamePath, resolveWorkspacePreviewRoot, workspaceTitle } from '../workspace/path-utils'
import type { LineCommentAttachmentRemoval } from '../workspace/line-comment-attachments'
import { useWorkspaceLayoutController } from '../workspace/use-workspace-layout-controller'
import { createLinkNavigationActions } from './link-navigation-actions'
import {
  mergeOrderedList,
  sortSessionsForSidebar,
  standaloneSessionsForSidebar,
} from './list-motion'
import {
  ACTIVE_SESSION_KEY,
  PINNED_SESSIONS_KEY,
  SIDEBAR_SESSION_ORDER_KEY,
  readStringListPreference,
  readStringPreference,
  readStringSetPreference,
  removePreference,
  writeStringListPreference,
} from './preferences'
import {
  readPersistedAppShellState,
  restoreComposerDraft,
} from './persistent-state'
import { SidebarPanel } from './types'
import { resolveSessionPermissionMode } from './session-permission-mode'
import { useAppPersistence } from './use-app-persistence'
import { useNavigationController } from './use-navigation-controller'
import { isMissingWorkspacePathError } from '../workspace/workspace-errors'
import { createAttachmentActions } from './attachment-actions'
import { createRuntimeActions, type PendingModelPatch } from './runtime-actions'
import { APPLICATION_PERSISTENCE_FLUSH_EVENT } from '../../shared/application-state-contracts'
import { normalizePermissionModeId } from '../../shared/permission-modes'

type PendingSessionPermissionMode = {
  sequence: number
  mode: PermissionModeId
  baseline: PermissionModeId
}

export function useAppController() {
  const initialPersistentState = useMemo(readPersistedAppShellState, [])
  const initialActiveSessionId = useMemo(() => readStringPreference(ACTIVE_SESSION_KEY) || null, [])
  const initialComposerDraft = restoreComposerDraft(initialPersistentState, initialActiveSessionId)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [currentSession, setCurrentSession] = useState<string | undefined>()
  const [sessionOwnership, setSessionOwnership] = useState<Pick<SessionMeta, 'scope' | 'projectId'>>({ scope: 'standalone' })
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [historyWindow, setHistoryWindow] = useState<SessionHistoryWindow>({ hasMore: false, loading: false })
  const [input, setInputState] = useState(initialComposerDraft)
  const [loading, setLoading] = useState(false)
  const [draftPermissionMode, setDraftPermissionMode] = useState<PermissionModeId>('research')
  const [sessionPermissionModeOverrides, setSessionPermissionModeOverrides] = useState<Record<string, PermissionModeId>>({})
  const [runtime, setRuntime] = useState<RuntimeState | null>(null)
  const [attachments, setAttachments] = useState<AttachmentRef[]>([])
  const [attachmentRemoval, setAttachmentRemoval] = useState<LineCommentAttachmentRemoval | null>(null)
  const attachmentRemovalIdRef = useRef(0)
  const [dragActive, setDragActive] = useState(false)
  const [runtimeError, setRuntimeErrorState] = useState<string | null>(null)
  const setRuntimeError = useCallback<Dispatch<SetStateAction<string | null>>>((update) => {
    setRuntimeErrorState((current) => {
      const next = typeof update === 'function' ? update(current) : update
      return isMissingWorkspacePathError(next) ? null : next
    })
  }, [])
  const [conversationCollapsed, setConversationCollapsed] = useState(initialPersistentState.conversationCollapsed)
  const [now, setNow] = useState(() => Date.now())
  const [pinnedSessionIds, setPinnedSessionIds] = useState(() => readStringSetPreference(PINNED_SESSIONS_KEY))
  const [sidebarSessionOrder, setSidebarSessionOrder] = useState(() => (
    readStringListPreference(SIDEBAR_SESSION_ORDER_KEY)
  ))
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>(initialPersistentState.sidebarPanel)
  const [sidebarSearch, setSidebarSearch] = useState(initialPersistentState.sidebarSearch)
  const [projectCreatorOpen, setProjectCreatorOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const stopRequestedRunIdRef = useRef<string | null>(null)
  const pendingConversationTurnRef = useRef<RunActionContext['pendingConversationTurnRef']['current']>(null)
  const wasSettingsOpenRef = useRef(false)
  const appMountedRef = useRef(true)
  const sessionLoadRequestRef = useRef(0)
  const historyLoadRequestRef = useRef(0)
  const sessionHistoryCacheRef = useRef(new Map<string, CachedSessionHistory>())
  const selectedSessionWorkspaceRef = useRef<string | undefined>(undefined)
  const defaultWorkspaceRef = useRef<string | undefined>(undefined)
  const currentSessionRef = useRef(currentSession)
  const sessionsRef = useRef<SessionMeta[]>(sessions)
  const restoredLastSessionRef = useRef(false)
  const inputValueRef = useRef(initialComposerDraft)
  const [activityNow, setActivityNow] = useState(() => Date.now())
  const liveToolStepRef = useRef(new Map<string, string>())
  const [contextUsageSnapshot, setContextUsageSnapshot] = useState<ContextUsageSnapshot | null>(null)
  const [workspaceArtifactVersion, setWorkspaceArtifactVersion] = useState(0)
  const [controlTip, setControlTip] = useFrameCoalescedState<FloatingHelpTip | null>(null)
  const modelPatchSequenceRef = useRef(0)
  const pendingModelPatchRef = useRef<PendingModelPatch | null>(null)
  const permissionModeWriteSequenceRef = useRef(0)
  const pendingPermissionModeRef = useRef(new Map<string, PendingSessionPermissionMode>())
  const permissionModeWriteQueueRef = useRef(new Map<string, Promise<void>>())
  const knownSessionPermissionModesRef = useRef(new Map<string, PermissionModeId>())
  currentSessionRef.current = currentSession
  sessionsRef.current = sessions
  const attachmentActions = createAttachmentActions({
    appMountedRef, attachments, setAttachments, setRuntimeError, setDragActive,
    attachmentRemovalIdRef, setAttachmentRemoval,
  })
  const {
    addAttachments, removeAttachment, removeLineCommentAttachment,
    updatePublishedLineCommentAttachment, handleComposerDragEnter, handleComposerDragOver,
    handleComposerDragLeave, handleComposerDrop, handleComposerPaste,
  } = attachmentActions
  const permissionMode = useMemo(
    () => resolveSessionPermissionMode(currentSession, sessions, sessionPermissionModeOverrides, draftPermissionMode),
    [currentSession, draftPermissionMode, sessionPermissionModeOverrides, sessions],
  )
  const setPermissionMode = useCallback((next: PermissionModeId) => {
    const sessionId = currentSession
    if (!sessionId) {
      setDraftPermissionMode(next)
      return
    }

    const pending = pendingPermissionModeRef.current.get(sessionId)
    const baseline = pending?.baseline ?? normalizePermissionModeId(
      sessionsRef.current.find((session) => session.id === sessionId)?.mode,
    )
    const sequence = ++permissionModeWriteSequenceRef.current
    pendingPermissionModeRef.current.set(sessionId, { sequence, mode: next, baseline })
    knownSessionPermissionModesRef.current.set(sessionId, next)
    setSessionPermissionModeOverrides((current) => ({ ...current, [sessionId]: next }))
    setSessions((current) => current.map((session) => (
      session.id === sessionId ? { ...session, mode: next } : session
    )))
    const previousWrite = permissionModeWriteQueueRef.current.get(sessionId) ?? Promise.resolve()
    let write: Promise<void>
    write = previousWrite.catch(() => undefined).then(async () => {
      try {
        const { session } = await updateSessionPermissionMode(sessionId, next)
        if (!appMountedRef.current) return
        const latest = pendingPermissionModeRef.current.get(sessionId)
        knownSessionPermissionModesRef.current.set(sessionId, normalizePermissionModeId(session.mode))
        if (!latest || latest.sequence !== sequence) return
        pendingPermissionModeRef.current.delete(sessionId)
        setSessionPermissionModeOverrides((current) => {
          if (!(sessionId in current)) return current
          const nextOverrides = { ...current }
          delete nextOverrides[sessionId]
          return nextOverrides
        })
        setSessions((current) => current.map((item) => item.id === sessionId ? session : item))
        if (currentSessionRef.current === sessionId) setRuntimeError(null)
      } catch (error) {
        if (!appMountedRef.current) return
        const latest = pendingPermissionModeRef.current.get(sessionId)
        if (!latest || latest.sequence !== sequence) return
        let refreshed: SessionMeta[] | undefined
        try {
          refreshed = (await listSessions()).sessions
        } catch {
          refreshed = undefined
        }
        if (!appMountedRef.current) return
        const currentLatest = pendingPermissionModeRef.current.get(sessionId)
        if (!currentLatest || currentLatest.sequence !== sequence) return
        pendingPermissionModeRef.current.delete(sessionId)
        setSessionPermissionModeOverrides((current) => {
          if (!(sessionId in current)) return current
          const nextOverrides = { ...current }
          delete nextOverrides[sessionId]
          return nextOverrides
        })
        if (refreshed) {
          const persisted = refreshed.find((item) => item.id === sessionId)
          if (persisted) knownSessionPermissionModesRef.current.set(sessionId, normalizePermissionModeId(persisted.mode))
          setSessions(refreshed)
        } else {
          // The known map contains the optimistic value while this write is pending;
          // after a failed persistence and failed refresh, only the write baseline is confirmed.
          const fallback = currentLatest.baseline
          knownSessionPermissionModesRef.current.set(sessionId, fallback)
          setSessions((current) => current.map((item) => item.id === sessionId
            ? { ...item, mode: fallback }
            : item))
        }
        if (currentSessionRef.current === sessionId) {
          setRuntimeError(`保存权限模式失败：${(error as Error).message}`)
        }
      } finally {
        if (permissionModeWriteQueueRef.current.get(sessionId) === write) {
          permissionModeWriteQueueRef.current.delete(sessionId)
        }
      }
    })
    permissionModeWriteQueueRef.current.set(sessionId, write)
  }, [currentSession])
  const resetDraftPermissionMode = useCallback(() => setDraftPermissionMode('research'), [])
  const forgetSessionPermissionMode = useCallback((sessionId: string) => {
    pendingPermissionModeRef.current.delete(sessionId)
    knownSessionPermissionModesRef.current.delete(sessionId)
    setSessionPermissionModeOverrides((current) => {
      if (!(sessionId in current)) return current
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }, [])
  const setInput = useCallback<Dispatch<SetStateAction<string>>>((update) => {
    const current = inputValueRef.current
    const next = typeof update === 'function' ? update(current) : update
    inputValueRef.current = next
    setInputState(next)
  }, [])
  const { runtimeEventNotice, pendingRuntimeMessageRef, publishRuntimeEventNotice,
    notifyRuntimeSettingChanges, notifyRuntimeWorkspaceFileSaved: publishRuntimeWorkspaceFileSaved } = useRuntimeTaskEvents({ activeRunIdRef, appMountedRef, loading })
  function notifyRuntimeWorkspaceFileSaved(
    root: string,
    path: string,
    preview: WorkspacePreview,
    sourceSessionId = currentSession,
  ) {
    if (workspaceSessionKey(currentSessionRef.current) !== workspaceSessionKey(sourceSessionId)) return
    publishRuntimeWorkspaceFileSaved(root, path, preview)
  }
  const {
    pendingApproval,
    approvalGrantsRef,
    activeApprovalScopeKey,
    beginDraftApprovalScope,
    requestApprovalForScope,
    requestWorkspaceSaveApproval,
    settleApprovalPrompt,
  } = useApprovalController({ currentSession, permissionMode })
  const getSessionPermissionMode = useCallback((sessionId: string): PermissionModeId => (
    knownSessionPermissionModesRef.current.get(sessionId)
      ?? resolveSessionPermissionMode(sessionId, sessions, sessionPermissionModeOverrides, permissionMode)
  ), [permissionMode, sessionPermissionModeOverrides, sessions])
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    workspacePanelCollapsed,
    setWorkspacePanelCollapsed,
    workspacePanelReopenActive,
    setWorkspacePanelReopenActive,
    workspacePanelFullscreen,
    setWorkspacePanelFullscreen,
    workspacePanelTab,
    setWorkspacePanelTab,
    workspacePanelOpenTabs,
    setWorkspacePanelOpenTabs,
    workspaceBrowserTabs, workspaceBrowserUrl, workspaceBrowserHistory,
    navigateWorkspaceBrowser, openWorkspaceBrowser, openWorkspaceBrowserTab, updateWorkspaceBrowserTitle, moveWorkspaceBrowser,
    workspaceOpenRequest,
    setWorkspaceOpenRequest,
    workspaceReviewRequest,
    openReviewInWorkspace,
    workspaceFileDrafts,
    workspaceFileNavigatorCollapsed,
    setWorkspaceFileNavigatorCollapsed,
    workspaceFileNavigatorWidth, setWorkspaceFileNavigatorWidth,
    workspaceReviewNavigatorWidth, setWorkspaceReviewNavigatorWidth,
    workspaceExpandedPaths,
    setWorkspaceExpandedPaths,
    inputRef,
    shellRef,
    sidebarWidth,
    setSidebarWidth,
    workspacePanelWidth,
    setWorkspacePanelWidth,
    workspacePanelLayout,
    layoutStyle,
    beginSidebarResize,
    nudgeSidebar,
    toggleSidebar,
    beginWorkspacePanelResize,
    toggleWorkspacePanel,
    updateWorkspacePanelReopenPresence,
    toggleWorkspacePanelFullscreen,
    nudgeWorkspacePanel,
    openWorkspacePanelTab,
    updateWorkspaceFileDraft,
    closeWorkspacePanelTab,
    resetWorkspaceSessionLayout,
    removeWorkspaceSessionLayout,
    alignWorkspaceSessionToRoot,
    rebindWorkspaceSessionLayouts,
    defaultWorkspacePath,
    workspacePanelRoot,
    workspacePanelUsingTemporaryRoot,
  } = useWorkspaceLayoutController({
    runtime,
    currentSession,
    input,
    setControlTip,
    setRuntimeError,
    onRequestFileSaveApproval: requestWorkspaceSaveApproval,
    onWorkspaceArtifactsChanged: () => setWorkspaceArtifactVersion((value) => value + 1),
    onWorkspaceFileSaved: notifyRuntimeWorkspaceFileSaved,
  })
  const {
    activeRoute,
    appHistoryRef,
    navigationRestoreTargetRef,
    setAppHistory,
    settingsEntryRippling,
    settingsOpen,
    settingsReturning,
    directModulePage,
    settingsPage,
    canNavigateBack,
    canNavigateForward,
    pushRoute,
    openSettingsFromEntry,
    openSettingsPage,
    openDirectModulePage,
    navigateBack,
    navigateForward,
    closeSettingsFromEntry,
    finishSettingsReturn,
  } = useNavigationController({
    initialRoute: initialPersistentState.route,
    setControlTip, workspaceScopeKey: workspaceSessionKey(currentSession),
    sidebarCollapsed, setSidebarCollapsed, sidebarWidth, setSidebarWidth,
    conversationCollapsed, setConversationCollapsed, sidebarPanel, setSidebarPanel,
    workspacePanelCollapsed, setWorkspacePanelCollapsed, workspacePanelFullscreen,
    setWorkspacePanelFullscreen, workspacePanelWidth, setWorkspacePanelWidth, workspacePanelTab,
    setWorkspacePanelTab, workspacePanelOpenTabs, setWorkspacePanelOpenTabs, workspaceOpenRequest,
    setWorkspaceOpenRequest, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed,
    workspaceExpandedPaths, setWorkspaceExpandedPaths,
  })
  const activeSessionPersistenceReadyRef = useAppPersistence({
    initialState: initialPersistentState, initialActiveSessionId, currentSession,
    currentSessionRef, inputValueRef, input, activeRoute, conversationCollapsed,
    sidebarPanel, sidebarSearch, pinnedSessionIds,
  })
  useEffect(() => {
    void refreshSessions()
    void refreshProjects()
    void refreshRuntime()
  }, [])

  useEffect(() => {
    if (restoredLastSessionRef.current || !sessionsLoaded) return
    if (currentSession) {
      restoredLastSessionRef.current = true
      activeSessionPersistenceReadyRef.current = true
      return
    }

    const activeSessionId = readStringPreference(ACTIVE_SESSION_KEY)
    if (!activeSessionId) {
      restoredLastSessionRef.current = true
      activeSessionPersistenceReadyRef.current = true
      return
    }

    const session = sessions.find((item) => item.id === activeSessionId)
    restoredLastSessionRef.current = true
    if (!session) {
      removePreference(ACTIVE_SESSION_KEY)
      activeSessionPersistenceReadyRef.current = true
      return
    }
    void switchSession(session, { preserveRoute: true }) // Startup recovery keeps the persisted route.
  }, [currentSession, sessions, sessionsLoaded])

  useEffect(() => {
    if (wasSettingsOpenRef.current && !settingsOpen) void refreshRuntime()
    wasSettingsOpenRef.current = settingsOpen
  }, [settingsOpen])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    appMountedRef.current = true
    return () => {
      appMountedRef.current = false
      sessionLoadRequestRef.current += 1
      historyLoadRequestRef.current = 0
      abortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!loading) return
    const timer = window.setInterval(() => setActivityNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [loading])

  const runtimeActions = createRuntimeActions({
    appMountedRef, runtime, setRuntime, setRuntimeError, alignWorkspacePanelToWorkspaceRoot,
    notifyRuntimeSettingChanges, refreshProjects, modelPatchSequenceRef, pendingModelPatchRef,
    selectedSessionWorkspaceRef, defaultWorkspaceRef,
  })
  const { refreshRuntime, applyRuntimePatch, applyRuntimePatchReporting, applyModelPatch } = runtimeActions
  const selectableProviders = useMemo(() => runtimeActions.selectableProviders(), [runtime])

  const selectedModel = useMemo(() => {
    return runtimeActions.selectedModel(selectableProviders)
  }, [runtime, selectableProviders])
  const displayedSessions = useMemo(
    () => sortSessionsForSidebar(sessions, pinnedSessionIds, sidebarSessionOrder),
    [pinnedSessionIds, sessions, sidebarSessionOrder],
  )
  const visibleSessions = useMemo(() => standaloneSessionsForSidebar(displayedSessions), [displayedSessions])

  function reorderSidebarSessions(reorderedSessionIds: string[]) {
    const knownIds = new Set(sessions.map((session) => session.id))
    const reordered = reorderedSessionIds.filter((id) => knownIds.has(id))
    if (reordered.length === 0) return
    setSidebarSessionOrder((current) => mergeOrderedList(
      reordered,
      current.filter((id) => knownIds.has(id)),
    ))
  }

  useEffect(() => {
    writeStringListPreference(SIDEBAR_SESSION_ORDER_KEY, sidebarSessionOrder)
  }, [sidebarSessionOrder])

  useEffect(() => {
    const flushSidebarSessionOrder = () => {
      writeStringListPreference(SIDEBAR_SESSION_ORDER_KEY, sidebarSessionOrder)
    }
    window.addEventListener(APPLICATION_PERSISTENCE_FLUSH_EVENT, flushSidebarSessionOrder)
    return () => window.removeEventListener(APPLICATION_PERSISTENCE_FLUSH_EVENT, flushSidebarSessionOrder)
  }, [sidebarSessionOrder])
  const workspaceIsWorkplace = runtime ? isSamePath(runtime.workspace, runtime.workplace) : false
  const workspaceTip = runtime ? workspaceTitle(runtime.workspace, runtime.workplace) : ''
  const projectPath = runtime?.workplace ?? runtime?.workspace ?? ''
  const contextUsage = useMemo(
    () => buildContextUsage(runtime?.model, contextUsageSnapshot),
    [contextUsageSnapshot, runtime?.model],
  )
  const latestTaskActivity = latestRunActivity(messages)
  const titlebarTask = useTitlebarTask({ sessions, currentSession, messages, activityNow })
  const sidebarToggleTip = sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'
  const moreConversationTip = '对话菜单'
  const newConversationTip = '新建对话'
  const uploadTip = '添加文件或设置工作区'
  const sendTip = loading ? '补充当前任务' : '发送'
  const stopTip = '停止当前任务'
  async function refreshSessions(): Promise<SessionMeta[]> {
    try {
      const { sessions } = await listSessions()
      if (!appMountedRef.current) return []
      const merged = sessions.map((session) => {
        const pending = pendingPermissionModeRef.current.get(session.id)
        const known = knownSessionPermissionModesRef.current.get(session.id)
        const mode = pending?.mode ?? known
        return mode ? { ...session, mode } : session
      })
      setSessions(merged)
      return merged
    } catch (e) {
      console.error('Failed to list sessions:', e)
      return []
    } finally {
      if (appMountedRef.current) setSessionsLoaded(true)
    }
  }
  async function refreshProjects() {
    try {
      const { projects } = await listProjects()
      if (!appMountedRef.current) return
      setProjects(projects)
    } catch (e) {
      console.error('Failed to list projects:', e)
    }
  }

  async function chooseWorkspace() {
    await runtimeActions.chooseWorkspacePath({
      selectDirectory: selectWorkspace,
      sessionId: currentSessionRef.current,
      sessionScope: sessionOwnership.scope,
    })
  }

  function openFileInWorkspace(path: string) {
    const root = resolveWorkspacePreviewRoot(path, runtime, projectPath)
    setControlTip(null)
    openWorkspaceFileTab(root, path)
  }

  const { openHyperlinkInside, openHyperlinkWithSystem } = createLinkNavigationActions({
    runtime, projectPath, settingsOpen, pushRoute, setControlTip, setRuntimeError, openFileInWorkspace, navigateWorkspaceBrowser, openWorkspaceBrowser, openWorkspacePanelTab, appMountedRef,
  })

  function openWorkspaceFileTab(root: string, path: string) {
    const tab = workspaceFileTabId(root, path)
    if (!workspacePanelOpenTabs.includes(tab) && workspacePanelOpenTabs.length >= WORKSPACE_PANEL_OPEN_TABS_MAX) {
      setRuntimeError(`拓展工作区最多打开 ${WORKSPACE_PANEL_OPEN_TABS_MAX} 个标签`)
      return
    }
    setWorkspacePanelCollapsed(false)
    if (settingsOpen) pushRoute({ section: 'chat' })
    setWorkspacePanelOpenTabs((tabs) => (tabs.includes(tab) ? tabs : [...tabs, tab]))
    setWorkspacePanelTab(tab)
    setWorkspaceOpenRequest({
      id: Date.now(),
      root,
      path,
    })
  }

  const { send, stop } = createRunActions({
    abortRef, activeRunIdRef, activeApprovalScopeKey, appMountedRef, approvalGrantsRef, attachments, conversationViewRequestRef: sessionLoadRequestRef, currentSession, input, liveToolStepRef, loading, permissionMode,
    pendingConversationTurnRef, pendingRuntimeMessageRef, publishRuntimeEventNotice, refreshProjects, refreshSessions, requestApprovalForScope, runtime, sessionOwnership, setActivityNow, setAttachments,
    setContextUsageSnapshot, setCurrentSession, setInput, setLoading, setMessages, setWorkspaceArtifactVersion, settleApprovalPrompt, stopRequestedRunIdRef,
  })
  const {
    createConversationFromSidebar,
    createProjectConversationFromSidebar,
    openSidebarPanel,
    closeSidebarPanel,
    switchSession,
    loadOlderMessages,
    archiveSession,
    deleteSessionPermanently,
    renameSession,
    sessionsForProject,
    archiveAllSessions,
    togglePinnedSession,
  } = createSessionActions({
    abortRef,
    alignWorkspacePanelToWorkspaceRoot,
    appMountedRef,
    approvalGrantsRef,
    beginDraftApprovalScope,
    currentSession,
    historyLoadRequestRef,
    sessionHistoryCacheRef, selectedSessionWorkspaceRef, defaultWorkspaceRef,
    historyWindow,
    pushRoute,
    refreshSessions,
    removeWorkspaceSessionLayout,
    resetWorkspaceSessionLayout,
    runtime,
    sessionLoadRequestRef,
    sessions,
    setContextUsageSnapshot,
    setConversationCollapsed,
    setControlTip,
    setCurrentSession,
    setHistoryWindow,
    setMessages,
    setPinnedSessionIds,
    setRuntime,
    setRuntimeError,
    setSessionOwnership,
    setSessions,
    setSidebarPanel,
    resetDraftPermissionMode,
    forgetSessionPermissionMode,
    settleApprovalPrompt,
    visibleSessions,
  })
  const checkpointRecovery = useCheckpointRecovery({ abortRef, activeRunIdRef, appMountedRef, getSessionPermissionMode, loading, runtime, stopRequestedRunIdRef, refreshProjects, refreshSessions, requestApprovalForScope, settleApprovalPrompt, switchSession, setActivityNow, setContextUsageSnapshot, setLoading, setWorkspaceArtifactVersion })
  const {
    openProjectCreator,
    activateProjectWorkspace,
    chooseProjectFolder,
    createProjectInFolder,
    relocateProject,
    resetWorkspace,
    archiveProject,
    deleteProjectPermanently,
  } = createProjectActions({
    abortRef,
    alignWorkspacePanelToWorkspaceRoot,
    appHistoryRef,
    appMountedRef,
    applyRuntimePatch,
    beginDraftApprovalScope,
    currentSession,
    historyLoadRequestRef,
    navigationRestoreTargetRef,
    pushRoute,
    rebindWorkspaceSessionLayouts,
    refreshProjects,
    refreshSessions,
    removeWorkspaceSessionLayout,
    resetWorkspaceSessionLayout,
    sessionLoadRequestRef,
    sessionOwnership,
    sessionsForProject,
    setAppHistory,
    setContextUsageSnapshot,
    setControlTip,
    setConversationCollapsed,
    setCurrentSession,
    setMessages,
    setPinnedSessionIds,
    setProjectCreatorOpen,
    setProjects,
    setRuntime,
    setRuntimeError,
    setSessionOwnership,
    setSessions,
    setSidebarPanel,
    resetDraftPermissionMode,
    setWorkspaceOpenRequest,
  })
  function alignWorkspacePanelToWorkspaceRoot(
    root: string,
    sessionId: string | null | undefined = currentSession,
  ) {
    alignWorkspaceSessionToRoot(root, sessionId)
  }
  return {
    projects, currentSession, sessionOwnership, messages, historyWindow, loadOlderMessages, input, setInput, loading, permissionMode, setPermissionMode, runtime, attachments, setAttachments, removeAttachment, removeLineCommentAttachment, updatePublishedLineCommentAttachment, attachmentRemoval, dragActive, runtimeError, runtimeEventNotice, checkpointRecovery, sidebarCollapsed, workspacePanelCollapsed, workspacePanelReopenActive, setWorkspacePanelReopenActive, workspacePanelFullscreen,
    workspacePanelTab, workspacePanelOpenTabs, setWorkspacePanelOpenTabs, workspaceBrowserTabs, workspaceBrowserUrl, workspaceBrowserHistory, navigateWorkspaceBrowser, openWorkspaceBrowserTab, updateWorkspaceBrowserTitle, moveWorkspaceBrowser, workspaceOpenRequest, setWorkspaceOpenRequest, workspaceReviewRequest, openReviewInWorkspace, workspaceFileDrafts, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed,
    workspaceFileNavigatorWidth, setWorkspaceFileNavigatorWidth, workspaceReviewNavigatorWidth, setWorkspaceReviewNavigatorWidth, workspaceExpandedPaths, setWorkspaceExpandedPaths, conversationCollapsed, setConversationCollapsed, now, pinnedSessionIds, sidebarPanel, sidebarSearch, setSidebarSearch, projectCreatorOpen, setProjectCreatorOpen, scrollRef, inputRef, shellRef, activityNow, workspaceArtifactVersion, setWorkspaceArtifactVersion,
    controlTip, setControlTip, pendingApproval, settingsEntryRippling, sidebarWidth, setSidebarWidth, setWorkspacePanelWidth, workspacePanelLayout, layoutStyle, settingsOpen, settingsReturning, directModulePage, settingsPage, canNavigateBack, canNavigateForward, openSettingsFromEntry, openSettingsPage, openDirectModulePage, navigateBack, navigateForward, closeSettingsFromEntry, finishSettingsReturn, selectableProviders,
    selectedModel, displayedSessions, visibleSessions, reorderSidebarSessions, workspaceIsWorkplace, workspaceTip, projectPath, contextUsage, latestTaskActivity, titlebarTask, sidebarToggleTip, moreConversationTip, newConversationTip, uploadTip, sendTip, stopTip, requestWorkspaceSaveApproval, settleApprovalPrompt, refreshSessions, refreshProjects, applyRuntimePatch, applyRuntimePatchReporting, applyModelPatch, refreshRuntime, addAttachments, chooseWorkspace,
    openProjectCreator, activateProjectWorkspace, chooseProjectFolder, createProjectInFolder, relocateProject, resetWorkspace, openFileInWorkspace, openHyperlinkInside, openHyperlinkWithSystem, handleComposerDragEnter, handleComposerDragOver, handleComposerDragLeave, handleComposerDrop, handleComposerPaste, send, stop, notifyRuntimeWorkspaceFileSaved, createConversationFromSidebar, createProjectConversationFromSidebar,
    openSidebarPanel, closeSidebarPanel, switchSession, renameSession, archiveSession, deleteSessionPermanently, archiveProject, deleteProjectPermanently, archiveAllSessions, togglePinnedSession, beginSidebarResize, nudgeSidebar, toggleSidebar, beginWorkspacePanelResize, toggleWorkspacePanel, updateWorkspacePanelReopenPresence, toggleWorkspacePanelFullscreen, nudgeWorkspacePanel,
    openWorkspacePanelTab, updateWorkspaceFileDraft, closeWorkspacePanelTab, defaultWorkspacePath, workspacePanelRoot, workspacePanelUsingTemporaryRoot,
  }
}
export type AppController = ReturnType<typeof useAppController>
