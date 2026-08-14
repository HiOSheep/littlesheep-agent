// Top-level renderer orchestration. Domain hooks are extracted from this compatibility controller incrementally.
import '@xterm/xterm/css/xterm.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getPathForFile,
  getRuntime,
  importAttachment,
  listProjects,
  listSessions,
  selectAttachments,
  selectWorkspace,
  updateRuntime,
  type AttachmentRef,
  type PermissionModeId,
  type ProjectMeta,
  type RuntimePatch,
  type RuntimeState,
  type SessionMeta
} from '../api'
import { useApprovalController } from '../approval/use-approval-controller'
import { createRunActions, type RunActionContext } from '../chat/run-actions'
import { ChatMessage } from '../chat/types'
import { splitModelRef } from '../composer/runtime-picker'
import { buildContextUsage, type ContextUsageSnapshot } from '../context-usage'
import { createProjectActions } from '../sidebar/project-actions'
import { createSessionActions, type SessionHistoryWindow } from '../sidebar/session-actions'
import { useRuntimeTaskEvents } from '../runtime-events/use-runtime-task-events'
import { useCheckpointRecovery } from '../runtime-recovery/use-checkpoint-recovery'
import { FloatingHelpTip } from '../ui/floating-help'
import { useFrameCoalescedState } from '../ui/use-frame-coalesced-state'
import { DEFAULT_WORKSPACE_PANEL_TABS, WORKSPACE_PANEL_OPEN_TABS_MAX, alignWorkspacePanelStateToRoot, workspaceFileTabId } from '../workspace-persistence'
import { dataTransferHasFiles, inferAttachmentKind, isSamePath, lastPathSegment, resolveWorkspacePreviewRoot, workspaceTitle } from '../workspace/path-utils'
import { useWorkspaceLayoutController } from '../workspace/use-workspace-layout-controller'
import { createLinkNavigationActions } from './link-navigation-actions'
import { sortSessionsForSidebar, standaloneSessionsForSidebar, useListReorderAnimation } from './list-motion'
import { ACTIVE_SESSION_KEY, PINNED_SESSIONS_KEY, readStringPreference, readStringSetPreference, removePreference, writeStringPreference, writeStringSetPreference } from './preferences'
import { SidebarPanel } from './types'
import { useNavigationController } from './use-navigation-controller'
export function useAppController() {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [currentSession, setCurrentSession] = useState<string | undefined>()
  const [sessionOwnership, setSessionOwnership] = useState<Pick<SessionMeta, 'scope' | 'projectId'>>({ scope: 'standalone' })
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [historyWindow, setHistoryWindow] = useState<SessionHistoryWindow>({ hasMore: false, loading: false })
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [permissionMode, setPermissionMode] = useState<PermissionModeId>('research')
  const [runtime, setRuntime] = useState<RuntimeState | null>(null)
  const [attachments, setAttachments] = useState<AttachmentRef[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [conversationCollapsed, setConversationCollapsed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [pinnedSessionIds, setPinnedSessionIds] = useState(() => readStringSetPreference(PINNED_SESSIONS_KEY))
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>(null)
  const [sidebarSearch, setSidebarSearch] = useState('')
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
  const restoredLastSessionRef = useRef(false)
  const [activityNow, setActivityNow] = useState(() => Date.now())
  const liveToolStepRef = useRef(new Map<string, string>())
  const [contextUsageSnapshot, setContextUsageSnapshot] = useState<ContextUsageSnapshot | null>(null)
  const [workspaceArtifactVersion, setWorkspaceArtifactVersion] = useState(0)
  const [controlTip, setControlTip] = useFrameCoalescedState<FloatingHelpTip | null>(null)
  const { runtimeEventNotice, pendingRuntimeMessageRef, publishRuntimeEventNotice,
    notifyRuntimeSettingChanges, notifyRuntimeWorkspaceFileSaved } = useRuntimeTaskEvents({ activeRunIdRef, appMountedRef, loading })
  const {
    pendingApproval,
    approvalGrantsRef,
    activeApprovalScopeKey,
    beginDraftApprovalScope,
    requestApprovalForScope,
    requestWorkspaceSaveApproval,
    requestWorkspaceCommandApproval,
    settleApprovalPrompt,
  } = useApprovalController({ currentSession, permissionMode })
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
    workspaceFileDrafts,
    setWorkspaceFileDrafts,
    workspaceFileNavigatorCollapsed,
    setWorkspaceFileNavigatorCollapsed,
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
    appHistoryRef,
    navigationRestoreTargetRef,
    setAppHistory,
    settingsEntryRippling,
    settingsOpen,
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
  } = useNavigationController({
    setControlTip, sidebarCollapsed, setSidebarCollapsed, sidebarWidth, setSidebarWidth,
    conversationCollapsed, setConversationCollapsed, sidebarPanel, setSidebarPanel,
    workspacePanelCollapsed, setWorkspacePanelCollapsed, workspacePanelFullscreen,
    setWorkspacePanelFullscreen, workspacePanelWidth, setWorkspacePanelWidth, workspacePanelTab,
    setWorkspacePanelTab, workspacePanelOpenTabs, setWorkspacePanelOpenTabs, workspaceOpenRequest,
    setWorkspaceOpenRequest, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed,
    workspaceExpandedPaths, setWorkspaceExpandedPaths,
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
      return
    }

    const activeSessionId = readStringPreference(ACTIVE_SESSION_KEY)
    if (!activeSessionId) {
      restoredLastSessionRef.current = true
      return
    }

    const session = sessions.find((item) => item.id === activeSessionId)
    restoredLastSessionRef.current = true
    if (!session) {
      removePreference(ACTIVE_SESSION_KEY)
      return
    }
    void switchSession(session)
  }, [currentSession, sessions, sessionsLoaded])

  useEffect(() => {
    if (wasSettingsOpenRef.current && !settingsOpen) void refreshRuntime()
    wasSettingsOpenRef.current = settingsOpen
  }, [settingsOpen])

  useEffect(() => {
    writeStringSetPreference(PINNED_SESSIONS_KEY, pinnedSessionIds)
  }, [pinnedSessionIds])

  useEffect(() => {
    if (!restoredLastSessionRef.current) return
    if (currentSession) {
      writeStringPreference(ACTIVE_SESSION_KEY, currentSession)
    } else {
      removePreference(ACTIVE_SESSION_KEY)
    }
  }, [currentSession])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    appMountedRef.current = true
    return () => {
      appMountedRef.current = false
      sessionLoadRequestRef.current += 1
      historyLoadRequestRef.current += 1
      abortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!loading) return
    const timer = window.setInterval(() => setActivityNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [loading])

  const selectableProviders = useMemo(() => {
    if (!runtime) return []
    return runtime.providers.filter((provider) =>
      provider.models.length > 0 && (!provider.requiresKey || provider.hasKey),
    )
  }, [runtime])

  const selectedModel = useMemo(() => {
    if (!runtime) return null
    const { providerId, model } = splitModelRef(runtime.model)
    const provider = selectableProviders.find((item) => item.id === providerId)
    if (!provider || !provider.models.includes(model)) return null
    return { provider, model, ref: runtime.model }
  }, [runtime, selectableProviders])
  const displayedSessions = useMemo(() => sortSessionsForSidebar(sessions, pinnedSessionIds), [pinnedSessionIds, sessions])
  const visibleSessions = useMemo(() => standaloneSessionsForSidebar(displayedSessions), [displayedSessions])
  const visibleSessionMotionRef = useListReorderAnimation<HTMLDivElement>(visibleSessions.map((session) => session.id))
  const workspaceIsWorkplace = runtime ? isSamePath(runtime.workspace, runtime.workplace) : false
  const workspaceTip = runtime ? workspaceTitle(runtime.workspace, runtime.workplace) : ''
  const projectPath = runtime?.workplace ?? runtime?.workspace ?? ''
  const contextUsage = useMemo(
    () => buildContextUsage(runtime?.model, contextUsageSnapshot),
    [contextUsageSnapshot, runtime?.model],
  )
  const latestTaskActivity = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const activity = messages[index]?.activity
      if (activity) return activity
    }
    return null
  }, [messages])
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
      setSessions(sessions)
      return sessions
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

  async function refreshRuntime() {
    try {
      const next = await getRuntime()
      if (!appMountedRef.current) return
      setRuntime(next)
      setRuntimeError(null)
      alignWorkspacePanelToWorkspaceRoot(next.workspace)
    } catch (e) {
      if (appMountedRef.current) setRuntimeError((e as Error).message)
    }
  }
  async function applyRuntimePatch(patch: RuntimePatch): Promise<boolean> {
    try {
      const next = await updateRuntime(patch)
      if (!appMountedRef.current) return false
      setRuntime(next)
      setRuntimeError(null)
      if (Object.prototype.hasOwnProperty.call(patch, 'workspace')) {
        alignWorkspacePanelToWorkspaceRoot(next.workspace)
      }
      void refreshProjects()
      await notifyRuntimeSettingChanges(patch, next)
      return true
    } catch (e) {
      if (!appMountedRef.current) return false
      setRuntimeError((e as Error).message)
      await refreshRuntime()
      return false
    }
  }
  async function addAttachments() {
    try {
      const files = await selectAttachments()
      if (!appMountedRef.current) return
      if (files.length === 0) return
      mergeAttachments(files)
    } catch (e) {
      if (appMountedRef.current) setRuntimeError((e as Error).message)
    }
  }

  async function addAttachmentFiles(files: File[]) {
    if (files.length === 0) return
    try {
      const refs: AttachmentRef[] = []
      for (const file of files) {
        const path = getPathForFile(file) || (file as File & { path?: string }).path || ''
        if (path) {
          refs.push({
            path,
            name: file.name || lastPathSegment(path),
            kind: inferAttachmentKind(file.name || path, file.type),
            size: file.size,
          })
        } else {
          refs.push(await importAttachment(file))
        }
      }
      mergeAttachments(refs)
      if (!appMountedRef.current) return
      setRuntimeError(null)
    } catch (e) {
      if (appMountedRef.current) setRuntimeError((e as Error).message)
    }
  }

  function mergeAttachments(files: AttachmentRef[]) {
    setAttachments((prev) => {
      const byPath = new Map(prev.map((file) => [file.path, file]))
      for (const file of files) byPath.set(file.path, file)
      return Array.from(byPath.values())
    })
  }

  async function chooseWorkspace() {
    try {
      const path = await selectWorkspace()
      if (!appMountedRef.current) return
      if (!path) return
      await applyRuntimePatch({ workspace: path })
    } catch (e) {
      if (appMountedRef.current) setRuntimeError((e as Error).message)
    }
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

  function handleComposerDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    setDragActive(true)
  }

  function handleComposerDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragActive(true)
  }

  function handleComposerDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragActive(false)
  }

  function handleComposerDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    setDragActive(false)
    void addAttachmentFiles(Array.from(e.dataTransfer.files))
  }

  function handleComposerPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files)
    if (files.length === 0) return
    e.preventDefault()
    void addAttachmentFiles(files)
  }
  const { send, stop } = createRunActions({ abortRef, activeRunIdRef, activeApprovalScopeKey, appMountedRef, approvalGrantsRef, attachments, currentSession, input, liveToolStepRef, loading, permissionMode, pendingConversationTurnRef, pendingRuntimeMessageRef, publishRuntimeEventNotice, refreshProjects, refreshSessions, requestApprovalForScope, runtime, sessionOwnership, setActivityNow, setAttachments, setContextUsageSnapshot, setCurrentSession, setInput, setLoading, setMessages, setWorkspaceArtifactVersion, settleApprovalPrompt, stopRequestedRunIdRef })
  const {
    newSession,
    createConversationFromSidebar,
    openSidebarPanel,
    closeSidebarPanel,
    switchSession,
    loadOlderMessages,
    clearSessionFromLocalState,
    archiveSession,
    deleteSessionPermanently,
    renameSession,
    sessionsForProject,
    archiveAllSessions,
    togglePinnedSession,
  } = createSessionActions({
    abortRef,
    activeApprovalScopeKey,
    alignWorkspacePanelToWorkspaceRoot,
    appMountedRef,
    approvalGrantsRef,
    beginDraftApprovalScope,
    currentSession,
    historyLoadRequestRef,
    historyWindow,
    pushRoute,
    refreshProjects,
    refreshRuntime,
    refreshSessions,
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
    settleApprovalPrompt,
    sessionOwnership,
    visibleSessions,
  })
  const checkpointRecovery = useCheckpointRecovery({ abortRef, activeRunIdRef, appMountedRef, loading, permissionMode, runtime, stopRequestedRunIdRef, refreshProjects, refreshSessions, requestApprovalForScope, settleApprovalPrompt, switchSession, setActivityNow, setContextUsageSnapshot, setLoading, setWorkspaceArtifactVersion })
  const {
    openProjectCreator,
    activateProjectWorkspace,
    chooseProjectFolder,
    createProjectInFolder,
    relocateProject,
    resetWorkspace,
    resetWorkspaceAfterProjectRemoval,
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
    navigationRestoreTargetRef,
    pushRoute,
    refreshProjects,
    refreshSessions,
    runtime,
    sessionLoadRequestRef,
    sessionOwnership,
    sessions,
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
    setWorkspaceExpandedPaths,
    setWorkspaceFileDrafts,
    setWorkspaceOpenRequest,
    setWorkspacePanelOpenTabs,
    setWorkspacePanelTab,
    workspaceFileDrafts,
    workspaceOpenRequest,
    workspacePanelOpenTabs,
    workspacePanelTab,
  })
  function alignWorkspacePanelToWorkspaceRoot(root: string) {
    const normalizedRoot = root.trim()
    if (!normalizedRoot) return

    setWorkspaceOpenRequest((request) => {
      return alignWorkspacePanelStateToRoot({
        openRequest: request,
        openTabs: DEFAULT_WORKSPACE_PANEL_TABS,
        activeTab: 'review',
        drafts: {},
      }, normalizedRoot).openRequest
    })

    setWorkspacePanelOpenTabs((tabs) => {
      return alignWorkspacePanelStateToRoot({
        openRequest: null,
        openTabs: tabs,
        activeTab: 'review',
        drafts: {},
      }, normalizedRoot).openTabs
    })

    setWorkspacePanelTab((tab) => {
      return alignWorkspacePanelStateToRoot({
        openRequest: null,
        openTabs: DEFAULT_WORKSPACE_PANEL_TABS,
        activeTab: tab,
        drafts: {},
      }, normalizedRoot).activeTab
    })

    setWorkspaceFileDrafts((drafts) => {
      return alignWorkspacePanelStateToRoot({
        openRequest: null,
        openTabs: DEFAULT_WORKSPACE_PANEL_TABS,
        activeTab: 'review',
        drafts,
      }, normalizedRoot).drafts
    })
  }
  return { sessions, projects, currentSession, sessionOwnership, messages, setMessages, historyWindow, loadOlderMessages, input, setInput, loading, permissionMode, setPermissionMode, runtime, attachments, setAttachments, dragActive, runtimeError, runtimeEventNotice, checkpointRecovery, sidebarCollapsed, workspacePanelCollapsed, workspacePanelReopenActive, setWorkspacePanelReopenActive, workspacePanelFullscreen, workspacePanelTab, workspacePanelOpenTabs, workspaceBrowserTabs, workspaceBrowserUrl, workspaceBrowserHistory, navigateWorkspaceBrowser, openWorkspaceBrowser, openWorkspaceBrowserTab, updateWorkspaceBrowserTitle, moveWorkspaceBrowser, workspaceOpenRequest, setWorkspaceOpenRequest, workspaceFileDrafts, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed, workspaceExpandedPaths, setWorkspaceExpandedPaths, conversationCollapsed, setConversationCollapsed, now, pinnedSessionIds, sidebarPanel, sidebarSearch, setSidebarSearch, projectCreatorOpen, setProjectCreatorOpen, scrollRef, inputRef, shellRef, activityNow, workspaceArtifactVersion, setWorkspaceArtifactVersion, controlTip, setControlTip, pendingApproval, settingsEntryRippling, sidebarWidth, setSidebarWidth, setWorkspacePanelWidth, workspacePanelLayout, layoutStyle, settingsOpen, directModulePage, settingsPage, canNavigateBack, canNavigateForward, openSettingsFromEntry, openSettingsPage, openDirectModulePage, navigateBack, navigateForward, closeSettingsFromEntry, selectableProviders, selectedModel, displayedSessions, visibleSessions, visibleSessionMotionRef, workspaceIsWorkplace, workspaceTip, projectPath, contextUsage, latestTaskActivity, sidebarToggleTip, moreConversationTip, newConversationTip, uploadTip, sendTip, stopTip, requestWorkspaceSaveApproval, requestWorkspaceCommandApproval, settleApprovalPrompt, refreshSessions, refreshProjects, applyRuntimePatch, addAttachments, chooseWorkspace, openProjectCreator, activateProjectWorkspace, chooseProjectFolder, createProjectInFolder, relocateProject, resetWorkspace, openFileInWorkspace, openHyperlinkInside, openHyperlinkWithSystem, handleComposerDragEnter, handleComposerDragOver, handleComposerDragLeave, handleComposerDrop, handleComposerPaste, send, stop, notifyRuntimeWorkspaceFileSaved, createConversationFromSidebar, openSidebarPanel, closeSidebarPanel, switchSession, renameSession, archiveSession, deleteSessionPermanently, archiveProject, deleteProjectPermanently, archiveAllSessions, togglePinnedSession, beginSidebarResize, nudgeSidebar, toggleSidebar, beginWorkspacePanelResize, toggleWorkspacePanel, updateWorkspacePanelReopenPresence, toggleWorkspacePanelFullscreen, nudgeWorkspacePanel, openWorkspacePanelTab, updateWorkspaceFileDraft, closeWorkspacePanelTab, defaultWorkspacePath, workspacePanelRoot, workspacePanelUsingTemporaryRoot }
}
export type AppController = ReturnType<typeof useAppController>
