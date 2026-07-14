// Top-level renderer orchestration. Domain hooks are extracted from this compatibility controller incrementally.
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
import { dataTransferHasFiles,inferAttachmentKind,isSamePath,lastPathSegment,resolveWorkspacePreviewRoot,workspaceTitle } from '../workspace/path-utils'
import { sortSessionsForSidebar,standaloneSessionsForSidebar,useListReorderAnimation } from './list-motion'
import { clampNumber,navigationSnapshotsEqual,rebindNavigationSnapshotWorkspace,routesEqual } from './navigation'
import { ACTIVE_SESSION_KEY,PINNED_SESSIONS_KEY,SIDEBAR_COLLAPSED_KEY,SIDEBAR_COLLAPSE_THRESHOLD,SIDEBAR_SETTLE_ANIMATION_MS,SIDEBAR_WIDTH_DEFAULT,SIDEBAR_WIDTH_KEY,SIDEBAR_WIDTH_MAX,SIDEBAR_WIDTH_MIN,TWO_STAGE_RESIZE_MOTION_MS,WORKSPACE_FILE_NAVIGATOR_COLLAPSED_KEY,WORKSPACE_PANEL_COLLAPSED_KEY,WORKSPACE_PANEL_FULLSCREEN_KEY,WORKSPACE_PANEL_MOTION_MS,WORKSPACE_PANEL_TAB_KEY,WORKSPACE_PANEL_WIDTH_KEY,readBooleanPreference,readNumberPreference,readStringPreference,readStringSetPreference,readWorkspaceFileDraftsPreference,readWorkspaceLayoutFallbackMarkers,readWorkspaceOpenRequestPreference,readWorkspacePanelOpenTabsPreference,readWorkspacePanelTabPreference,removePreference,shouldApplyWorkspaceLayoutFallback,writeBooleanPreference,writeNumberPreference,writeStringPreference,writeStringSetPreference,writeWorkspaceFileDraftsPreference,writeWorkspaceOpenRequestPreference,writeWorkspacePanelOpenTabsPreference } from './preferences'
import { AppNavigationSnapshot,AppRoute,SidebarPanel } from './types'
import { useWorkspaceLayoutController } from '../workspace/use-workspace-layout-controller'

export function useAppController() {

  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [currentSession, setCurrentSession] = useState<string | undefined>()
  const [sessionOwnership, setSessionOwnership] = useState<Pick<SessionMeta, 'scope' | 'projectId'>>({
    scope: 'standalone',
  })
  const [messages, setMessages] = useState<ChatMessage[]>([])
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
  const [activeRoute, setActiveRoute] = useState<AppRoute>({ section: 'chat' })
  const [appHistory, setAppHistory] = useState<NavigationHistoryState<AppNavigationSnapshot>>({
    entries: [],
    index: -1,
  })
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const wasSettingsOpenRef = useRef(false)
  const lastRenderedSettingsPageRef = useRef<SettingsPage>('home')
  const settingsEntryRippleTimerRef = useRef<number>()
  const settingsEntryRippleFrameRef = useRef<number>()
  const navigationHistoryInitializedRef = useRef(false)
  const navigationRestoreTargetRef = useRef<AppNavigationSnapshot | null>(null)
  const appHistoryRef = useRef(appHistory)
  const settingsReturnRouteRef = useRef<AppRoute>({ section: 'chat' })
  const appMountedRef = useRef(true)
  const sessionLoadRequestRef = useRef(0)
  const restoredLastSessionRef = useRef(false)
  const [activityNow, setActivityNow] = useState(() => Date.now())
  const liveToolStepRef = useRef(new Map<string, string>())
  const [contextUsageSnapshot, setContextUsageSnapshot] = useState<ContextUsageSnapshot | null>(null)
  const [workspaceArtifactVersion, setWorkspaceArtifactVersion] = useState(0)
  const [controlTip, setControlTip] = useState<FloatingHelpTip | null>(null)
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
    workspaceOpenRequest,
    setWorkspaceOpenRequest,
    workspaceFileDrafts,
    setWorkspaceFileDrafts,
    workspaceFileNavigatorCollapsed,
    setWorkspaceFileNavigatorCollapsed,
    workspaceExpandedPaths,
    setWorkspaceExpandedPaths,
    pendingDirtyCloseTab,
    setPendingDirtyCloseTab,
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
  })
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalPrompt | null>(null)
  const pendingApprovalRef = useRef<PendingApprovalPrompt | null>(null)
  const approvalGrantsRef = useRef(new SessionApprovalGrantStore())
  const draftApprovalScopeRef = useRef(createDraftApprovalScopeKey())
  const [settingsEntryRippling, setSettingsEntryRippling] = useState(false)

  const settingsOpen = activeRoute.section === 'settings'
  const directModulePage = activeRoute.section === 'module' ? activeRoute.page : null
  const routeSettingsPage = activeRoute.section === 'settings' ? activeRoute.page : 'home'
  if (settingsOpen) lastRenderedSettingsPageRef.current = routeSettingsPage
  const settingsPage = settingsOpen ? routeSettingsPage : lastRenderedSettingsPageRef.current
  const canNavigateBack = appHistory.index > 0
  const canNavigateForward = appHistory.index >= 0 && appHistory.index < appHistory.entries.length - 1

  const navigationSnapshot = useMemo<AppNavigationSnapshot>(() => ({
    route: activeRoute,
    sidebarCollapsed,
    sidebarWidth,
    conversationCollapsed,
    sidebarPanel,
    workspacePanelCollapsed,
    workspacePanelFullscreen,
    workspacePanelWidth,
    workspacePanelTab,
    workspacePanelOpenTabs: boundStringList(workspacePanelOpenTabs, MAX_NAVIGATION_OPEN_TABS) as WorkspacePanelTabId[],
    workspaceOpenRequest: workspaceOpenRequest
      ? { root: workspaceOpenRequest.root, path: workspaceOpenRequest.path }
      : null,
    workspaceFileNavigatorCollapsed,
    workspaceExpandedPaths: boundStringList(workspaceExpandedPaths, MAX_NAVIGATION_EXPANDED_PATHS),
  }), [
    activeRoute,
    conversationCollapsed,
    sidebarCollapsed,
    sidebarPanel,
    sidebarWidth,
    workspaceExpandedPaths,
    workspaceFileNavigatorCollapsed,
    workspaceOpenRequest,
    workspacePanelCollapsed,
    workspacePanelFullscreen,
    workspacePanelOpenTabs,
    workspacePanelTab,
    workspacePanelWidth,
  ])

  appHistoryRef.current = appHistory

  useEffect(() => {
    if (!navigationHistoryInitializedRef.current) {
      navigationHistoryInitializedRef.current = true
      setAppHistory({ entries: [navigationSnapshot], index: 0 })
      return
    }

    const restoreTarget = navigationRestoreTargetRef.current
    if (restoreTarget) {
      if (navigationSnapshotsEqual(navigationSnapshot, restoreTarget)) {
        navigationRestoreTargetRef.current = null
      }
      return
    }

    const timer = window.setTimeout(() => {
      setAppHistory((current) => appendNavigationEntry(
        current,
        navigationSnapshot,
        (left, right) => navigationSnapshotsEqual(left, right),
        MAX_NAVIGATION_HISTORY_ENTRIES,
      ))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [navigationSnapshot])

  function pushRoute(route: AppRoute) {
    setControlTip(null)
    setActiveRoute((current) => routesEqual(current, route) ? current : route)
  }

  function openSettingsRoot() {
    setSidebarPanel(null)
    pushRoute({ section: 'settings', page: 'home' })
  }

  function openSettingsFromEntry() {
    if (!settingsOpen) settingsReturnRouteRef.current = activeRoute
    triggerSettingsEntryRipple()
    openSettingsRoot()
  }

  function openSettingsPage(page: SettingsPage) {
    setSidebarPanel(null)
    pushRoute({ section: 'settings', page })
  }

  function openDirectModulePage(page: DirectModulePage) {
    setSidebarPanel(null)
    pushRoute({ section: 'module', page })
  }

  function navigateBack() {
    setControlTip(null)
    navigateHistoryTo(appHistoryRef.current.index - 1)
  }

  function navigateForward() {
    setControlTip(null)
    navigateHistoryTo(appHistoryRef.current.index + 1)
  }

  function navigateHistoryTo(index: number) {
    const current = appHistoryRef.current
    if (index < 0 || index >= current.entries.length || index === current.index) return
    const target = current.entries[index]
    if (!target) return
    navigationRestoreTargetRef.current = target
    restoreNavigationSnapshot(target)
    const next = { ...current, index }
    appHistoryRef.current = next
    setAppHistory(next)
  }

  function restoreNavigationSnapshot(snapshot: AppNavigationSnapshot) {
    setActiveRoute(snapshot.route)
    setSidebarCollapsed(snapshot.sidebarCollapsed)
    setSidebarWidth(snapshot.sidebarWidth)
    setConversationCollapsed(snapshot.conversationCollapsed)
    setSidebarPanel(snapshot.sidebarPanel)
    setWorkspacePanelCollapsed(snapshot.workspacePanelCollapsed)
    setWorkspacePanelFullscreen(snapshot.workspacePanelFullscreen)
    setWorkspacePanelWidth(snapshot.workspacePanelWidth)
    setWorkspacePanelTab(snapshot.workspacePanelTab)
    setWorkspacePanelOpenTabs(snapshot.workspacePanelOpenTabs)
    setWorkspaceOpenRequest(snapshot.workspaceOpenRequest
      ? { id: Date.now(), ...snapshot.workspaceOpenRequest }
      : null)
    setWorkspaceFileNavigatorCollapsed(snapshot.workspaceFileNavigatorCollapsed)
    setWorkspaceExpandedPaths(snapshot.workspaceExpandedPaths)
  }

  function closeSettingsWorkspace() {
    pushRoute(settingsReturnRouteRef.current)
  }

  function closeSettingsFromEntry() {
    triggerSettingsEntryRipple()
    closeSettingsWorkspace()
  }

  function triggerSettingsEntryRipple() {
    window.clearTimeout(settingsEntryRippleTimerRef.current)
    window.cancelAnimationFrame(settingsEntryRippleFrameRef.current ?? 0)
    setSettingsEntryRippling(false)
    settingsEntryRippleFrameRef.current = window.requestAnimationFrame(() => {
      setSettingsEntryRippling(true)
      settingsEntryRippleTimerRef.current = window.setTimeout(() => {
        setSettingsEntryRippling(false)
      }, 520)
    })
  }

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
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [messages])

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
      window.clearTimeout(settingsEntryRippleTimerRef.current)
      window.cancelAnimationFrame(settingsEntryRippleFrameRef.current ?? 0)
      abortRef.current?.abort()
      pendingApprovalRef.current?.resolve('deny')
      pendingApprovalRef.current = null
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
  const visibleSessions = useMemo(
    () => standaloneSessionsForSidebar(displayedSessions),
    [displayedSessions],
  )
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
  const sendTip = loading ? '停止' : '发送'

  function openApprovalPrompt(prompt: PendingApprovalPrompt) {
    pendingApprovalRef.current?.resolve('deny')
    pendingApprovalRef.current = prompt
    setPendingApproval(prompt)
  }

  function activeApprovalScopeKey(sessionId = currentSession): string {
    return sessionId ? sessionApprovalScopeKey(sessionId) : draftApprovalScopeRef.current
  }

  function beginDraftApprovalScope(): void {
    approvalGrantsRef.current.clear(draftApprovalScopeRef.current)
    draftApprovalScopeRef.current = createDraftApprovalScopeKey()
  }

  async function requestApprovalForScope(request: ApprovalRequest, scopeKey: string): Promise<boolean> {
    if (request.permissionMode === 'full') return true
    if (approvalGrantsRef.current.allows(scopeKey, request)) return true
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      openApprovalPrompt({ request, resolve })
    })
    if (decision === 'session') approvalGrantsRef.current.grant(scopeKey, request)
    return decision !== 'deny'
  }

  function requestWorkspaceSaveApproval(detail: unknown): Promise<boolean> {
    return requestApprovalForScope({
      id: `workspace-save-${Date.now()}`,
      action: 'save_file',
      detail,
      permissionMode,
      source: 'workspace',
    }, activeApprovalScopeKey())
  }

  function requestWorkspaceCommandApproval(detail: unknown): Promise<boolean> {
    return requestApprovalForScope({
      id: `workspace-command-${Date.now()}`,
      action: 'exec',
      detail,
      permissionMode,
      source: 'workspace',
    }, activeApprovalScopeKey())
  }

  function settleApprovalPrompt(decision: ApprovalDecision) {
    const prompt = pendingApprovalRef.current
    if (!prompt) return
    pendingApprovalRef.current = null
    setPendingApproval(null)
    prompt.resolve(decision)
  }

  async function refreshSessions() {
    try {
      const { sessions } = await listSessions()
      if (!appMountedRef.current) return
      setSessions(sessions)
    } catch (e) {
      console.error('Failed to list sessions:', e)
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

  async function applyRuntimePatch(patch: Partial<Pick<RuntimeState, 'model' | 'reasoning' | 'profile' | 'contextCompressionThresholdRatio' | 'workspace'>>) {
    try {
      const next = await updateRuntime(patch)
      if (!appMountedRef.current) return
      setRuntime(next)
      setRuntimeError(null)
      if (Object.prototype.hasOwnProperty.call(patch, 'workspace')) {
        alignWorkspacePanelToWorkspaceRoot(next.workspace)
      }
      void refreshProjects()
    } catch (e) {
      if (!appMountedRef.current) return
      setRuntimeError((e as Error).message)
      await refreshRuntime()
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

  function openProjectCreator() {
    setControlTip(null)
    setSidebarPanel(null)
    setProjectCreatorOpen(true)
  }

  async function activateProjectWorkspace(project: ProjectMeta) {
    sessionLoadRequestRef.current += 1
    const next = await updateRuntime({ workspace: project.path })
    if (!appMountedRef.current) return
    pushRoute({ section: 'chat' })
    setRuntime(next)
    setRuntimeError(null)
    alignWorkspacePanelToWorkspaceRoot(next.workspace)
    setWorkspaceOpenRequest(null)
    setProjectCreatorOpen(false)
    setConversationCollapsed(false)
    beginDraftApprovalScope()
    setCurrentSession(undefined)
    setSessionOwnership({ scope: 'project', projectId: project.id })
    setMessages([])
    setContextUsageSnapshot(null)
    abortRef.current?.abort()
    await refreshProjects()
    await refreshSessions()
  }

  async function chooseProjectFolder() {
    const path = await selectWorkspace()
    if (!path) return
    const { project } = await registerProject(path)
    await activateProjectWorkspace(project)
  }

  async function createProjectInFolder(parentPath: string, name: string) {
    const result = await createProjectFolder(parentPath, name)
    await activateProjectWorkspace(result.project)
  }

  async function relocateProject(project: ProjectMeta) {
    setControlTip(null)
    try {
      const path = await selectWorkspace()
      if (!path) return
      const result = await rebindProject(project.id, path)
      if (!appMountedRef.current) return

      const reboundWorkspace = rebindWorkspacePanelState({
        openRequest: workspaceOpenRequest,
        openTabs: workspacePanelOpenTabs,
        activeTab: workspacePanelTab,
        drafts: workspaceFileDrafts,
      }, project.path, result.project.path)
      setWorkspaceOpenRequest(reboundWorkspace.openRequest)
      setWorkspacePanelOpenTabs(reboundWorkspace.openTabs)
      setWorkspacePanelTab(reboundWorkspace.activeTab)
      setWorkspaceFileDrafts(reboundWorkspace.drafts)
      setWorkspaceExpandedPaths((paths) => paths.map((entry) => (
        rebindWorkspacePath(entry, project.path, result.project.path)
      )))
      setPendingDirtyCloseTab((tab) => {
        if (!tab) return null
        const file = parseWorkspaceFileTabId(tab)
        return file
          ? workspaceFileTabId(
              rebindWorkspacePath(file.root, project.path, result.project.path),
              rebindWorkspacePath(file.path, project.path, result.project.path),
            )
          : tab
      })

      const reboundHistory: NavigationHistoryState<AppNavigationSnapshot> = {
        ...appHistoryRef.current,
        entries: appHistoryRef.current.entries.map((entry) => (
          rebindNavigationSnapshotWorkspace(entry, project.path, result.project.path)
        )),
      }
      appHistoryRef.current = reboundHistory
      setAppHistory(reboundHistory)
      if (navigationRestoreTargetRef.current) {
        navigationRestoreTargetRef.current = rebindNavigationSnapshotWorkspace(
          navigationRestoreTargetRef.current,
          project.path,
          result.project.path,
        )
      }
      setProjects((items) => items.map((item) => item.id === result.project.id ? result.project : item))
      const updatedSessions = new Map(result.sessions.map((session) => [session.id, session]))
      setSessions((items) => items.map((session) => updatedSessions.get(session.id) ?? session))

      const activeProject = sessionOwnership.scope === 'project' && sessionOwnership.projectId === project.id
      const nextRuntime = activeProject && !isSamePath(result.runtime.workspace, result.project.path)
        ? await updateRuntime({ workspace: result.project.path })
        : result.runtime
      if (!appMountedRef.current) return
      setRuntime(nextRuntime)
      setRuntimeError(null)
      void refreshProjects()
      void refreshSessions()
    } catch (error) {
      if (appMountedRef.current) setRuntimeError((error as Error).message)
    }
  }

  async function resetWorkspace() {
    setWorkspaceOpenRequest(null)
    await applyRuntimePatch({ workspace: '' })
  }

  function openFileInWorkspace(path: string) {
    const root = resolveWorkspacePreviewRoot(path, runtime, projectPath)
    setControlTip(null)
    openWorkspaceFileTab(root, path)
  }

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

  async function send() {
    const text = input.trim()
    if ((!text && attachments.length === 0) || loading) return
    const activeAttachments = attachments
    const displayText = formatUserMessage(text, activeAttachments)
    const controller = new AbortController()
    const activityStartedAt = Date.now()
    const approvalScopeKey = activeApprovalScopeKey()
    abortRef.current = controller
    setInput('')
    setAttachments([])
    setActivityNow(activityStartedAt)
    setMessages((m) => [
      ...m,
      { role: 'user', text: displayText, timestamp: new Date(activityStartedAt).toISOString(), attachments: activeAttachments },
      {
        role: 'assistant',
        text: '',
        timestamp: new Date(activityStartedAt).toISOString(),
        activityCollapsed: false,
        activity: {
          status: 'running',
          instruction: displayText,
          startedAt: activityStartedAt,
          steps: [],
          tools: [],
        },
      },
    ])
    liveToolStepRef.current.clear()
    setLoading(true)
    try {
      const result = await runAgentStream(text || '请根据附件继续处理。', currentSession, permissionMode, {
        signal: controller.signal,
        onApprovalRequest: (request) => appMountedRef.current
          ? requestApprovalForScope(request, approvalScopeKey)
          : Promise.resolve(false),
        onToolEvent: (evt) => {
          if (!appMountedRef.current) return
          if (evt.type === 'task_book' && evt.taskBook) {
            const taskBook = evt.taskBook
            updateLastAssistantActivity(setMessages, (activity) => ({
              ...activity,
              taskBook,
              steps: mergeTaskBookIntoLiveSteps(activity.steps, taskBook),
            }))
            return
          }
          if (evt.type === 'step_start' && evt.stepId) {
            updateLastAssistantActivity(setMessages, (activity) => ({
              ...activity,
              steps: upsertLiveStep(activity.steps, {
                stepId: evt.stepId ?? '',
                title: evt.title || evt.description || '执行步骤',
                description: evt.description,
                status: 'running',
                startedAt: Date.now(),
              }),
            }))
            return
          }
          if (evt.type === 'verification_start') {
            updateLastAssistantActivity(setMessages, (activity) => ({
              ...activity,
              verificationRunning: true,
            }))
            return
          }
          if (evt.type === 'verification' && evt.verification) {
            updateLastAssistantActivity(setMessages, (activity) => ({
              ...activity,
              verificationRunning: false,
              verificationHistory: [
                ...(activity.verificationHistory ?? []),
                evt.verification!,
              ],
            }))
            return
          }
          if (evt.type === 'step_done' || evt.type === 'step_failed' || evt.type === 'step_skipped') {
            if (!evt.stepId) return
            const status: LiveStepStatus = evt.type === 'step_done'
              ? 'done'
              : evt.type === 'step_failed'
                ? 'failed'
                : 'skipped'
            updateLastAssistantActivity(setMessages, (activity) => ({
              ...activity,
              steps: upsertLiveStep(activity.steps, {
                stepId: evt.stepId ?? '',
                title: evt.title || evt.description || '执行步骤',
                description: evt.description,
                status,
                output: evt.output,
                error: evt.error,
                activeTools: 0,
                endedAt: Date.now(),
              }),
            }))
            return
          }
          if (evt.type === 'tool_start' && evt.callId && evt.name) {
            if (evt.stepId) liveToolStepRef.current.set(evt.callId, evt.stepId)
            updateLastAssistantActivity(setMessages, (activity) => ({
              ...activity,
              tools: upsertLiveTool(activity.tools, {
                callId: evt.callId ?? '',
                name: evt.name ?? '',
                stepId: evt.stepId,
                startedAt: Date.now(),
                input: evt.input,
                ok: undefined,
                error: undefined,
              }),
              steps: evt.stepId ? bumpLiveStepTools(activity.steps, evt.stepId ?? '', 1) : activity.steps,
            }))
            return
          }
          if (evt.type === 'tool_end' && evt.callId) {
            const stepId = evt.stepId ?? liveToolStepRef.current.get(evt.callId)
            liveToolStepRef.current.delete(evt.callId)
            updateLastAssistantActivity(setMessages, (activity) => ({
              ...activity,
              tools: upsertLiveTool(activity.tools, {
                callId: evt.callId ?? '',
                name: evt.name ?? '',
                stepId,
                ok: evt.ok,
                output: evt.output,
                error: evt.error,
                endedAt: Date.now(),
              }),
              steps: stepId ? bumpLiveStepTools(activity.steps, stepId, -1) : activity.steps,
            }))
          }
        },
        onDelta: (delta) => {
          if (!appMountedRef.current) return
          if (!delta) return
          setMessages((m) => {
            const next = [...m]
            const last = next[next.length - 1]
            if (last?.role === 'assistant') {
              next[next.length - 1] = { ...last, text: last.text + delta }
            }
            return next
          })
        },
      }, {
        workspace: runtime?.workspace,
        sessionScope: sessionOwnership.scope,
        projectId: sessionOwnership.projectId,
        reasoning: runtime?.reasoning,
        profile: runtime?.profile,
        attachments: activeAttachments,
      })
      if (!appMountedRef.current) return
      approvalGrantsRef.current.promote(approvalScopeKey, sessionApprovalScopeKey(result.sessionId))
      setCurrentSession(result.sessionId)
      setContextUsageSnapshot(buildContextUsageSnapshot(
        runtime?.model,
        result.usage,
        result.contextSnapshots,
        result.modelRequests,
      ))
      setWorkspaceArtifactVersion((value) => value + 1)
      setMessages((m) => {
        const next = [...m]
        const last = next[next.length - 1]
        const traceData = buildTraceData(result)
        const artifacts = buildArtifactsFromToolCalls(traceData.toolCalls)
        if (last?.role === 'assistant') {
          const endedAt = Date.now()
          const taskSteps = result.taskExecution?.steps?.map((step) => taskStepToLiveStep(step)) ?? []
          const currentActivity = last.activity
          next[next.length - 1] = {
            ...last,
            text: last.text || result.reply || '(no reply)',
            ...traceData,
            artifacts,
            activityCollapsed: true,
            activity: currentActivity
              ? {
                ...currentActivity,
                status: result.status === 'ok' ? 'done' : 'failed',
                endedAt,
                durationMs: result.durationMs || endedAt - currentActivity.startedAt,
                taskBook: result.taskBook ?? currentActivity.taskBook,
                verificationHistory: result.verificationHistory ?? currentActivity.verificationHistory,
                verificationRunning: false,
                steps: currentActivity.steps.length > 0 ? currentActivity.steps : taskSteps,
              }
              : undefined,
          }
        }
        return next
      })
      void refreshSessions()
      void refreshProjects()
    } catch (e) {
      if (!appMountedRef.current) return
      if ((e as Error).name === 'AbortError') {
        setMessages((m) => {
          const next = [...m]
          const last = next[next.length - 1]
          if (last?.role === 'assistant') {
            const endedAt = Date.now()
            next[next.length - 1] = {
              ...last,
              text: last.text || '已停止。',
              activityCollapsed: true,
              activity: last.activity
                ? { ...last.activity, status: 'aborted', endedAt, durationMs: endedAt - last.activity.startedAt }
                : undefined,
            }
          }
          return next
        })
        return
      }
      setMessages((m) => {
        const next = [...m]
        const last = next[next.length - 1]
        const text = `Error: ${(e as Error).message}`
        if (last?.role === 'assistant' && !last.text) {
          const endedAt = Date.now()
          next[next.length - 1] = {
            ...last,
            text,
            activityCollapsed: true,
            activity: last.activity
              ? { ...last.activity, status: 'failed', endedAt, durationMs: endedAt - last.activity.startedAt }
              : undefined,
          }
        } else {
          next.push({ role: 'assistant', text })
        }
        return next
      })
    } finally {
      settleApprovalPrompt('deny')
      abortRef.current = null
      liveToolStepRef.current.clear()
      if (appMountedRef.current) setLoading(false)
    }
  }

  function stop() {
    settleApprovalPrompt('deny')
    abortRef.current?.abort()
  }

  function newSession(ownership: Pick<SessionMeta, 'scope' | 'projectId'> = { scope: 'standalone' }) {
    sessionLoadRequestRef.current += 1
    pushRoute({ section: 'chat' })
    beginDraftApprovalScope()
    setCurrentSession(undefined)
    setSessionOwnership(ownership)
    setMessages([])
    setContextUsageSnapshot(null)
    settleApprovalPrompt('deny')
    abortRef.current?.abort()
  }

  function createConversationFromSidebar() {
    setSidebarPanel(null)
    setConversationCollapsed(false)
    newSession({ scope: 'standalone' })
  }

  function openSidebarPanel(panel: NonNullable<SidebarPanel>) {
    setControlTip(null)
    setSidebarPanel((current) => (current === panel ? null : panel))
  }

  function closeSidebarPanel() {
    setSidebarPanel(null)
  }

  async function switchSession(session: SessionMeta) {
    const requestId = ++sessionLoadRequestRef.current
    const { id, title, workspacePath } = session
    setSidebarPanel(null)
    pushRoute({ section: 'chat' })
    if (workspacePath && (!runtime || !isSamePath(runtime.workspace, workspacePath))) {
      try {
        const next = await updateRuntime({ workspace: workspacePath })
        if (!appMountedRef.current || requestId !== sessionLoadRequestRef.current) return
        setRuntime(next)
        setRuntimeError(null)
        alignWorkspacePanelToWorkspaceRoot(next.workspace)
        void refreshProjects()
      } catch (e) {
        if (!appMountedRef.current || requestId !== sessionLoadRequestRef.current) return
        setRuntimeError((e as Error).message)
        await refreshRuntime()
        return
      }
    }
    setSessionOwnership({ scope: session.scope, projectId: session.projectId })
    if (id === currentSession) return
    abortRef.current?.abort()
    setCurrentSession(id)
    setContextUsageSnapshot(null)
    setMessages([{ role: 'assistant', text: '正在加载历史消息...' }])
    try {
      const history = await getSessionMessages(id)
      if (!appMountedRef.current || requestId !== sessionLoadRequestRef.current) return
      setMessages(
        history.length > 0
          ? history.map(historyMessageToChatMessage)
          : [{ role: 'assistant', text: `会话 "${title}" 暂无历史消息` }],
      )
    } catch (e) {
      if (!appMountedRef.current || requestId !== sessionLoadRequestRef.current) return
      setMessages([{ role: 'assistant', text: `加载历史失败: ${(e as Error).message}` }])
    }
  }

  function clearSessionFromLocalState(id: string) {
    approvalGrantsRef.current.clear(sessionApprovalScopeKey(id))
    setSessions((items) => items.filter((item) => item.id !== id))
    setPinnedSessionIds((ids) => {
      const next = new Set(ids)
      next.delete(id)
      return next
    })
    if (id === currentSession) {
      beginDraftApprovalScope()
      setCurrentSession(undefined)
      setMessages([])
      setContextUsageSnapshot(null)
    }
  }

  async function archiveSession(id: string) {
    setControlTip(null)
    await deleteSession(id)
    if (!appMountedRef.current) return
    clearSessionFromLocalState(id)
    void refreshSessions()
  }

  async function deleteSessionPermanently(id: string) {
    setControlTip(null)
    await deleteSession(id, { hard: true })
    if (!appMountedRef.current) return
    clearSessionFromLocalState(id)
    void refreshSessions()
  }

  function sessionsForProject(project: ProjectMeta): SessionMeta[] {
    return projectSessions(sessions, project.id)
  }

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

  async function resetWorkspaceAfterProjectRemoval(project: ProjectMeta, wasActiveProject: boolean) {
    if (!wasActiveProject) return
    const next = await updateRuntime({ workspace: '' })
    if (!appMountedRef.current) return
    setRuntime(next)
    setRuntimeError(null)
    alignWorkspacePanelToWorkspaceRoot(next.workspace)
    beginDraftApprovalScope()
    setCurrentSession(undefined)
    setSessionOwnership({ scope: 'standalone' })
    setMessages([])
    setContextUsageSnapshot(null)
    abortRef.current?.abort()
  }

  async function archiveProject(project: ProjectMeta) {
    setControlTip(null)
    const wasActiveProject = sessionOwnership.scope === 'project' && sessionOwnership.projectId === project.id
    const removedSessionIds = new Set(sessionsForProject(project).map((session) => session.id))
    await deleteProject(project.id)
    if (!appMountedRef.current) return
    setProjects((items) => items.filter((item) => item.id !== project.id))
    setSessions((items) => items.filter((item) => !removedSessionIds.has(item.id)))
    if (currentSession && removedSessionIds.has(currentSession)) {
      beginDraftApprovalScope()
      setCurrentSession(undefined)
      setSessionOwnership({ scope: 'standalone' })
      setMessages([])
      setContextUsageSnapshot(null)
    }
    await resetWorkspaceAfterProjectRemoval(project, wasActiveProject)
    void refreshProjects()
    void refreshSessions()
  }

  async function deleteProjectPermanently(project: ProjectMeta) {
    setControlTip(null)
    const wasActiveProject = sessionOwnership.scope === 'project' && sessionOwnership.projectId === project.id
    const removedSessionIds = new Set(sessionsForProject(project).map((session) => session.id))
    await deleteProject(project.id, { hard: true })
    if (!appMountedRef.current) return
    setProjects((items) => items.filter((item) => item.id !== project.id))
    setSessions((items) => items.filter((item) => !removedSessionIds.has(item.id)))
    setPinnedSessionIds((pinned) => {
      const next = new Set(pinned)
      for (const id of removedSessionIds) next.delete(id)
      return next
    })
    if (currentSession && removedSessionIds.has(currentSession)) {
      beginDraftApprovalScope()
      setCurrentSession(undefined)
      setSessionOwnership({ scope: 'standalone' })
      setMessages([])
      setContextUsageSnapshot(null)
    }
    await resetWorkspaceAfterProjectRemoval(project, wasActiveProject)
    void refreshProjects()
    void refreshSessions()
  }

  async function archiveAllSessions() {
    setControlTip(null)
    const ids = visibleSessions.map((session) => session.id)
    if (ids.length === 0) return
    await Promise.all(ids.map((id) => deleteSession(id)))
    if (!appMountedRef.current) return
    setSessions((items) => items.filter((item) => !ids.includes(item.id)))
    setPinnedSessionIds((pinned) => {
      const next = new Set(pinned)
      for (const id of ids) next.delete(id)
      return next
    })
    if (currentSession && ids.includes(currentSession)) {
      beginDraftApprovalScope()
      setCurrentSession(undefined)
      setMessages([])
      setContextUsageSnapshot(null)
    }
    void refreshSessions()
  }

  function togglePinnedSession(id: string) {
    setControlTip(null)
    setPinnedSessionIds((ids) => {
      const next = new Set(ids)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }
  return { sessions, projects, currentSession, sessionOwnership, messages, setMessages, input, setInput, loading, permissionMode, setPermissionMode, runtime, attachments, setAttachments, dragActive, runtimeError, sidebarCollapsed, workspacePanelCollapsed, workspacePanelReopenActive, setWorkspacePanelReopenActive, workspacePanelFullscreen, workspacePanelTab, workspacePanelOpenTabs, workspaceOpenRequest, setWorkspaceOpenRequest, workspaceFileDrafts, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed, workspaceExpandedPaths, setWorkspaceExpandedPaths, pendingDirtyCloseTab, setPendingDirtyCloseTab, conversationCollapsed, setConversationCollapsed, now, pinnedSessionIds, sidebarPanel, sidebarSearch, setSidebarSearch, projectCreatorOpen, setProjectCreatorOpen, scrollRef, inputRef, shellRef, activityNow, workspaceArtifactVersion, setWorkspaceArtifactVersion, controlTip, setControlTip, pendingApproval, settingsEntryRippling, sidebarWidth, setSidebarWidth, setWorkspacePanelWidth, workspacePanelLayout, layoutStyle, settingsOpen, directModulePage, settingsPage, canNavigateBack, canNavigateForward, openSettingsFromEntry, openSettingsPage, openDirectModulePage, navigateBack, navigateForward, closeSettingsFromEntry, selectableProviders, selectedModel, displayedSessions, visibleSessions, visibleSessionMotionRef, workspaceIsWorkplace, workspaceTip, projectPath, contextUsage, latestTaskActivity, sidebarToggleTip, moreConversationTip, newConversationTip, uploadTip, sendTip, requestWorkspaceSaveApproval, requestWorkspaceCommandApproval, settleApprovalPrompt, refreshSessions, refreshProjects, applyRuntimePatch, addAttachments, chooseWorkspace, openProjectCreator, activateProjectWorkspace, chooseProjectFolder, createProjectInFolder, relocateProject, resetWorkspace, openFileInWorkspace, handleComposerDragEnter, handleComposerDragOver, handleComposerDragLeave, handleComposerDrop, handleComposerPaste, send, stop, createConversationFromSidebar, openSidebarPanel, closeSidebarPanel, switchSession, archiveSession, deleteSessionPermanently, archiveProject, deleteProjectPermanently, archiveAllSessions, togglePinnedSession, beginSidebarResize, nudgeSidebar, toggleSidebar, beginWorkspacePanelResize, toggleWorkspacePanel, updateWorkspacePanelReopenPresence, toggleWorkspacePanelFullscreen, nudgeWorkspacePanel, openWorkspacePanelTab, updateWorkspaceFileDraft, closeWorkspacePanelTab, defaultWorkspacePath, workspacePanelRoot, workspacePanelUsingTemporaryRoot }
}

export type AppController = ReturnType<typeof useAppController>
