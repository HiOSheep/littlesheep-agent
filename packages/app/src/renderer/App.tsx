// Electron renderer composition shell. Domain UI and state move behind feature
// controllers while this file preserves top-level navigation and compatibility.
import { lazy, Suspense, type CSSProperties, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import type { Terminal as XTermTerminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { TaskBook, VerificationRecord } from '@littlesheep/types'
import { ALL_AGENT_PROFILES } from '@littlesheep/prompt'
import '@xterm/xterm/css/xterm.css'
import {
  runAgentStream,
  listSessions,
  listProjects,
  createProjectFolder,
  registerProject,
  rebindProject,
  deleteProject,
  deleteSession,
  getSessionMessages,
  getRuntime,
  updateRuntime,
  getDataRootStatus,
  selectDataRootTarget,
  requestDataRootMigration,
  cancelDataRootOperation,
  requestDataRootRollback,
  restartApplication,
  selectWorkspace,
  selectAttachments,
  listWorkspaceDirectory,
  previewWorkspaceFile,
  saveWorkspaceFile,
  readWorkspaceLayoutSnapshot,
  saveWorkspaceLayoutSnapshot,
  openWorkspacePath,
  openWorkspacePathInVSCode,
  listWorkspaceArtifacts,
  listWorkspaceTerminalActivity,
  createWorkspaceTerminalSession,
  streamWorkspaceTerminalSession,
  writeWorkspaceTerminalSession,
  resizeWorkspaceTerminalSession,
  interruptWorkspaceTerminalSession,
  closeWorkspaceTerminalSession,
  getPathForFile,
  importAttachment,
  getPluginsStatus,
  setPluginEnabled,
  setLocalPluginCodeAllowed,
  reloadPlugins,
  type ApprovalRequest,
  type AttachmentRef,
  type AgentProfileId,
  type HistoryMessage,
  type PermissionModeId,
  type PluginStatus,
  type PluginsStatusResponse,
  type ProjectMeta,
  type RuntimeState,
  type DataRootMigrationState,
  type DataRootStatus,
  type SessionMeta,
  type WorkspaceDirectory,
  type WorkspaceEntry,
  type WorkspacePreview,
  type WorkspaceArtifactRecord,
  type TerminalActivityRecord,
} from './api'
import { Settings } from './Settings'
import { ChannelConnections } from './ChannelConnections'
import { Markdown } from './Markdown'
import { TraceCard } from './TraceCard'
import { MemorySkills } from './MemorySkills'
import { MemoryTreeView } from './MemoryTreeView'
import { ArchiveManager } from './ArchiveManager'
import { buildTaskProgress } from './task-progress'
import {
  executionDisclosureDefaultOpen,
  executionDisclosureResetKey,
  verificationDisclosureDefaultOpen,
  verificationDisclosureResetKey,
} from './progressive-disclosure'
import type { HistoryActivity } from '../shared/history-activity'
import { projectSessions, standaloneSessions } from '../shared/session-scope'
import { ALL_PERMISSION_MODES } from '../shared/permission-modes'
import {
  SessionApprovalGrantStore,
  createDraftApprovalScopeKey,
  sessionApprovalScopeKey,
  type ApprovalDecision,
} from './approval-grants'
import {
  coerceReasoningForModelRef,
  getSupportedReasoningOptions,
  type RuntimeReasoning,
} from '../shared/model-capabilities'
import {
  buildContextUsage,
  buildContextUsageSnapshot,
  type ContextUsage,
  type ContextUsageSnapshot,
} from './context-usage'
import {
  DEFAULT_WORKSPACE_PANEL_TABS,
  WORKSPACE_FILE_DRAFTS_MAX_CHARS,
  WORKSPACE_PANEL_OPEN_TABS_MAX,
  alignWorkspacePanelStateToRoot,
  buildWorkspaceRecoverySnapshot,
  dedupeWorkspacePanelTabs,
  hydrateWorkspaceLayoutFallbackSnapshot,
  hydrateWorkspaceFileDrafts,
  hydrateWorkspacePanelTabs,
  isWorkspacePanelTab,
  normalizeWorkspacePanelTabId,
  parseWorkspaceFileTabId,
  rebindWorkspacePanelState,
  rebindWorkspacePath,
  serializeWorkspaceFileDrafts,
  shouldUseWorkspaceLayoutFallback,
  workspaceFileTabId,
  type WorkspaceFileDraftState,
  type WorkspaceFileTabId,
  type WorkspaceOpenRequest,
  type WorkspacePanelTab,
  type WorkspacePanelTabId,
} from './workspace-persistence'
import {
  isWorkspacePanelReopenHotzone,
  WORKSPACE_PANEL_WIDTH_DEFAULT,
  WORKSPACE_PANEL_WIDTH_MAX,
  WORKSPACE_PANEL_WIDTH_MIN,
  resolveWorkspacePanelDrag,
  resolveWorkspacePanelLayout,
  type WorkspacePanelDragMode,
} from './workspace-layout'
import {
  appendNavigationEntry,
  boundStringList,
  MAX_NAVIGATION_EXPANDED_PATHS,
  MAX_NAVIGATION_HISTORY_ENTRIES,
  MAX_NAVIGATION_OPEN_TABS,
  type NavigationHistoryState,
} from './navigation-history'

const MonacoEditor = lazy(async () => {
  const [monacoReact, monaco] = await Promise.all([
    import('@monaco-editor/react'),
    import('monaco-editor'),
  ])
  monacoReact.loader.config({ monaco })
  return { default: monacoReact.default }
})

type ModeRisk = 'low' | 'medium' | 'high' | 'critical'

const MODE_OPTIONS: Array<{
  id: PermissionModeId
  label: string
  desc: string
  risk: ModeRisk
  riskLabel: string
}> = ALL_PERMISSION_MODES.map((mode) => ({
  id: mode.id,
  label: mode.label,
  desc: mode.description,
  risk: mode.risk,
  riskLabel: mode.riskLabel,
}))

const PROFILE_OPTIONS: Array<{
  id: AgentProfileId
  label: string
  desc: string
}> = ALL_AGENT_PROFILES.map((profile) => ({
  id: profile.id,
  label: profile.label,
  desc: profile.description,
}))

const REASONING_OPTIONS: Array<{ id: RuntimeReasoning; label: string; desc: string }> = [
  { id: 'auto', label: '自动', desc: '由任务复杂度决定' },
  { id: 'low', label: '快速', desc: '优先速度，适合简单问答' },
  { id: 'medium', label: '标准', desc: '速度和稳妥性平衡' },
  { id: 'high', label: '深度', desc: '更充分地规划和验证' },
  { id: 'ultra', label: '超高', desc: '复杂任务使用最谨慎策略' },
]

const FLOATING_HELP_DELAY_MS = 500
const FLOATING_HELP_EXIT_MS = 150
const SIDEBAR_WIDTH_KEY = 'littlesheep.ui.sidebarWidth'
const SIDEBAR_COLLAPSED_KEY = 'littlesheep.ui.sidebarCollapsed'
const WORKSPACE_PANEL_WIDTH_KEY = 'littlesheep.ui.workspacePanelWidth'
const WORKSPACE_PANEL_COLLAPSED_KEY = 'littlesheep.ui.workspacePanelCollapsed'
const WORKSPACE_PANEL_FULLSCREEN_KEY = 'littlesheep.ui.workspacePanelFullscreen'
const WORKSPACE_PANEL_TAB_KEY = 'littlesheep.ui.workspacePanelTab'
const WORKSPACE_PANEL_OPEN_TABS_KEY = 'littlesheep.ui.workspacePanelOpenTabs'
const WORKSPACE_PANEL_OPEN_ROOT_KEY = 'littlesheep.ui.workspacePanelOpenRoot'
const WORKSPACE_PANEL_OPEN_PATH_KEY = 'littlesheep.ui.workspacePanelOpenPath'
const WORKSPACE_FILE_DRAFTS_KEY = 'littlesheep.ui.workspaceFileDrafts'
const WORKSPACE_FILE_NAVIGATOR_COLLAPSED_KEY = 'littlesheep.ui.workspaceFileNavigatorCollapsed'
const PINNED_SESSIONS_KEY = 'littlesheep.ui.pinnedSessions'
const PROJECT_SORT_KEY = 'littlesheep.ui.projectSort'
const ACTIVE_SESSION_KEY = 'littlesheep.ui.activeSession'
const SIDEBAR_WIDTH_DEFAULT = 276
const SIDEBAR_WIDTH_MIN = 220
const SIDEBAR_WIDTH_MAX = 460
const SIDEBAR_COLLAPSE_THRESHOLD = SIDEBAR_WIDTH_MIN / 2
const TWO_STAGE_RESIZE_MOTION_MS = 320
const SIDEBAR_SETTLE_ANIMATION_MS = TWO_STAGE_RESIZE_MOTION_MS
const WORKSPACE_PANEL_MOTION_MS = TWO_STAGE_RESIZE_MOTION_MS
const APPROVAL_PROMPT_MOTION_MS = 220
const COMPOSER_INPUT_MAX_HEIGHT = 220
const COMPOSER_INPUT_VIEWPORT_RATIO = 0.3
const PROJECT_CREATOR_MOTION_MS = 360
const COMPOSER_MENU_EVENT = 'littlesheep:composer-menu-open'
const SIDEBAR_MENU_EVENT = 'littlesheep:sidebar-menu-open'
const WORKSPACE_MENU_EVENT = 'littlesheep:workspace-menu-open'
const TRANSIENT_TRIGGER_ATTR = 'data-ls-transient-trigger'

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
  attachments?: AttachmentRef[]
  artifacts?: WorkspaceArtifactRef[]
  trace?: { name: string; ok: boolean }[]
  toolCalls?: { name: string; input: unknown; output?: unknown; error?: string; ok: boolean }[]
  durationMs?: number
  activity?: AssistantTurnActivity
  activityCollapsed?: boolean
}

interface LiveToolEvent {
  callId: string
  name: string
  stepId?: string
  startedAt?: number
  endedAt?: number
  input?: unknown
  ok?: boolean
  output?: string
  error?: string
}

type LiveStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

interface LiveStepEvent {
  stepId: string
  title: string
  description?: string
  status: LiveStepStatus
  startedAt?: number
  endedAt?: number
  output?: string
  error?: string
  toolCount: number
  activeTools: number
}

type AssistantTurnStatus = 'running' | 'done' | 'failed' | 'aborted'

interface AssistantTurnActivity extends Omit<HistoryActivity, 'status' | 'steps' | 'tools'> {
  status: AssistantTurnStatus
  steps: LiveStepEvent[]
  tools: LiveToolEvent[]
}

interface WorkspaceArtifactRef {
  path: string
  name: string
  action: 'created' | 'modified' | 'attached'
  toolName?: string
}

type WorkspaceActivityKind = 'agent' | 'artifact' | 'terminal'
type WorkspaceActivityKindFilter = 'all' | WorkspaceActivityKind

interface WorkspaceActivityFeedItem {
  id: string
  kind: WorkspaceActivityKind
  title: string
  detail: string
  timestamp: number
  status?: string
  artifact?: WorkspaceArtifactRef
}

const WORKSPACE_ACTIVITY_FILTERS: Array<{ id: WorkspaceActivityKindFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'agent', label: 'Agent' },
  { id: 'artifact', label: '产物' },
  { id: 'terminal', label: '终端' },
]

interface PendingApprovalPrompt {
  request: ApprovalRequest
  resolve: (decision: ApprovalDecision) => void
}

type SettingsPage = 'home' | 'agent' | 'api' | 'storage' | 'scheduled' | 'memoryTree' | 'archive' | 'plugins' | 'skills' | 'channels'
type DirectModulePage = Extract<SettingsPage, 'memoryTree' | 'scheduled' | 'plugins'>
type ProjectSortMode = 'fixed' | 'recent' | 'name'
type WorkspaceArtifactScopeFilter = 'project' | 'session'
type WorkspaceArtifactSourceFilter = 'all' | 'agent' | 'user'
type WorkspaceArtifactActionFilter = 'all' | WorkspaceArtifactRef['action']

type AppRoute =
  | { section: 'chat' }
  | { section: 'settings'; page: SettingsPage }
  | { section: 'module'; page: DirectModulePage }

type SidebarPanel = 'search' | null
type StringListUpdater = (current: string[]) => string[]

interface AppNavigationSnapshot {
  route: AppRoute
  sidebarCollapsed: boolean
  sidebarWidth: number
  conversationCollapsed: boolean
  sidebarPanel: SidebarPanel
  workspacePanelCollapsed: boolean
  workspacePanelFullscreen: boolean
  workspacePanelWidth: number
  workspacePanelTab: WorkspacePanelTabId
  workspacePanelOpenTabs: WorkspacePanelTabId[]
  workspaceOpenRequest: { root: string; path: string } | null
  workspaceFileNavigatorCollapsed: boolean
  workspaceExpandedPaths: string[]
}

interface SettingsNavItem {
  page: SettingsPage
  title: string
  desc: string
}

interface SettingsNavGroup {
  title: string
  items: SettingsNavItem[]
}

const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    title: '通用',
    items: [
      { page: 'home', title: '总览', desc: '系统状态与基础入口' },
      { page: 'agent', title: 'Agent 行为', desc: '通用与编程两套系统提示词' },
      { page: 'api', title: '模型供应商', desc: 'API 密钥与可用模型' },
      { page: 'storage', title: '存储与数据', desc: '数据位置、迁移与回滚' },
    ],
  },
  {
    title: '工作',
    items: [
      { page: 'scheduled', title: '已安排', desc: '计划任务与自动执行' },
      { page: 'archive', title: '归档', desc: '归档项目和对话管理' },
    ],
  },
  {
    title: '记忆',
    items: [
      { page: 'memoryTree', title: '记忆树', desc: '长期记忆、项目分支和每日召回' },
    ],
  },
  {
    title: '扩展',
    items: [
      { page: 'plugins', title: '插件', desc: '本地插件与工具连接' },
      { page: 'skills', title: '技能', desc: '本地技能、工具说明和可复用能力' },
    ],
  },
  {
    title: '连接',
    items: [
      { page: 'channels', title: '外部渠道', desc: '通讯渠道连接与重新加载' },
    ],
  },
]

export function App() {
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
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const composerSyncFrameRef = useRef<number>()
  const activeDragCleanupRef = useRef<(() => void) | null>(null)
  const sidebarSettleFrameRef = useRef<number>()
  const sidebarSettleTimerRef = useRef<number>()
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
  const workspaceLayoutFallbackNeededRef = useRef(shouldUseWorkspaceLayoutFallback(readWorkspaceLayoutFallbackMarkers()))
  const workspaceLayoutMirrorReadyRef = useRef(false)
  const [activityNow, setActivityNow] = useState(() => Date.now())
  const liveToolStepRef = useRef(new Map<string, string>())
  const [contextUsageSnapshot, setContextUsageSnapshot] = useState<ContextUsageSnapshot | null>(null)
  const [workspaceArtifactVersion, setWorkspaceArtifactVersion] = useState(0)
  const [workspaceLayoutMirrorReady, setWorkspaceLayoutMirrorReady] = useState(false)
  const [controlTip, setControlTip] = useState<FloatingHelpTip | null>(null)
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalPrompt | null>(null)
  const pendingApprovalRef = useRef<PendingApprovalPrompt | null>(null)
  const approvalGrantsRef = useRef(new SessionApprovalGrantStore())
  const draftApprovalScopeRef = useRef(createDraftApprovalScopeKey())
  const [settingsEntryRippling, setSettingsEntryRippling] = useState(false)
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
      window.cancelAnimationFrame(composerSyncFrameRef.current ?? 0)
      window.cancelAnimationFrame(sidebarSettleFrameRef.current ?? 0)
      window.clearTimeout(sidebarSettleTimerRef.current)
      activeDragCleanupRef.current?.()
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

  return (
    <div
      ref={shellRef}
      className={[
        'window-shell',
        sidebarCollapsed ? 'sidebar-collapsed' : '',
        workspacePanelCollapsed ? 'workspace-panel-collapsed' : '',
        workspacePanelFullscreen ? 'workspace-panel-fullscreen' : '',
        directModulePage ? 'direct-module-open' : '',
        settingsOpen ? 'settings-open' : '',
      ].filter(Boolean).join(' ')}
      style={layoutStyle}
    >
      <div className="primary-workspace" aria-hidden={settingsOpen} {...(settingsOpen ? { inert: '' } : {})}>
      <GlobalTitlebar
        sidebarCollapsed={sidebarCollapsed}
        sidebarToggleTip={sidebarToggleTip}
        canNavigateBack={canNavigateBack}
        canNavigateForward={canNavigateForward}
        onToggleSidebar={toggleSidebar}
        onBack={navigateBack}
        onForward={navigateForward}
        onTipChange={setControlTip}
      />
      <div className="app">
      <aside className="sidebar" aria-hidden={sidebarCollapsed} {...(sidebarCollapsed ? { inert: '' } : {})}>
        <div className="sidebar-contents">
        <div className="brand-block">
          <div className="brand-title">LittleSheep</div>
          <div className="brand-subtitle">本地 Agent 工作台</div>
        </div>
        <SidebarQuickNav
          activePanel={sidebarPanel}
          activeModule={directModulePage}
          onNewConversation={createConversationFromSidebar}
          onOpenPanel={openSidebarPanel}
          onOpenModulePage={openDirectModulePage}
          onTipChange={setControlTip}
        />
        <SidebarProjectSection
          projects={projects}
          sessions={displayedSessions}
          currentSession={currentSession}
          pinnedSessionIds={pinnedSessionIds}
          now={now}
          activeProjectId={sessionOwnership.scope === 'project' ? sessionOwnership.projectId : undefined}
          fallbackPath={projectPath}
          onOpenProject={(project) => void activateProjectWorkspace(project)}
          onOpenWorkspace={openProjectCreator}
          onOpenSession={(session) => void switchSession(session)}
          onTogglePin={togglePinnedSession}
          onArchiveSession={archiveSession}
          onDeleteSession={deleteSessionPermanently}
          onArchiveProject={(project) => void archiveProject(project)}
          onRebindProject={(project) => void relocateProject(project)}
          onDeleteProject={(project) => void deleteProjectPermanently(project)}
          onTipChange={setControlTip}
        />
        <section
          className={`sidebar-section conversation-section ${conversationCollapsed ? 'collapsed' : ''}`}
          aria-label="对话"
        >
          <div className="sidebar-section-header">
            <button
              className="sidebar-section-toggle"
              type="button"
              aria-expanded={!conversationCollapsed}
              onClick={() => setConversationCollapsed((value) => !value)}
            >
              <span>对话</span>
              <span className="sidebar-section-arrow" aria-hidden="true" />
            </button>
            <div className="sidebar-section-actions" aria-hidden={conversationCollapsed ? undefined : false}>
              <SidebarActionMenu
                label={moreConversationTip}
                onTipChange={setControlTip}
                items={[
                  {
                    label: '归档所有对话',
                    icon: <ArchiveIcon />,
                    onSelect: archiveAllSessions,
                  },
                ]}
              >
                <MoreIcon />
              </SidebarActionMenu>
              <button
                className="sidebar-section-action sidebar-new-action"
                type="button"
                aria-label={newConversationTip}
                onClick={createConversationFromSidebar}
                onMouseEnter={(event) => setControlTip(buildFloatingHelpTip(newConversationTip, event.clientX, event.clientY))}
                onMouseMove={(event) => setControlTip(buildFloatingHelpTip(newConversationTip, event.clientX, event.clientY))}
                onMouseLeave={() => setControlTip(null)}
                onFocus={(event) => setControlTip(buildFloatingHelpTipFromElement(newConversationTip, event.currentTarget))}
                onBlur={() => setControlTip(null)}
              >
                <ComposeIcon />
              </button>
            </div>
          </div>
          <div className="session-list">
            {visibleSessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === currentSession}
                pinned={pinnedSessionIds.has(s.id)}
                now={now}
                itemRef={visibleSessionMotionRef(s.id)}
                onOpen={() => void switchSession(s)}
                onTogglePin={() => togglePinnedSession(s.id)}
                onArchive={() => archiveSession(s.id)}
                onDelete={() => deleteSessionPermanently(s.id)}
                onTipChange={setControlTip}
              />
            ))}
          </div>
        </section>
        <div className="sidebar-footer">
          <button
          className={`settings-entry-btn ${settingsEntryRippling ? 'rippling' : ''}`}
          type="button"
          onMouseDown={() => {
            if (settingsOpen) closeSettingsFromEntry()
            else openSettingsFromEntry()
          }}
          aria-label="设置"
          aria-expanded={settingsOpen}
          >
            <SettingsGearIcon />
            <span className="settings-entry-label">设置</span>
          </button>
        </div>
        </div>
      </aside>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-hidden={sidebarCollapsed}
        aria-label="调整会话栏宽度"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={sidebarCollapsed ? -1 : 0}
        onPointerDown={beginSidebarResize}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            nudgeSidebar(event.shiftKey ? -32 : -12)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            nudgeSidebar(event.shiftKey ? 32 : 12)
          } else if (event.key === 'Home') {
            event.preventDefault()
            setSidebarWidth(SIDEBAR_WIDTH_MIN)
          } else if (event.key === 'End') {
            event.preventDefault()
            setSidebarWidth(SIDEBAR_WIDTH_MAX)
          }
        }}
      />
      <section
        className="core-workspace"
        aria-label="核心工作区"
        onPointerMove={updateWorkspacePanelReopenPresence}
        onPointerLeave={() => setWorkspacePanelReopenActive(false)}
      >
      {directModulePage ? (
        <DirectModuleWorkspace page={directModulePage} />
      ) : (
      <>
      <main className="chat">
        <div className={`messages ${messages.length === 0 ? 'is-empty' : ''}`} ref={scrollRef}>
          {messages.length === 0 && (
            <div className="empty-hint">
              <div className="empty-title">今天要推进什么？</div>
              <div className="empty-copy">选择模型、推理强度和工作目录后，直接交给 LittleSheep。</div>
            </div>
          )}
          {messages.map((m, i) => (
            m.role === 'assistant' && m.activity ? (
              <AssistantTurnMessage
                key={i}
                message={m}
                now={activityNow}
                onOpenFile={openFileInWorkspace}
                onToggleActivity={() => {
                  setMessages((items) => items.map((item, index) =>
                    index === i ? { ...item, activityCollapsed: !item.activityCollapsed } : item,
                  ))
                }}
              />
            ) : (
              <div key={i} className={`message ${m.role}`}>
                {m.text ? <Markdown text={m.text} /> : <span className="loading">思考中...</span>}
                {m.role === 'user' && m.attachments && m.attachments.length > 0 && (
                  <MessageFileStrip
                    files={m.attachments.map(attachmentToArtifact)}
                    label="附件"
                    onOpenFile={openFileInWorkspace}
                  />
                )}
                {m.role === 'assistant' && (m.trace || m.toolCalls) && (
                  <TraceCard trace={m.trace} toolCalls={m.toolCalls} durationMs={m.durationMs} onOpenFile={openFileInWorkspace} />
                )}
                {m.role === 'assistant' && m.artifacts && m.artifacts.length > 0 && (
                  <MessageFileStrip files={m.artifacts} label="产物" onOpenFile={openFileInWorkspace} />
                )}
              </div>
            )
          ))}
        </div>

        <section className="composer-shell">
          <TaskProgressPresence activity={latestTaskActivity} now={activityNow} />
          <div
            className={`composer ${dragActive ? 'drag-active' : ''}`}
            onDragEnter={handleComposerDragEnter}
            onDragOver={handleComposerDragOver}
            onDragLeave={handleComposerDragLeave}
            onDrop={handleComposerDrop}
          >
            {attachments.length > 0 && (
              <div className="attachment-preview-grid">
                {attachments.map((file) => (
                  <AttachmentPreviewCard
                    key={file.path}
                    file={file}
                    onOpen={() => openFileInWorkspace(file.path)}
                    onRemove={() => {
                      setControlTip(null)
                      setAttachments((prev) => prev.filter((item) => item.path !== file.path))
                    }}
                    onTipChange={setControlTip}
                  />
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={handleComposerPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder="给 LittleSheep 一个任务，或上传文件后直接发送"
              rows={1}
            />
            <div className="composer-controls">
              <div className="composer-left">
                <AddMenu
                  label={uploadTip}
                  onAddFiles={addAttachments}
                  onChooseWorkspace={chooseWorkspace}
                  onTipChange={setControlTip}
                />
                <ModePicker value={permissionMode} onChange={setPermissionMode} />
                {runtime && !workspaceIsWorkplace && (
                  <WorkspaceChip
                    path={runtime.workspace}
                    tip={workspaceTip}
                    onReset={resetWorkspace}
                    onTipChange={setControlTip}
                  />
                )}
              </div>
              <div className="composer-right">
                <ContextUsageIndicator usage={contextUsage} />
                <RuntimePicker
                  runtime={runtime}
                  providers={selectableProviders}
                  selected={selectedModel}
                  onModelChange={(model) => {
                    void applyRuntimePatch({
                      model,
                      reasoning: coerceReasoningForModelRef(runtime?.reasoning ?? 'auto', model),
                    })
                  }}
                  onReasoningChange={(reasoning) => void applyRuntimePatch({ reasoning })}
                />
                <button
                  className={`send-round ${loading ? 'stop' : ''}`}
                  onClick={() => {
                    setControlTip(null)
                    if (loading) {
                      stop()
                    } else {
                      void send()
                    }
                  }}
                  disabled={!loading && !input.trim() && attachments.length === 0}
                  aria-label={sendTip}
                  onMouseEnter={(event) => setControlTip(buildFloatingHelpTip(sendTip, event.clientX, event.clientY))}
                  onMouseMove={(event) => setControlTip(buildFloatingHelpTip(sendTip, event.clientX, event.clientY))}
                  onMouseLeave={() => setControlTip(null)}
                  onFocus={(event) => setControlTip(buildFloatingHelpTipFromElement(sendTip, event.currentTarget))}
                  onBlur={() => setControlTip(null)}
                >
                  {loading ? <StopRunIcon /> : <SendRunIcon />}
                </button>
              </div>
            </div>
          </div>
          {runtimeError && <div className="composer-error">{runtimeError}</div>}
        </section>
      </main>
      <div
        className="workspace-panel-resizer"
        role="separator"
        aria-hidden={workspacePanelCollapsed || workspacePanelFullscreen}
        aria-label="调整拓展工作区宽度"
        aria-orientation="vertical"
        aria-valuemin={WORKSPACE_PANEL_WIDTH_MIN}
        aria-valuemax={workspacePanelLayout.maxSplitWidth}
        aria-valuenow={Math.round(workspacePanelLayout.width)}
        tabIndex={workspacePanelCollapsed || workspacePanelFullscreen ? -1 : 0}
        onPointerDown={beginWorkspacePanelResize}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            nudgeWorkspacePanel(event.shiftKey ? 32 : 12)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            nudgeWorkspacePanel(event.shiftKey ? -32 : -12)
          } else if (event.key === 'Home') {
            event.preventDefault()
            setWorkspacePanelWidth(WORKSPACE_PANEL_WIDTH_MIN)
          } else if (event.key === 'End') {
            event.preventDefault()
            setWorkspacePanelWidth(workspacePanelLayout.maxSplitWidth)
          }
        }}
      />
      <WorkspacePanel
        collapsed={workspacePanelCollapsed}
        fullscreen={workspacePanelFullscreen}
        activeTab={workspacePanelTab}
        openTabs={workspacePanelOpenTabs}
        messages={messages}
        workspacePath={workspacePanelRoot}
        defaultWorkspacePath={defaultWorkspacePath}
        usingTemporaryRoot={workspacePanelUsingTemporaryRoot}
        workplacePath={runtime?.workplace ?? projectPath}
        openRequest={workspaceOpenRequest}
        sessionId={currentSession}
        sessionTitle={currentSession ? sessions.find((session) => session.id === currentSession)?.title : undefined}
        artifactVersion={workspaceArtifactVersion}
        fileDrafts={workspaceFileDrafts}
        fileNavigatorCollapsed={workspaceFileNavigatorCollapsed}
        expandedPaths={workspaceExpandedPaths}
        onTabChange={openWorkspacePanelTab}
        onCloseTab={closeWorkspacePanelTab}
        onFileDraftChange={updateWorkspaceFileDraft}
        onToggleCollapsed={toggleWorkspacePanel}
        onToggleFullscreen={toggleWorkspacePanelFullscreen}
        onRememberOpenPath={(root, path) => setWorkspaceOpenRequest({ id: Date.now(), root, path })}
        onReturnToDefaultWorkspace={() => setWorkspaceOpenRequest(null)}
        onRequestFileSaveApproval={requestWorkspaceSaveApproval}
        onRequestCommandApproval={requestWorkspaceCommandApproval}
        onWorkspaceArtifactsChanged={() => setWorkspaceArtifactVersion((value) => value + 1)}
        onFileNavigatorCollapsedChange={setWorkspaceFileNavigatorCollapsed}
        onExpandedPathsChange={(update) => setWorkspaceExpandedPaths((paths) =>
          boundStringList(update(paths), MAX_NAVIGATION_EXPANDED_PATHS),
        )}
        onOpenFile={openFileInWorkspace}
        onTipChange={setControlTip}
      />
      <button
        {...transientTriggerProps()}
        className={`workspace-panel-reopen-target ${workspacePanelReopenActive ? 'reopen-visible' : ''}`}
        type="button"
        aria-label="打开拓展工作区"
        aria-expanded={!workspacePanelCollapsed}
        aria-hidden={!workspacePanelCollapsed}
        tabIndex={workspacePanelCollapsed ? 0 : -1}
        onClick={toggleWorkspacePanel}
        onFocus={() => setWorkspacePanelReopenActive(true)}
        onBlur={() => setWorkspacePanelReopenActive(false)}
      >
        <span className="workspace-panel-reopen-label" aria-hidden="true">打开拓展工作区</span>
        <span className="workspace-panel-reopen-icon" aria-hidden="true">
          <WorkspacePanelIcon collapsed />
        </span>
      </button>
      </>
      )}
      <SidebarFeaturePanel
        panel={sidebarPanel}
        search={sidebarSearch}
        sessions={visibleSessions}
        currentSession={currentSession}
        now={now}
        onSearchChange={setSidebarSearch}
        onClose={closeSidebarPanel}
        onOpenSession={(session) => void switchSession(session)}
      />
      </section>
      </div>
      </div>
      <FadePresence show={settingsOpen} exitMs={790}>
        <SettingsWorkspace
          page={settingsPage}
          runtime={runtime}
          sidebarCollapsed={sidebarCollapsed}
          sidebarWidth={sidebarWidth}
          sidebarToggleTip={sidebarToggleTip}
          canBack={canNavigateBack}
          canForward={canNavigateForward}
          onBeginSidebarResize={beginSidebarResize}
          onNudgeSidebar={nudgeSidebar}
          onSetSidebarWidth={setSidebarWidth}
          onToggleSidebar={toggleSidebar}
          onBack={navigateBack}
          onForward={navigateForward}
          onClose={closeSettingsFromEntry}
          settingsEntryRippling={settingsEntryRippling}
          onOpenPage={openSettingsPage}
          onProfileChange={(profile) => void applyRuntimePatch({ profile })}
          onContextCompressionThresholdChange={(ratio) => applyRuntimePatch({ contextCompressionThresholdRatio: ratio })}
          onArchiveChanged={() => {
            void refreshProjects()
            void refreshSessions()
          }}
          onTipChange={setControlTip}
        />
        <div className="settings-transition-edge" aria-hidden="true" />
        <SettingsEntryBridge
          settingsOpen={settingsOpen}
          onOpen={openSettingsFromEntry}
          onClose={closeSettingsFromEntry}
          rippling={settingsEntryRippling}
        />
      </FadePresence>
      <ProjectCreatorDialog
        show={projectCreatorOpen}
        defaultParentPath={runtime?.workspace ?? runtime?.workplace ?? ''}
        onClose={() => setProjectCreatorOpen(false)}
        onChooseExisting={chooseProjectFolder}
        onChooseParent={selectWorkspace}
        onCreateNew={createProjectInFolder}
      />
      <DirtyFileClosePrompt
        file={pendingDirtyCloseTab ? parseWorkspaceFileTabId(pendingDirtyCloseTab) : null}
        onCancel={() => setPendingDirtyCloseTab(null)}
        onConfirm={() => {
          const tab = pendingDirtyCloseTab
          setPendingDirtyCloseTab(null)
          if (tab) closeWorkspacePanelTab(tab, { force: true })
        }}
      />
      <ApprovalPrompt prompt={pendingApproval} onResolve={settleApprovalPrompt} />
      <FloatingHelpTooltip tip={controlTip} />
    </div>
  )
}

function WorkspacePanel({
  collapsed,
  fullscreen,
  activeTab,
  openTabs,
  messages,
  workspacePath,
  defaultWorkspacePath,
  usingTemporaryRoot,
  workplacePath,
  openRequest,
  sessionId,
  sessionTitle,
  artifactVersion,
  fileDrafts,
  fileNavigatorCollapsed,
  expandedPaths,
  onTabChange,
  onCloseTab,
  onFileDraftChange,
  onToggleCollapsed,
  onToggleFullscreen,
  onRememberOpenPath,
  onReturnToDefaultWorkspace,
  onRequestFileSaveApproval,
  onRequestCommandApproval,
  onWorkspaceArtifactsChanged,
  onFileNavigatorCollapsedChange,
  onExpandedPathsChange,
  onOpenFile,
  onTipChange,
}: {
  collapsed: boolean
  fullscreen: boolean
  activeTab: WorkspacePanelTabId
  openTabs: WorkspacePanelTabId[]
  messages: ChatMessage[]
  workspacePath: string
  defaultWorkspacePath: string
  usingTemporaryRoot: boolean
  workplacePath: string
  openRequest: WorkspaceOpenRequest | null
  sessionId?: string
  sessionTitle?: string
  artifactVersion: number
  fileDrafts: Record<string, WorkspaceFileDraftState>
  fileNavigatorCollapsed: boolean
  expandedPaths: string[]
  onTabChange: (tab: WorkspacePanelTabId) => void
  onCloseTab: (tab: WorkspacePanelTabId) => void
  onFileDraftChange: (tab: WorkspaceFileTabId, draft: WorkspaceFileDraftState | null) => void
  onToggleCollapsed: () => void
  onToggleFullscreen: () => void
  onRememberOpenPath: (root: string, path: string) => void
  onReturnToDefaultWorkspace: () => void
  onRequestFileSaveApproval: (detail: unknown) => Promise<boolean>
  onRequestCommandApproval: (detail: unknown) => Promise<boolean>
  onWorkspaceArtifactsChanged: () => void
  onFileNavigatorCollapsedChange: (collapsed: boolean) => void
  onExpandedPathsChange: (update: StringListUpdater) => void
  onOpenFile: (path: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const workspaceEntries: Array<{
    id: WorkspacePanelTab
    label: string
    desc: string
    shortcut?: string
  }> = [
    { id: 'review', label: '审查', desc: '当前工作现场、任务阶段和产物入口', shortcut: 'Ctrl+Shift+G' },
    { id: 'artifacts', label: '产物', desc: '按项目、来源和类型管理生成或保存的文件', shortcut: 'Ctrl+Shift+A' },
    { id: 'terminal', label: '终端', desc: 'LS 内置 PowerShell，命令执行受权限控制' },
    { id: 'browser', label: '浏览器', desc: '后续接入网页预览和网页操作现场', shortcut: 'Ctrl+T' },
    { id: 'sideChat', label: '侧边聊天', desc: '后续承载与当前文件或产物相关的局部对话', shortcut: 'Ctrl+Alt+S' },
  ]
  const fallbackEntry: typeof workspaceEntries[number] = {
    id: 'review',
    label: '审查',
    desc: '当前工作现场、任务阶段和产物入口',
    shortcut: 'Ctrl+Shift+G',
  }
  const workspaceEntryById = new Map(workspaceEntries.map((entry) => [entry.id, entry]))
  const activeFileTab = parseWorkspaceFileTabId(activeTab)
  const activeEntry = activeFileTab
    ? {
      id: activeTab,
      label: lastPathSegment(activeFileTab.path),
      desc: activeFileTab.path,
      shortcut: undefined,
      kind: 'file' as const,
      dirty: Boolean(fileDrafts[activeTab]?.editorText !== fileDrafts[activeTab]?.savedText),
    }
    : { ...(isWorkspacePanelTab(activeTab) ? workspaceEntryById.get(activeTab) ?? fallbackEntry : fallbackEntry), kind: 'feature' as const, dirty: false }
  const visibleTabs = openTabs
    .map((tab) => {
      const fileTab = parseWorkspaceFileTabId(tab)
      if (fileTab) {
        return {
          id: tab,
          label: lastPathSegment(fileTab.path),
          desc: fileTab.path,
          shortcut: undefined,
          kind: 'file' as const,
          dirty: Boolean(fileDrafts[tab]?.editorText !== fileDrafts[tab]?.savedText),
        }
      }
      const entry = isWorkspacePanelTab(tab) ? workspaceEntryById.get(tab) : undefined
      return entry ? { ...entry, kind: 'feature' as const, dirty: false } : null
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  const displayedTabs = visibleTabs.length > 0 ? visibleTabs : [activeEntry]
  const fullscreenTip = fullscreen ? '退出全屏工作区' : '全屏展开工作区'
  const workspaceIsDefault = isSamePath(workspacePath, workplacePath)

  return (
    <aside
      className={`workspace-panel ${collapsed ? 'collapsed' : ''} ${fullscreen ? 'fullscreen' : ''}`}
      aria-label="拓展工作区"
    >
      <div className="workspace-panel-contents" {...(collapsed ? { inert: '' } : {})}>
        <header className="workspace-panel-header">
          <div className="workspace-panel-topbar">
            <div className="workspace-tab-strip" role="tablist" aria-label="拓展功能区">
              {displayedTabs.map((entry) => {
                const active = entry.id === activeTab
                return (
                  <div
                    key={entry.id}
                    className={`workspace-active-item ${active ? 'active' : ''} ${entry.kind === 'file' && entry.dirty ? 'file-dirty' : ''}`}
                    role="tab"
                    tabIndex={0}
                    aria-selected={active}
                    onClick={() => onTabChange(entry.id)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      onTabChange(entry.id)
                    }}
                    onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))}
                    onMouseMove={(event) => onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))}
                    onMouseLeave={() => onTipChange(null)}
                    onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(entry.desc, event.currentTarget))}
                    onBlur={() => onTipChange(null)}
                  >
                    {entry.kind === 'file' ? <FileGlyphIcon /> : <WorkspaceFeatureIcon id={entry.id} />}
                    <span className="workspace-active-label">{entry.label}</span>
                    <button
                      {...transientTriggerProps()}
                      className="workspace-active-close"
                      type="button"
                      aria-label={`关闭${entry.label}标签`}
                      onClick={(event) => {
                        event.stopPropagation()
                        onCloseTab(entry.id)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        event.stopPropagation()
                        onCloseTab(entry.id)
                      }}
                    >
                      <CloseMiniIcon />
                    </button>
                  </div>
                )
              })}
              <WorkspaceAddMenu
                entries={workspaceEntries}
                activeTab={isWorkspacePanelTab(activeTab) ? activeTab : 'review'}
                openTabs={displayedTabs.map((entry) => entry.id).filter(isWorkspacePanelTab)}
                onSelect={onTabChange}
                onTipChange={onTipChange}
              />
            </div>
            <div className="workspace-context-line">
              {workspaceIsDefault ? '默认工作区' : '目标工作区'}
            </div>
          </div>
          <div className="workspace-panel-actions">
            <button
              {...transientTriggerProps()}
              className="workspace-panel-action"
              type="button"
              aria-label={fullscreenTip}
              aria-pressed={fullscreen}
              onClick={onToggleFullscreen}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(fullscreenTip, event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip(fullscreenTip, event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(fullscreenTip, event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <PanelFullscreenIcon active={fullscreen} />
            </button>
            <button
              {...transientTriggerProps()}
              className="workspace-panel-action"
              type="button"
              aria-label="收起拓展工作区"
              onClick={onToggleCollapsed}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('收起拓展工作区', event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip('收起拓展工作区', event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('收起拓展工作区', event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <PanelCollapseIcon />
            </button>
          </div>
        </header>
        <div className="workspace-panel-body">
          <div
            key={activeEntry.id}
            className={`workspace-panel-view content-fade ${!activeFileTab && activeTab !== 'files' ? 'with-file-navigator' : ''}`}
          >
            {activeTab === 'review' && (
              <WorkspaceOverview
                workspacePath={workspacePath}
                workplacePath={workplacePath}
                activeTab={activeTab}
                activeTabLabel={activeEntry.label}
                openTabs={openTabs}
                openRequest={openRequest}
                sessionId={sessionId}
                sessionTitle={sessionTitle}
                messages={messages}
                artifactVersion={artifactVersion}
                fileDrafts={fileDrafts}
                onOpenFile={onOpenFile}
              />
            )}
            {activeTab === 'files' && (
              <WorkspaceFiles
                workspacePath={workspacePath}
                defaultWorkspacePath={defaultWorkspacePath}
                usingTemporaryRoot={usingTemporaryRoot}
                navigatorCollapsed={fileNavigatorCollapsed}
                expandedPaths={expandedPaths}
                openRequest={openRequest}
                sessionId={sessionId}
                onRememberOpenPath={onRememberOpenPath}
                onReturnToDefaultWorkspace={onReturnToDefaultWorkspace}
                onRequestFileSaveApproval={onRequestFileSaveApproval}
                onWorkspaceArtifactsChanged={onWorkspaceArtifactsChanged}
                onNavigatorCollapsedChange={onFileNavigatorCollapsedChange}
                onExpandedPathsChange={onExpandedPathsChange}
                onOpenFileTab={(root, path) => {
                  onRememberOpenPath(root, path)
                  onTabChange(workspaceFileTabId(root, path))
                }}
                onTipChange={onTipChange}
              />
            )}
            {activeTab === 'artifacts' && (
              <WorkspaceArtifacts
                workspacePath={workspacePath}
                sessionId={sessionId}
                artifactVersion={artifactVersion}
                onOpenFile={onOpenFile}
                onTipChange={onTipChange}
              />
            )}
            {activeFileTab && (
              <div className="workspace-files">
                <WorkspaceFileView
                  tabId={activeTab as WorkspaceFileTabId}
                  root={activeFileTab.root}
                  path={activeFileTab.path}
                  sessionId={sessionId}
                  draft={fileDrafts[activeTab]}
                  onDraftChange={onFileDraftChange}
                  onRequestFileSaveApproval={onRequestFileSaveApproval}
                  onWorkspaceArtifactsChanged={onWorkspaceArtifactsChanged}
                  onTipChange={onTipChange}
                />
                <WorkspaceFileNavigator
                  workspacePath={activeFileTab.root}
                  defaultWorkspacePath={defaultWorkspacePath}
                  usingTemporaryRoot={!isSamePath(activeFileTab.root, defaultWorkspacePath)}
                  navigatorCollapsed={fileNavigatorCollapsed}
                  expandedPaths={expandedPaths}
                  selectedPath={activeFileTab.path}
                  onOpenFileTab={(root, path) => {
                    onRememberOpenPath(root, path)
                    onTabChange(workspaceFileTabId(root, path))
                  }}
                  onReturnToDefaultWorkspace={() => {
                    onReturnToDefaultWorkspace()
                    onTabChange('review')
                  }}
                  onNavigatorCollapsedChange={onFileNavigatorCollapsedChange}
                  onExpandedPathsChange={onExpandedPathsChange}
                  onTipChange={onTipChange}
                />
              </div>
            )}
            {activeTab === 'terminal' && (
              <WorkspaceTerminal
                workspacePath={workspacePath}
                sessionId={sessionId}
                onRequestCommandApproval={onRequestCommandApproval}
                onTipChange={onTipChange}
              />
            )}
            {activeTab === 'browser' && (
              <WorkspacePlaceholder
                title="浏览器"
                text="后续会接入网页预览和网页操作现场，用于资料检索、页面检查和工具产物查看。"
              />
            )}
            {activeTab === 'sideChat' && (
              <WorkspacePlaceholder
                title="侧边聊天"
                text="后续会承载与当前文件、命令或产物绑定的局部对话，不挤占主对话区。"
              />
            )}
          </div>
          {!activeFileTab && activeTab !== 'files' && (
            <WorkspaceFileNavigator
              workspacePath={workspacePath}
              defaultWorkspacePath={defaultWorkspacePath}
              usingTemporaryRoot={usingTemporaryRoot}
              navigatorCollapsed={fileNavigatorCollapsed}
              expandedPaths={expandedPaths}
              selectedPath={openRequest?.root === workspacePath ? openRequest.path : ''}
              onOpenFileTab={(root, path) => {
                onRememberOpenPath(root, path)
                onTabChange(workspaceFileTabId(root, path))
              }}
              onReturnToDefaultWorkspace={onReturnToDefaultWorkspace}
              onNavigatorCollapsedChange={onFileNavigatorCollapsedChange}
              onExpandedPathsChange={onExpandedPathsChange}
              onTipChange={onTipChange}
            />
          )}
        </div>
      </div>
    </aside>
  )
}

function WorkspaceAddMenu({
  entries,
  activeTab,
  openTabs,
  onSelect,
  onTipChange,
}: {
  entries: Array<{ id: WorkspacePanelTab; label: string; desc: string; shortcut?: string }>
  activeTab: WorkspacePanelTab
  openTabs: WorkspacePanelTab[]
  onSelect: (tab: WorkspacePanelTab) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number>()
  const frameRef = useRef<number>()
  const menuIdRef = useRef(`workspace-menu-${Math.random().toString(36).slice(2)}`)

  function syncPosition() {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 10
    const panelWidth = panelRef.current?.offsetWidth || 352
    const panelHeight = panelRef.current?.offsetHeight || entries.length * 36 + 16
    const x = clampNumber(rect.left, margin, window.innerWidth - panelWidth - margin)
    const below = rect.bottom + 5
    const y = below + panelHeight > window.innerHeight - margin
      ? Math.max(margin, rect.top - panelHeight - 5)
      : below
    setPosition({ x, y })
  }

  function openMenu() {
    window.clearTimeout(closeTimerRef.current)
    window.dispatchEvent(new CustomEvent(WORKSPACE_MENU_EVENT, { detail: menuIdRef.current }))
    setMounted(true)
    frameRef.current = window.requestAnimationFrame(() => {
      syncPosition()
      setOpen(true)
    })
  }

  function closeMenu() {
    setOpen(false)
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => setMounted(false), 170)
  }

  function selectEntry(tab: WorkspacePanelTab) {
    onTipChange(null)
    onSelect(tab)
    closeMenu()
  }

  useDismissOnOutside(mounted, [rootRef, panelRef], closeMenu)

  useEffect(() => {
    const handleWorkspaceMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== menuIdRef.current) closeMenu()
    }
    window.addEventListener(WORKSPACE_MENU_EVENT, handleWorkspaceMenuOpen)
    return () => window.removeEventListener(WORKSPACE_MENU_EVENT, handleWorkspaceMenuOpen)
  }, [])

  useEffect(() => {
    if (!mounted) return
    const handleReposition = () => syncPosition()
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [mounted])

  useLayoutEffect(() => {
    if (mounted) syncPosition()
  }, [mounted, entries.length])

  useEffect(() => () => {
    window.clearTimeout(closeTimerRef.current)
    window.cancelAnimationFrame(frameRef.current ?? 0)
  }, [])

  return (
    <div ref={rootRef} className={`workspace-add-menu ${open ? 'open' : ''}`}>
      <button
        {...transientTriggerProps()}
        ref={triggerRef}
        className="workspace-add-trigger"
        type="button"
        aria-label="打开拓展功能菜单"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          onTipChange(null)
          if (open) closeMenu()
          else openMenu()
        }}
        onMouseEnter={(event) => {
          if (!open) onTipChange(buildFloatingHelpTip('打开拓展功能菜单', event.clientX, event.clientY))
        }}
        onMouseMove={(event) => {
          if (!open) onTipChange(buildFloatingHelpTip('打开拓展功能菜单', event.clientX, event.clientY))
        }}
        onMouseLeave={() => onTipChange(null)}
        onFocus={(event) => {
          if (!open) onTipChange(buildFloatingHelpTipFromElement('打开拓展功能菜单', event.currentTarget))
        }}
        onBlur={() => onTipChange(null)}
      >
        <span aria-hidden="true">+</span>
      </button>
      {mounted && createPortal(
        <div
          ref={panelRef}
          className={`workspace-add-panel ${open ? 'visible' : ''}`}
          role="menu"
          aria-label="拓展功能菜单"
          style={{ left: position.x, top: position.y }}
        >
          {entries.map((entry) => {
            const active = entry.id === activeTab
            const opened = openTabs.includes(entry.id)
            return (
              <button
                key={entry.id}
                className={`workspace-add-item ${active ? 'active' : ''} ${opened ? 'opened' : ''}`}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => selectEntry(entry.id)}
                onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))}
                onMouseMove={(event) => onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))}
                onMouseLeave={() => onTipChange(null)}
                onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(entry.desc, event.currentTarget))}
                onBlur={() => onTipChange(null)}
              >
                <span className="workspace-add-icon"><WorkspaceFeatureIcon id={entry.id} /></span>
                <span className="workspace-add-label">{entry.label}</span>
                <span className="workspace-add-meta">
                  {opened && <span className="workspace-add-open-dot" aria-label="已打开" />}
                  {entry.shortcut && <span className="workspace-add-shortcut">{entry.shortcut}</span>}
                </span>
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}

function WorkspaceOverview({
  workspacePath,
  workplacePath,
  activeTab,
  activeTabLabel,
  openTabs,
  openRequest,
  sessionId,
  sessionTitle,
  messages,
  artifactVersion,
  fileDrafts,
  onOpenFile,
}: {
  workspacePath: string
  workplacePath: string
  activeTab: WorkspacePanelTabId
  activeTabLabel: string
  openTabs: WorkspacePanelTabId[]
  openRequest: WorkspaceOpenRequest | null
  sessionId?: string
  sessionTitle?: string
  messages: ChatMessage[]
  artifactVersion: number
  fileDrafts: Record<string, WorkspaceFileDraftState>
  onOpenFile: (path: string) => void
}) {
  const [terminalActivities, setTerminalActivities] = useState<TerminalActivityRecord[]>([])
  const [terminalActivityError, setTerminalActivityError] = useState('')
  const [indexedArtifacts, setIndexedArtifacts] = useState<WorkspaceArtifactRecord[]>([])
  const [artifactError, setArtifactError] = useState('')
  const [activityKindFilter, setActivityKindFilter] = useState<WorkspaceActivityKindFilter>('all')
  const [activityQuery, setActivityQuery] = useState('')
  const messageArtifacts = useMemo(() => collectWorkspaceArtifacts(messages), [messages])
  const artifacts = useMemo(
    () => mergeWorkspaceArtifacts([
      ...indexedArtifacts.map(workspaceArtifactRecordToRef),
      ...messageArtifacts,
    ]),
    [indexedArtifacts, messageArtifacts],
  )
  const activityItems = useMemo(
    () => buildWorkspaceActivityFeed(messages, terminalActivities, indexedArtifacts),
    [indexedArtifacts, messages, terminalActivities],
  )
  const activityCounts = useMemo(() => {
    const counts: Record<WorkspaceActivityKindFilter, number> = {
      all: activityItems.length,
      agent: 0,
      artifact: 0,
      terminal: 0,
    }
    for (const item of activityItems) counts[item.kind] += 1
    return counts
  }, [activityItems])
  const filteredActivityItems = useMemo(() => {
    const query = activityQuery.trim().toLowerCase()
    return activityItems.filter((item) => {
      if (activityKindFilter !== 'all' && item.kind !== activityKindFilter) return false
      if (!query) return true
      return workspaceActivitySearchText(item).includes(query)
    })
  }, [activityItems, activityKindFilter, activityQuery])
  const recoverySnapshot = useMemo(
    () => buildWorkspaceRecoverySnapshot({
      activeTab,
      openTabs,
      openRequest,
      drafts: fileDrafts,
    }),
    [activeTab, fileDrafts, openRequest, openTabs],
  )
  const recoveryItems = [
    { label: '标签', value: `${openTabs.length}`, detail: recoverySnapshot.activeFileTab ? `当前文件 · ${lastPathSegment(recoverySnapshot.activeFileTab.path)}` : `当前 · ${activeTabLabel}` },
    { label: '文件', value: recoverySnapshot.openFileTabs.length > 0 ? `${recoverySnapshot.openFileTabs.length}` : '0', detail: recoverySnapshot.recentFilePath ? compactPath(recoverySnapshot.recentFilePath) : '暂无打开文件' },
    { label: '产物', value: `${artifacts.length}`, detail: artifactError || (artifacts.length > 0 ? '已从消息与索引合并' : '等待 agent 产出') },
    { label: '终端', value: `${terminalActivities.length}`, detail: terminalActivityError || (terminalActivities.length > 0 ? '已恢复最近命令' : '暂无命令记录') },
  ]

  useEffect(() => {
    let disposed = false
    setArtifactError('')
    listWorkspaceArtifacts(workspacePath, sessionId, 30)
      .then((records) => {
        if (!disposed) setIndexedArtifacts(records)
      })
      .catch((err) => {
        if (!disposed) {
          setIndexedArtifacts([])
          setArtifactError((err as Error).message)
        }
      })
    return () => {
      disposed = true
    }
  }, [artifactVersion, workspacePath, sessionId])

  useEffect(() => {
    let disposed = false
    setTerminalActivityError('')
    listWorkspaceTerminalActivity(workspacePath, sessionId, 8)
      .then((records) => {
        if (!disposed) setTerminalActivities(records)
      })
      .catch((err) => {
        if (!disposed) {
          setTerminalActivities([])
          setTerminalActivityError((err as Error).message)
        }
      })
    return () => {
      disposed = true
    }
  }, [workspacePath, sessionId])

  return (
    <div className="workspace-overview">
      <section className="workspace-overview-section">
        <div className="workspace-overview-label">当前工作区</div>
        <div className="workspace-overview-path">{compactPath(workspacePath)}</div>
        <small>{isSamePath(workspacePath, workplacePath) ? '未选择项目时使用 LS 默认 workplace。' : workspacePath}</small>
      </section>
      <section className="workspace-overview-section">
        <div className="workspace-overview-label">当前对话</div>
        <div className="workspace-overview-path">{sessionTitle ?? '新对话'}</div>
        <small>产物、命令和执行过程会按当前会话与工作区汇总到这里。</small>
      </section>
      <section className="workspace-overview-section">
        <div className="workspace-overview-section-head">
          <div className="workspace-overview-label">恢复状态</div>
          <small>{recoverySnapshot.dirtyDraftCount > 0 ? `${recoverySnapshot.dirtyDraftCount} 个未保存草稿` : '现场已同步'}</small>
        </div>
        <div className="workspace-recovery-grid" aria-label="工作现场恢复摘要">
          {recoveryItems.map((item) => (
            <div key={item.label} className="workspace-recovery-item">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.detail}</small>
            </div>
          ))}
        </div>
      </section>
      <section className={`workspace-overview-section ${artifacts.length === 0 ? 'muted' : ''}`}>
        <div className="workspace-overview-label">阶段产物</div>
        {artifacts.length === 0 ? (
          <>
            <div className="workspace-overview-path">暂无文件产物</div>
            <small>{artifactError || 'agent 新建或修改文件后，会在这里沉淀入口。'}</small>
          </>
        ) : (
          <div className="workspace-overview-artifacts">
            {artifacts.map((artifact) => (
              <button
                key={`${artifact.action}:${artifact.path}`}
                className={`workspace-overview-artifact ${artifact.action}`}
                type="button"
                onClick={() => onOpenFile(artifact.path)}
              >
                <span className="workspace-overview-artifact-icon" aria-hidden="true">
                  <FileGlyphIcon />
                </span>
                <span className="workspace-overview-artifact-main">
                  <strong>{artifact.name}</strong>
                  <small>{fileActionLabel(artifact.action)} · {compactPath(artifact.path)}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className={`workspace-overview-section ${activityItems.length === 0 ? 'muted' : ''}`}>
        <div className="workspace-overview-section-head">
          <div className="workspace-overview-label">最近活动</div>
          <small>{filteredActivityItems.length > 0 ? `${filteredActivityItems.length}/${activityItems.length} 条` : ''}</small>
        </div>
        {activityItems.length === 0 ? (
          <>
            <div className="workspace-overview-path">暂无工作现场记录</div>
            <small>{terminalActivityError || '对话执行、文件产物和终端命令会在这里形成时间线。'}</small>
          </>
        ) : (
          <>
            <div className="workspace-activity-controls">
              <div className="workspace-activity-filter-group" role="group" aria-label="活动类型筛选">
                {WORKSPACE_ACTIVITY_FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    className={`workspace-activity-filter ${activityKindFilter === filter.id ? 'active' : ''}`}
                    type="button"
                    disabled={activityCounts[filter.id] === 0}
                    aria-pressed={activityKindFilter === filter.id}
                    onClick={() => setActivityKindFilter(filter.id)}
                  >
                    <span>{filter.label}</span>
                    <small>{activityCounts[filter.id]}</small>
                  </button>
                ))}
              </div>
              <label className="workspace-activity-search">
                <SearchIcon />
                <input
                  value={activityQuery}
                  placeholder="筛选活动..."
                  spellCheck={false}
                  onChange={(event) => setActivityQuery(event.target.value)}
                />
              </label>
            </div>
            {filteredActivityItems.length === 0 ? (
              <div className="workspace-activity-empty">没有匹配的活动记录</div>
            ) : (
              <div className="workspace-activity-feed">
                {filteredActivityItems.map((item) => (
                  <button
                    key={item.id}
                    className={`workspace-activity-row ${item.kind}`}
                    type="button"
                    disabled={!item.artifact}
                    onClick={() => item.artifact ? onOpenFile(item.artifact.path) : undefined}
                  >
                    <span className="workspace-activity-glyph" aria-hidden="true" />
                    <span className="workspace-activity-main">
                      <span className="workspace-activity-title">{item.title}</span>
                      <small>{item.detail}</small>
                    </span>
                    <span className="workspace-activity-time">{formatDateTime(item.timestamp)}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}

function WorkspaceArtifacts({
  workspacePath,
  sessionId,
  artifactVersion,
  onOpenFile,
  onTipChange,
}: {
  workspacePath: string
  sessionId?: string
  artifactVersion: number
  onOpenFile: (path: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [records, setRecords] = useState<WorkspaceArtifactRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [scope, setScope] = useState<WorkspaceArtifactScopeFilter>('project')
  const [source, setSource] = useState<WorkspaceArtifactSourceFilter>('all')
  const [action, setAction] = useState<WorkspaceArtifactActionFilter>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError('')
    listWorkspaceArtifacts(workspacePath, scope === 'session' ? sessionId : undefined, 200)
      .then((nextRecords) => {
        if (!disposed) setRecords(nextRecords)
      })
      .catch((err) => {
        if (!disposed) {
          setRecords([])
          setError((err as Error).message)
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [artifactVersion, scope, sessionId, workspacePath])

  const filteredRecords = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return records.filter((record) => {
      if (source !== 'all' && record.source !== source) return false
      if (action !== 'all' && record.action !== action) return false
      if (!normalizedQuery) return true
      return [
        record.name,
        record.path,
        record.toolName ?? '',
        record.runId ?? '',
      ].join(' ').toLowerCase().includes(normalizedQuery)
    })
  }, [action, query, records, source])

  const sourceCounts = useMemo(() => ({
    all: records.length,
    agent: records.filter((record) => record.source === 'agent').length,
    user: records.filter((record) => record.source === 'user').length,
  }), [records])

  const actionCounts = useMemo(() => ({
    all: records.length,
    created: records.filter((record) => record.action === 'created').length,
    modified: records.filter((record) => record.action === 'modified').length,
    attached: records.filter((record) => record.action === 'attached').length,
  }), [records])

  function refreshArtifacts() {
    setLoading(true)
    setError('')
    listWorkspaceArtifacts(workspacePath, scope === 'session' ? sessionId : undefined, 200)
      .then(setRecords)
      .catch((err) => {
        setRecords([])
        setError((err as Error).message)
      })
      .finally(() => setLoading(false))
  }

  return (
    <div className="workspace-artifacts">
      <header className="workspace-artifacts-header">
        <div className="workspace-artifacts-title">
          <strong>产物管理</strong>
          <small>{compactPath(workspacePath)}</small>
        </div>
        <button
          {...transientTriggerProps()}
          className="workspace-files-icon-btn"
          type="button"
          aria-label="刷新产物"
          onClick={refreshArtifacts}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('刷新产物', event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip('刷新产物', event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('刷新产物', event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <RefreshIcon />
        </button>
      </header>
      <div className="workspace-artifacts-controls">
        <div className="workspace-artifacts-filter-group" aria-label="产物范围">
          <ArtifactFilterButton active={scope === 'project'} label="项目" onClick={() => setScope('project')} />
          <ArtifactFilterButton active={scope === 'session'} label="对话" disabled={!sessionId} onClick={() => setScope('session')} />
        </div>
        <div className="workspace-artifacts-filter-group" aria-label="产物来源">
          <ArtifactFilterButton active={source === 'all'} label="全部" count={sourceCounts.all} onClick={() => setSource('all')} />
          <ArtifactFilterButton active={source === 'agent'} label="Agent" count={sourceCounts.agent} onClick={() => setSource('agent')} />
          <ArtifactFilterButton active={source === 'user'} label="用户" count={sourceCounts.user} onClick={() => setSource('user')} />
        </div>
        <div className="workspace-artifacts-filter-group" aria-label="产物动作">
          <ArtifactFilterButton active={action === 'all'} label="全部动作" count={actionCounts.all} onClick={() => setAction('all')} />
          <ArtifactFilterButton active={action === 'created'} label="新建" count={actionCounts.created} onClick={() => setAction('created')} />
          <ArtifactFilterButton active={action === 'modified'} label="修改" count={actionCounts.modified} onClick={() => setAction('modified')} />
          <ArtifactFilterButton active={action === 'attached'} label="附件" count={actionCounts.attached} onClick={() => setAction('attached')} />
        </div>
        <label className="workspace-artifacts-search">
          <span aria-hidden="true"><SearchIcon /></span>
          <input
            value={query}
            type="search"
            placeholder="筛选文件、路径或工具..."
            aria-label="筛选产物"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className={`workspace-artifacts-list ${filteredRecords.length === 0 ? 'empty' : ''}`}>
        {loading && <WorkspacePlaceholder title="读取中" text="正在加载项目产物索引。" />}
        {!loading && error && <WorkspacePlaceholder title="产物读取失败" text={error} />}
        {!loading && !error && filteredRecords.length === 0 && (
          <WorkspacePlaceholder
            title={records.length === 0 ? '暂无产物' : '没有匹配产物'}
            text={records.length === 0 ? 'agent 写入、修改文件或你在内置编辑器保存文件后，会沉淀到这里。' : '调整筛选条件可以重新看到隐藏的产物。'}
          />
        )}
        {!loading && !error && filteredRecords.length > 0 && filteredRecords.map((record) => (
          <button
            key={record.id}
            className={`workspace-artifact-row ${record.action} ${record.source}`}
            type="button"
            onClick={() => onOpenFile(record.path)}
          >
            <span className="workspace-artifact-row-icon" aria-hidden="true">
              <FileGlyphIcon />
            </span>
            <span className="workspace-artifact-row-main">
              <strong>{record.name}</strong>
              <small>{compactPath(record.path)}</small>
            </span>
            <span className="workspace-artifact-row-meta">
              <em>{record.source === 'agent' ? 'Agent' : '用户'}</em>
              <em>{fileActionLabel(record.action)}</em>
              <time>{formatDateTime(Date.parse(record.createdAt))}</time>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ArtifactFilterButton({
  active,
  label,
  count,
  disabled = false,
  onClick,
}: {
  active: boolean
  label: string
  count?: number
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`workspace-artifacts-filter ${active ? 'active' : ''}`}
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
    >
      <span>{label}</span>
      {count !== undefined && <small>{count}</small>}
    </button>
  )
}

interface WorkspaceDirectoryState {
  entries: WorkspaceEntry[]
  truncated: boolean
  hiddenCount: number
}

const MAX_WORKSPACE_DIRECTORY_CACHE_ENTRIES = 128

function updateWorkspaceDirectoryCache(
  current: Record<string, WorkspaceDirectoryState>,
  requestedPath: string,
  resolvedPath: string,
  state: WorkspaceDirectoryState,
  rootPath: string,
): Record<string, WorkspaceDirectoryState> {
  const next = { ...current }
  delete next[requestedPath]
  delete next[resolvedPath]
  next[requestedPath] = state
  next[resolvedPath] = state

  const protectedPaths = new Set([rootPath, requestedPath, resolvedPath])
  let entryCount = Object.keys(next).length
  for (const key of Object.keys(next)) {
    if (entryCount <= MAX_WORKSPACE_DIRECTORY_CACHE_ENTRIES) break
    if (protectedPaths.has(key)) continue
    delete next[key]
    entryCount -= 1
  }
  return next
}

function WorkspaceFiles({
  workspacePath,
  defaultWorkspacePath,
  usingTemporaryRoot,
  navigatorCollapsed,
  expandedPaths,
  openRequest,
  sessionId,
  onRememberOpenPath,
  onReturnToDefaultWorkspace,
  onRequestFileSaveApproval,
  onWorkspaceArtifactsChanged,
  onNavigatorCollapsedChange,
  onExpandedPathsChange,
  onOpenFileTab,
  onTipChange,
}: {
  workspacePath: string
  defaultWorkspacePath: string
  usingTemporaryRoot: boolean
  navigatorCollapsed: boolean
  expandedPaths: string[]
  openRequest: WorkspaceOpenRequest | null
  sessionId?: string
  onRememberOpenPath: (root: string, path: string) => void
  onReturnToDefaultWorkspace: () => void
  onRequestFileSaveApproval: (detail: unknown) => Promise<boolean>
  onWorkspaceArtifactsChanged: () => void
  onNavigatorCollapsedChange: (collapsed: boolean) => void
  onExpandedPathsChange: (update: StringListUpdater) => void
  onOpenFileTab: (root: string, path: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [directories, setDirectories] = useState<Record<string, WorkspaceDirectoryState>>({})
  const expanded = useMemo(() => new Set(expandedPaths), [expandedPaths])
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())
  const [treeError, setTreeError] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [preview, setPreview] = useState<WorkspacePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [filterText, setFilterText] = useState('')
  const directoryRequestRef = useRef(0)
  const previewRequestRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      directoryRequestRef.current += 1
      previewRequestRef.current += 1
    }
  }, [])

  useEffect(() => {
    let alive = true
    const requestId = ++directoryRequestRef.current
    setDirectories({})
    onExpandedPathsChange((paths) => paths.includes(workspacePath) ? paths : [...paths, workspacePath])
    setTreeError('')
    setSelectedPath('')
    setPreview(null)
    setPreviewError('')
    setDirectoryLoading(workspacePath, true)
    listWorkspaceDirectory(workspacePath, workspacePath)
      .then((directory) => {
        if (!alive || requestId !== directoryRequestRef.current) return
        commitDirectory(workspacePath, directory)
      })
      .catch((err) => {
        if (!alive || requestId !== directoryRequestRef.current) return
        setTreeError((err as Error).message)
      })
      .finally(() => {
        if (!alive || requestId !== directoryRequestRef.current) return
        setDirectoryLoading(workspacePath, false)
      })
    return () => {
      alive = false
    }
  }, [workspacePath])

  useEffect(() => {
    if (!openRequest || openRequest.root !== workspacePath) return
    void openRequestedFile(openRequest.path, false)
  }, [openRequest?.id, workspacePath])

  function setDirectoryLoading(path: string, loading: boolean) {
    setLoadingDirs((value) => {
      const next = new Set(value)
      if (loading) next.add(path)
      else next.delete(path)
      return next
    })
  }

  function commitDirectory(requestedPath: string, directory: WorkspaceDirectory) {
    if (!mountedRef.current) return
    const state: WorkspaceDirectoryState = {
      entries: directory.entries,
      truncated: directory.truncated,
      hiddenCount: directory.hiddenCount,
    }
    setDirectories((value) => updateWorkspaceDirectoryCache(
      value,
      requestedPath,
      directory.path,
      state,
      workspacePath,
    ))
  }

  async function loadDirectory(path: string) {
    const requestId = directoryRequestRef.current
    setTreeError('')
    setDirectoryLoading(path, true)
    try {
      const directory = await listWorkspaceDirectory(workspacePath, path)
      if (!mountedRef.current || requestId !== directoryRequestRef.current) return
      commitDirectory(path, directory)
    } catch (err) {
      if (!mountedRef.current || requestId !== directoryRequestRef.current) return
      setTreeError((err as Error).message)
    } finally {
      if (!mountedRef.current || requestId !== directoryRequestRef.current) return
      setDirectoryLoading(path, false)
    }
  }

  function toggleDirectory(entry: WorkspaceEntry) {
    onExpandedPathsChange((paths) => {
      const next = new Set(paths)
      if (next.has(entry.path)) {
        next.delete(entry.path)
      } else {
        next.add(entry.path)
        if (!directories[entry.path]) void loadDirectory(entry.path)
      }
      return [...next]
    })
  }

  function openFile(entry: WorkspaceEntry) {
    onOpenFileTab(workspacePath, entry.path)
    void openRequestedFile(entry.path)
  }

  async function openRequestedFile(path: string, remember = true) {
    setSelectedPath(path)
    if (remember) onRememberOpenPath(workspacePath, path)
    setPreview(null)
    setPreviewError('')
    setPreviewLoading(true)
    const parent = directoryPath(path)
    if (parent && !isSamePath(parent, workspacePath) && !directories[parent]) {
      onExpandedPathsChange((paths) => paths.includes(parent) ? paths : [...paths, parent])
      void loadDirectory(parent)
    }
    const requestId = ++previewRequestRef.current
    try {
      const result = await previewWorkspaceFile(workspacePath, path)
      if (!mountedRef.current || requestId !== previewRequestRef.current) return
      setPreview(result)
    } catch (err) {
      if (!mountedRef.current || requestId !== previewRequestRef.current) return
      setPreviewError((err as Error).message)
    } finally {
      if (!mountedRef.current || requestId !== previewRequestRef.current) return
      setPreviewLoading(false)
    }
  }

  async function openSelectedExternal() {
    if (!selectedPath) return
    try {
      await openWorkspacePath(workspacePath, selectedPath)
    } catch (err) {
      setPreviewError((err as Error).message)
    }
  }

  async function openWorkspaceInVSCode() {
    try {
      await openWorkspacePathInVSCode(workspacePath)
    } catch (err) {
      setTreeError((err as Error).message)
    }
  }

  async function openSelectedInVSCode() {
    if (!selectedPath) return
    try {
      await openWorkspacePathInVSCode(workspacePath, selectedPath)
    } catch (err) {
      setPreviewError((err as Error).message)
    }
  }

  async function saveSelectedFile(path: string, content: string, expectedModifiedAt?: number): Promise<WorkspacePreview> {
    const approved = await onRequestFileSaveApproval({
      path,
      root: workspacePath,
      relativePath: workspaceBreadcrumbs(workspacePath, path).join('/'),
    })
    if (!approved) throw new Error('已取消保存。')
    setPreviewError('')
    const nextPreview = await saveWorkspaceFile(workspacePath, path, content, expectedModifiedAt, sessionId)
    setPreview(nextPreview)
    onWorkspaceArtifactsChanged()
    const parent = directoryPath(path)
    if (parent) void loadDirectory(parent)
    return nextPreview
  }

  function refreshTree() {
    void loadDirectory(workspacePath)
    if (selectedPath) openFile({
      name: lastPathSegment(selectedPath),
      path: selectedPath,
      relativePath: selectedPath,
      kind: 'file',
    })
  }

  const rootInfo = directories[workspacePath]
  const loadingRoot = loadingDirs.has(workspacePath)
  const normalizedFilter = normalizeWorkspaceFilter(filterText)
  const rootHasVisibleEntries = rootInfo
    ? rootInfo.entries.some((entry) => workspaceEntryMatchesFilter(entry, directories, normalizedFilter))
    : false

  return (
    <div className={`workspace-files ${navigatorCollapsed ? 'navigator-collapsed' : ''}`}>
      <WorkspacePreviewPane
        preview={preview}
        loading={previewLoading}
        error={previewError}
        selectedPath={selectedPath}
        workspacePath={workspacePath}
        onOpenExternal={openSelectedExternal}
        onOpenInVSCode={openSelectedInVSCode}
        onSaveFile={saveSelectedFile}
        onTipChange={onTipChange}
      />
      <aside className="workspace-files-navigator" aria-label="文件管理" aria-expanded={!navigatorCollapsed}>
        <button
          {...transientTriggerProps()}
          className="workspace-files-navigator-rail"
          type="button"
          aria-label={navigatorCollapsed ? '展开文件管理' : '折叠文件管理'}
          aria-expanded={!navigatorCollapsed}
          onClick={() => onNavigatorCollapsedChange(!navigatorCollapsed)}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(navigatorCollapsed ? '展开文件管理' : '折叠文件管理', event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip(navigatorCollapsed ? '展开文件管理' : '折叠文件管理', event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(navigatorCollapsed ? '展开文件管理' : '折叠文件管理', event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <FolderGlyphIcon />
        </button>
        <div className="workspace-files-navigator-inner" {...(navigatorCollapsed ? { inert: '' } : {})}>
          <div className="workspace-files-toolbar">
            <div className="workspace-files-root">
              <span>
                {compactPath(workspacePath)}
                <b className={`workspace-root-badge ${usingTemporaryRoot ? 'temporary' : ''}`}>
                  {usingTemporaryRoot ? '临时预览' : '当前工作区'}
                </b>
              </span>
              <small>{usingTemporaryRoot ? `来源不改变当前工作区：${defaultWorkspacePath}` : workspacePath}</small>
            </div>
            <div className="workspace-files-actions">
              {usingTemporaryRoot && (
                <button
                  {...transientTriggerProps()}
                  className="workspace-files-text-btn"
                  type="button"
                  onClick={onReturnToDefaultWorkspace}
                  onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('回到当前工作区', event.clientX, event.clientY))}
                  onMouseMove={(event) => onTipChange(buildFloatingHelpTip('回到当前工作区', event.clientX, event.clientY))}
                  onMouseLeave={() => onTipChange(null)}
                  onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('回到当前工作区', event.currentTarget))}
                  onBlur={() => onTipChange(null)}
                >
                  回到工作区
                </button>
              )}
              <button
                {...transientTriggerProps()}
                className="workspace-files-icon-btn"
                type="button"
                aria-label="用外部 VS Code 打开工作区"
                onClick={() => void openWorkspaceInVSCode()}
                onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('用外部 VS Code 打开工作区', event.clientX, event.clientY))}
                onMouseMove={(event) => onTipChange(buildFloatingHelpTip('用外部 VS Code 打开工作区', event.clientX, event.clientY))}
                onMouseLeave={() => onTipChange(null)}
                onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('用外部 VS Code 打开工作区', event.currentTarget))}
                onBlur={() => onTipChange(null)}
              >
                <VSCodeIcon />
              </button>
              <button
                {...transientTriggerProps()}
                className="workspace-files-icon-btn"
                type="button"
                aria-label="刷新文件树"
                onClick={refreshTree}
                onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('刷新文件树', event.clientX, event.clientY))}
                onMouseMove={(event) => onTipChange(buildFloatingHelpTip('刷新文件树', event.clientX, event.clientY))}
                onMouseLeave={() => onTipChange(null)}
                onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('刷新文件树', event.currentTarget))}
                onBlur={() => onTipChange(null)}
              >
                <RefreshIcon />
              </button>
              <button
                {...transientTriggerProps()}
                className="workspace-files-icon-btn"
                type="button"
                aria-label="折叠文件管理"
                onClick={() => onNavigatorCollapsedChange(true)}
                onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('折叠文件管理', event.clientX, event.clientY))}
                onMouseMove={(event) => onTipChange(buildFloatingHelpTip('折叠文件管理', event.clientX, event.clientY))}
                onMouseLeave={() => onTipChange(null)}
                onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('折叠文件管理', event.currentTarget))}
                onBlur={() => onTipChange(null)}
              >
                <PanelCollapseIcon />
              </button>
            </div>
          </div>
          <label className="workspace-file-filter">
            <span aria-hidden="true"><SearchIcon /></span>
            <input
              type="search"
              value={filterText}
              placeholder="筛选文件..."
              aria-label="筛选文件"
              onChange={(event) => setFilterText(event.target.value)}
            />
          </label>
          <div className="workspace-tree" role="tree" aria-label="当前工作区文件树">
            {loadingRoot && !rootInfo && <WorkspaceTreeNotice text="正在读取文件树..." />}
            {treeError && <WorkspaceTreeNotice text={treeError} tone="error" />}
            {rootInfo && rootInfo.entries.length === 0 && <WorkspaceTreeNotice text="这个文件夹是空的。" />}
            {rootInfo && normalizedFilter && !rootHasVisibleEntries && <WorkspaceTreeNotice text="没有匹配的文件。" />}
            {rootInfo && (
              <WorkspaceTreeRows
                dirPath={workspacePath}
                depth={0}
                directories={directories}
                expanded={expanded}
                loadingDirs={loadingDirs}
                selectedPath={selectedPath}
                filterText={normalizedFilter}
                onToggleDirectory={toggleDirectory}
                onOpenFile={openFile}
                onTipChange={onTipChange}
              />
            )}
            {rootInfo && (rootInfo.hiddenCount > 0 || rootInfo.truncated) && (
              <WorkspaceTreeNotice
                text={[
                  rootInfo.hiddenCount > 0 ? `已隐藏 ${rootInfo.hiddenCount} 个重目录或链接` : '',
                  rootInfo.truncated ? `已截断到前 ${MAX_WORKSPACE_DIR_ENTRIES_LABEL} 项` : '',
                ].filter(Boolean).join('，')}
              />
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}

function WorkspaceFileNavigator({
  workspacePath,
  defaultWorkspacePath,
  usingTemporaryRoot,
  navigatorCollapsed,
  expandedPaths,
  selectedPath,
  onOpenFileTab,
  onReturnToDefaultWorkspace,
  onNavigatorCollapsedChange,
  onExpandedPathsChange,
  onTipChange,
}: {
  workspacePath: string
  defaultWorkspacePath: string
  usingTemporaryRoot: boolean
  navigatorCollapsed: boolean
  expandedPaths: string[]
  selectedPath: string
  onOpenFileTab: (root: string, path: string) => void
  onReturnToDefaultWorkspace: () => void
  onNavigatorCollapsedChange: (collapsed: boolean) => void
  onExpandedPathsChange: (update: StringListUpdater) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [directories, setDirectories] = useState<Record<string, WorkspaceDirectoryState>>({})
  const expanded = useMemo(() => new Set(expandedPaths), [expandedPaths])
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())
  const [treeError, setTreeError] = useState('')
  const [filterText, setFilterText] = useState('')
  const directoryRequestRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      directoryRequestRef.current += 1
    }
  }, [])

  useEffect(() => {
    let alive = true
    const requestId = ++directoryRequestRef.current
    setDirectories({})
    onExpandedPathsChange((paths) => paths.includes(workspacePath) ? paths : [...paths, workspacePath])
    setTreeError('')
    setDirectoryLoading(workspacePath, true)
    listWorkspaceDirectory(workspacePath, workspacePath)
      .then((directory) => {
        if (!alive || requestId !== directoryRequestRef.current) return
        commitDirectory(workspacePath, directory)
      })
      .catch((err) => {
        if (!alive || requestId !== directoryRequestRef.current) return
        setTreeError((err as Error).message)
      })
      .finally(() => {
        if (!alive || requestId !== directoryRequestRef.current) return
        setDirectoryLoading(workspacePath, false)
      })
    return () => {
      alive = false
    }
  }, [workspacePath])

  useEffect(() => {
    const ancestors = workspaceAncestorPaths(workspacePath, selectedPath)
    if (ancestors.length === 0) return
    onExpandedPathsChange((paths) => [...paths, ...ancestors])
    for (const path of ancestors) {
      if (!directories[path]) void loadDirectory(path)
    }
  }, [selectedPath, workspacePath])

  function setDirectoryLoading(path: string, loading: boolean) {
    setLoadingDirs((value) => {
      const next = new Set(value)
      if (loading) next.add(path)
      else next.delete(path)
      return next
    })
  }

  function commitDirectory(requestedPath: string, directory: WorkspaceDirectory) {
    if (!mountedRef.current) return
    const state: WorkspaceDirectoryState = {
      entries: directory.entries,
      truncated: directory.truncated,
      hiddenCount: directory.hiddenCount,
    }
    setDirectories((value) => updateWorkspaceDirectoryCache(
      value,
      requestedPath,
      directory.path,
      state,
      workspacePath,
    ))
  }

  async function loadDirectory(path: string) {
    const requestId = directoryRequestRef.current
    setTreeError('')
    setDirectoryLoading(path, true)
    try {
      const directory = await listWorkspaceDirectory(workspacePath, path)
      if (!mountedRef.current || requestId !== directoryRequestRef.current) return
      commitDirectory(path, directory)
    } catch (err) {
      if (!mountedRef.current || requestId !== directoryRequestRef.current) return
      setTreeError((err as Error).message)
    } finally {
      if (!mountedRef.current || requestId !== directoryRequestRef.current) return
      setDirectoryLoading(path, false)
    }
  }

  function toggleDirectory(entry: WorkspaceEntry) {
    onExpandedPathsChange((paths) => {
      const next = new Set(paths)
      if (next.has(entry.path)) {
        next.delete(entry.path)
      } else {
        next.add(entry.path)
        if (!directories[entry.path]) void loadDirectory(entry.path)
      }
      return [...next]
    })
  }

  function openFile(entry: WorkspaceEntry) {
    onOpenFileTab(workspacePath, entry.path)
  }

  async function openWorkspaceInVSCode() {
    try {
      await openWorkspacePathInVSCode(workspacePath)
    } catch (err) {
      setTreeError((err as Error).message)
    }
  }

  function refreshTree() {
    void loadDirectory(workspacePath)
    const ancestors = workspaceAncestorPaths(workspacePath, selectedPath)
    for (const path of ancestors) void loadDirectory(path)
  }

  const rootInfo = directories[workspacePath]
  const loadingRoot = loadingDirs.has(workspacePath)
  const normalizedFilter = normalizeWorkspaceFilter(filterText)
  const rootHasVisibleEntries = rootInfo
    ? rootInfo.entries.some((entry) => workspaceEntryMatchesFilter(entry, directories, normalizedFilter))
    : false

  return (
    <aside
      className={`workspace-files-navigator ${navigatorCollapsed ? 'navigator-collapsed' : ''}`}
      aria-label="文件管理"
      aria-expanded={!navigatorCollapsed}
    >
      <button
        {...transientTriggerProps()}
        className="workspace-files-navigator-rail"
        type="button"
        aria-label={navigatorCollapsed ? '展开文件管理' : '折叠文件管理'}
        aria-expanded={!navigatorCollapsed}
        onClick={() => onNavigatorCollapsedChange(!navigatorCollapsed)}
        onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(navigatorCollapsed ? '展开文件管理' : '折叠文件管理', event.clientX, event.clientY))}
        onMouseMove={(event) => onTipChange(buildFloatingHelpTip(navigatorCollapsed ? '展开文件管理' : '折叠文件管理', event.clientX, event.clientY))}
        onMouseLeave={() => onTipChange(null)}
        onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(navigatorCollapsed ? '展开文件管理' : '折叠文件管理', event.currentTarget))}
        onBlur={() => onTipChange(null)}
      >
        <FolderGlyphIcon />
      </button>
      <div className="workspace-files-navigator-inner" {...(navigatorCollapsed ? { inert: '' } : {})}>
        <div className="workspace-files-toolbar">
          <div className="workspace-files-root">
            <span>
              {compactPath(workspacePath)}
              <b className={`workspace-root-badge ${usingTemporaryRoot ? 'temporary' : ''}`}>
                {usingTemporaryRoot ? '临时预览' : '当前工作区'}
              </b>
            </span>
            <small>{usingTemporaryRoot ? `来源不改变当前工作区：${defaultWorkspacePath}` : workspacePath}</small>
          </div>
          <div className="workspace-files-actions">
            {usingTemporaryRoot && (
              <button
                {...transientTriggerProps()}
                className="workspace-files-text-btn"
                type="button"
                onClick={onReturnToDefaultWorkspace}
                onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('回到当前工作区', event.clientX, event.clientY))}
                onMouseMove={(event) => onTipChange(buildFloatingHelpTip('回到当前工作区', event.clientX, event.clientY))}
                onMouseLeave={() => onTipChange(null)}
                onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('回到当前工作区', event.currentTarget))}
                onBlur={() => onTipChange(null)}
              >
                回到工作区
              </button>
            )}
            <button
              {...transientTriggerProps()}
              className="workspace-files-icon-btn"
              type="button"
              aria-label="用外部 VS Code 打开工作区"
              onClick={() => void openWorkspaceInVSCode()}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('用外部 VS Code 打开工作区', event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip('用外部 VS Code 打开工作区', event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('用外部 VS Code 打开工作区', event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <VSCodeIcon />
            </button>
            <button
              {...transientTriggerProps()}
              className="workspace-files-icon-btn"
              type="button"
              aria-label="刷新文件树"
              onClick={refreshTree}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('刷新文件树', event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip('刷新文件树', event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('刷新文件树', event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <RefreshIcon />
            </button>
            <button
              {...transientTriggerProps()}
              className="workspace-files-icon-btn"
              type="button"
              aria-label="折叠文件管理"
              onClick={() => onNavigatorCollapsedChange(true)}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('折叠文件管理', event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip('折叠文件管理', event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('折叠文件管理', event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <PanelCollapseIcon />
            </button>
          </div>
        </div>
        <label className="workspace-file-filter">
          <span aria-hidden="true"><SearchIcon /></span>
          <input
            type="search"
            value={filterText}
            placeholder="筛选文件..."
            aria-label="筛选文件"
            onChange={(event) => setFilterText(event.target.value)}
          />
        </label>
        <div className="workspace-tree" role="tree" aria-label="当前工作区文件树">
          {loadingRoot && !rootInfo && <WorkspaceTreeNotice text="正在读取文件树..." />}
          {treeError && <WorkspaceTreeNotice text={treeError} tone="error" />}
          {rootInfo && rootInfo.entries.length === 0 && <WorkspaceTreeNotice text="这个文件夹是空的。" />}
          {rootInfo && normalizedFilter && !rootHasVisibleEntries && <WorkspaceTreeNotice text="没有匹配的文件。" />}
          {rootInfo && (
            <WorkspaceTreeRows
              dirPath={workspacePath}
              depth={0}
              directories={directories}
              expanded={expanded}
              loadingDirs={loadingDirs}
              selectedPath={selectedPath}
              filterText={normalizedFilter}
              onToggleDirectory={toggleDirectory}
              onOpenFile={openFile}
              onTipChange={onTipChange}
            />
          )}
          {rootInfo && (rootInfo.hiddenCount > 0 || rootInfo.truncated) && (
            <WorkspaceTreeNotice
              text={[
                rootInfo.hiddenCount > 0 ? `已隐藏 ${rootInfo.hiddenCount} 个重目录或链接` : '',
                rootInfo.truncated ? `已截断到前 ${MAX_WORKSPACE_DIR_ENTRIES_LABEL} 项` : '',
              ].filter(Boolean).join('，')}
            />
          )}
        </div>
      </div>
    </aside>
  )
}

const MAX_WORKSPACE_DIR_ENTRIES_LABEL = 320

function WorkspaceFileView({
  tabId,
  root,
  path,
  sessionId,
  draft,
  onDraftChange,
  onRequestFileSaveApproval,
  onWorkspaceArtifactsChanged,
  onTipChange,
}: {
  tabId: WorkspaceFileTabId
  root: string
  path: string
  sessionId?: string
  draft?: WorkspaceFileDraftState
  onDraftChange: (tab: WorkspaceFileTabId, draft: WorkspaceFileDraftState | null) => void
  onRequestFileSaveApproval: (detail: unknown) => Promise<boolean>
  onWorkspaceArtifactsChanged: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [preview, setPreview] = useState<WorkspacePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef(0)

  useEffect(() => {
    let alive = true
    const requestId = ++requestRef.current
    setPreview(null)
    setError('')
    setLoading(true)
    previewWorkspaceFile(root, path)
      .then((result) => {
        if (!alive || requestId !== requestRef.current) return
        setPreview(result)
      })
      .catch((err) => {
        if (!alive || requestId !== requestRef.current) return
        setError((err as Error).message)
      })
      .finally(() => {
        if (!alive || requestId !== requestRef.current) return
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [root, path])

  async function openExternal() {
    try {
      await openWorkspacePath(root, path)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function openInVSCode() {
    try {
      await openWorkspacePathInVSCode(root, path)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function saveFile(nextPath: string, content: string, expectedModifiedAt?: number): Promise<WorkspacePreview> {
    const approved = await onRequestFileSaveApproval({
      path: nextPath,
      root,
      relativePath: workspaceBreadcrumbs(root, nextPath).join('/'),
    })
    if (!approved) throw new Error('已取消保存。')
    const nextPreview = await saveWorkspaceFile(root, nextPath, content, expectedModifiedAt, sessionId)
    setPreview(nextPreview)
    onWorkspaceArtifactsChanged()
    return nextPreview
  }

  return (
    <WorkspacePreviewPane
      preview={preview}
      loading={loading}
      error={error}
      selectedPath={path}
      workspacePath={root}
      tabId={tabId}
      draft={draft}
      onOpenExternal={openExternal}
      onOpenInVSCode={openInVSCode}
      onSaveFile={saveFile}
      onDraftChange={onDraftChange}
      onTipChange={onTipChange}
    />
  )
}

function WorkspaceTreeRows({
  dirPath,
  depth,
  directories,
  expanded,
  loadingDirs,
  selectedPath,
  filterText,
  onToggleDirectory,
  onOpenFile,
  onTipChange,
}: {
  dirPath: string
  depth: number
  directories: Record<string, WorkspaceDirectoryState>
  expanded: Set<string>
  loadingDirs: Set<string>
  selectedPath: string
  filterText: string
  onToggleDirectory: (entry: WorkspaceEntry) => void
  onOpenFile: (entry: WorkspaceEntry) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const directory = directories[dirPath]
  if (!directory) return null

  return (
    <>
      {directory.entries.map((entry) => {
        if (!workspaceEntryMatchesFilter(entry, directories, filterText)) return null
        const directoryEntry = entry.kind === 'directory'
        const open = directoryEntry && (
          expanded.has(entry.path) ||
          (Boolean(filterText) && workspaceDirectoryHasFilterMatch(entry.path, directories, filterText))
        )
        const selected = entry.path === selectedPath
        const loading = loadingDirs.has(entry.path)
        const tip = `${entry.name}\n${entry.path}`
        return (
          <div key={entry.path}>
            <button
              className={`workspace-tree-row ${directoryEntry ? 'directory' : 'file'} ${selected ? 'selected' : ''}`}
              type="button"
              role="treeitem"
              aria-expanded={directoryEntry ? open : undefined}
              aria-selected={!directoryEntry ? selected : undefined}
              style={{ '--workspace-tree-depth': depth } as CSSProperties}
              onClick={() => directoryEntry ? onToggleDirectory(entry) : onOpenFile(entry)}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(tip, event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <span className={`workspace-tree-chevron ${open ? 'open' : ''}`}>
                {directoryEntry ? <TreeChevronIcon /> : null}
              </span>
              <span className="workspace-tree-glyph">
                {directoryEntry ? <FolderGlyphIcon /> : <FileGlyphIcon />}
              </span>
              <span className="workspace-tree-name">{entry.name}</span>
              {!directoryEntry && entry.size !== undefined && (
                <span className="workspace-tree-size">{formatFileSize(entry.size)}</span>
              )}
              {loading && <span className="workspace-tree-loading" />}
            </button>
            {directoryEntry && open && (
              directories[entry.path]
                ? (
                  <WorkspaceTreeRows
                    dirPath={entry.path}
                    depth={depth + 1}
                    directories={directories}
                    expanded={expanded}
                    loadingDirs={loadingDirs}
                    selectedPath={selectedPath}
                    filterText={filterText}
                    onToggleDirectory={onToggleDirectory}
                    onOpenFile={onOpenFile}
                    onTipChange={onTipChange}
                  />
                )
                : <WorkspaceTreeNotice text="正在读取..." indent={depth + 1} />
            )}
          </div>
        )
      })}
      {directory.entries.length > 0 && (directory.hiddenCount > 0 || directory.truncated) && depth > 0 && (
        <WorkspaceTreeNotice
          indent={depth + 1}
          text={[
            directory.hiddenCount > 0 ? `隐藏 ${directory.hiddenCount} 项` : '',
            directory.truncated ? '列表已截断' : '',
          ].filter(Boolean).join('，')}
        />
      )}
    </>
  )
}

function normalizeWorkspaceFilter(value: string): string {
  return value.trim().toLowerCase()
}

function workspaceEntryMatchesFilter(
  entry: WorkspaceEntry,
  directories: Record<string, WorkspaceDirectoryState>,
  filterText: string,
): boolean {
  if (!filterText) return true
  const entryText = `${entry.name} ${entry.relativePath} ${entry.path}`.toLowerCase()
  if (entryText.includes(filterText)) return true
  return entry.kind === 'directory' && workspaceDirectoryHasFilterMatch(entry.path, directories, filterText)
}

function workspaceDirectoryHasFilterMatch(
  path: string,
  directories: Record<string, WorkspaceDirectoryState>,
  filterText: string,
): boolean {
  const directory = directories[path]
  if (!directory) return false
  return directory.entries.some((entry) => workspaceEntryMatchesFilter(entry, directories, filterText))
}

function WorkspaceTreeNotice({
  text,
  tone = 'muted',
  indent = 0,
}: {
  text: string
  tone?: 'muted' | 'error'
  indent?: number
}) {
  return (
    <div
      className={`workspace-tree-notice ${tone}`}
      style={{ '--workspace-tree-depth': indent } as CSSProperties}
    >
      {text}
    </div>
  )
}

function WorkspacePreviewPane({
  preview,
  loading,
  error,
  selectedPath,
  workspacePath,
  tabId,
  draft,
  onOpenExternal,
  onOpenInVSCode,
  onSaveFile,
  onDraftChange,
  onTipChange,
}: {
  preview: WorkspacePreview | null
  loading: boolean
  error: string
  selectedPath: string
  workspacePath: string
  tabId?: WorkspaceFileTabId
  draft?: WorkspaceFileDraftState
  onOpenExternal: () => void | Promise<void>
  onOpenInVSCode: () => void | Promise<void>
  onSaveFile: (path: string, content: string, expectedModifiedAt?: number) => Promise<WorkspacePreview>
  onDraftChange?: (tab: WorkspaceFileTabId, draft: WorkspaceFileDraftState | null) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const title = preview?.name ?? (selectedPath ? lastPathSegment(selectedPath) : '预览')
  const meta = preview ? `${formatFileSize(preview.size)}${preview.modifiedAt ? ` · ${formatDateTime(preview.modifiedAt)}` : ''}` : ''
  const breadcrumbs = selectedPath ? workspaceBreadcrumbs(workspacePath, selectedPath) : []
  const editable = preview?.kind === 'text' || preview?.kind === 'markdown'
  const editorLanguage = preview?.kind === 'markdown'
    ? 'markdown'
    : preview?.kind === 'text'
      ? preview.language || 'text'
      : ''
  const editorLanguageLabel = formatEditorLanguageLabel(editorLanguage)
  const canOpenExternalVSCode = preview ? shouldOfferExternalVSCode(preview) : false
  const [editing, setEditing] = useState(false)
  const [editorText, setEditorText] = useState('')
  const [savedText, setSavedText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [saveError, setSaveError] = useState('')
  const dirty = editable && editorText !== savedText
  const editorLineCount = editable ? countEditorLines(editorText) : 0
  const editorEol = editable ? detectEditorEol(editorText) : ''
  const editorSize = editable ? formatFileSize(utf8ByteLength(editorText)) : ''

  function emitDraft(next: {
    editorText?: string
    savedText?: string
    editing?: boolean
    modifiedAt?: number
    path?: string
  }) {
    if (!tabId || !onDraftChange) return
    if (!editable || !preview || (preview.kind !== 'text' && preview.kind !== 'markdown')) {
      onDraftChange(tabId, null)
      return
    }
    onDraftChange(tabId, {
      path: next.path ?? preview.path,
      modifiedAt: next.modifiedAt ?? preview.modifiedAt,
      editorText: next.editorText ?? editorText,
      savedText: next.savedText ?? savedText,
      editing: next.editing ?? editing,
    })
  }

  function updateEditorText(nextText: string) {
    setEditorText(nextText)
    emitDraft({ editorText: nextText })
  }

  function updateEditing(nextEditing: boolean) {
    setEditing(nextEditing)
    emitDraft({ editing: nextEditing })
  }

  useEffect(() => {
    const content = editable ? preview.content : ''
    const canRestoreDraft = editable && preview && draft?.path === preview.path && draft.modifiedAt === preview.modifiedAt
    const nextEditorText = canRestoreDraft ? draft.editorText : content
    const nextSavedText = canRestoreDraft ? draft.savedText : content
    const nextEditing = canRestoreDraft ? draft.editing : false
    setEditorText(nextEditorText)
    setSavedText(nextSavedText)
    setEditing(nextEditing)
    setSaving(false)
    setSaveMessage('')
    setSaveError('')
    if (editable && preview && (preview.kind === 'text' || preview.kind === 'markdown')) {
      if (tabId && onDraftChange) onDraftChange(tabId, {
        path: preview.path,
        modifiedAt: preview.modifiedAt,
        editorText: nextEditorText,
        savedText: nextSavedText,
        editing: nextEditing,
      })
    } else {
      if (tabId && onDraftChange) onDraftChange(tabId, null)
    }
  }, [preview?.path, preview?.modifiedAt, editable])

  async function saveEditorContent() {
    if (!editable || !preview || !dirty || saving) return
    setSaving(true)
    setSaveError('')
    setSaveMessage('')
    try {
      const nextPreview = await onSaveFile(preview.path, editorText, preview.modifiedAt)
      if (nextPreview.kind === 'text' || nextPreview.kind === 'markdown') {
        setEditorText(nextPreview.content)
        setSavedText(nextPreview.content)
        if (tabId && onDraftChange) onDraftChange(tabId, {
          path: nextPreview.path,
          modifiedAt: nextPreview.modifiedAt,
          editorText: nextPreview.content,
          savedText: nextPreview.content,
          editing,
        })
      } else {
        setSavedText(editorText)
        emitDraft({ savedText: editorText })
      }
      setSaveMessage('已保存')
    } catch (err) {
      setSaveError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="workspace-preview-pane">
      <div className="workspace-preview-header">
        <div className="workspace-preview-title">
          <span>
            {title}
            {editable && <b className="workspace-preview-editor-badge">内置 VS Code · {editorLanguageLabel}</b>}
          </span>
          {breadcrumbs.length > 0 ? (
            <div className="workspace-preview-breadcrumbs" aria-label="文件路径">
              {breadcrumbs.map((part, index) => (
                <span key={`${part}-${index}`}>
                  {index > 0 && <i aria-hidden="true">/</i>}
                  <em>{part}</em>
                </span>
              ))}
            </div>
          ) : (
            <small>{preview?.relativePath || (selectedPath ? selectedPath : '选择一个文件查看内容')}</small>
          )}
        </div>
        {selectedPath && (
          <div className="workspace-preview-actions">
            {editable && (
              <>
                <button
                  {...transientTriggerProps()}
                  className={`workspace-files-text-btn ${editing ? 'active' : ''}`}
                  type="button"
                  aria-pressed={editing}
                  onClick={() => updateEditing(!editing)}
                  onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(editing ? '切换到只读代码视图' : '在内置 VS Code 编辑器中编辑', event.clientX, event.clientY))}
                  onMouseMove={(event) => onTipChange(buildFloatingHelpTip(editing ? '切换到只读代码视图' : '在内置 VS Code 编辑器中编辑', event.clientX, event.clientY))}
                  onMouseLeave={() => onTipChange(null)}
                  onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(editing ? '切换到只读代码视图' : '在内置 VS Code 编辑器中编辑', event.currentTarget))}
                  onBlur={() => onTipChange(null)}
                >
                  {editing ? '只读' : '编辑'}
                </button>
                <button
                  {...transientTriggerProps()}
                  className="workspace-files-text-btn"
                  type="button"
                  disabled={!dirty || saving}
                  onClick={() => void saveEditorContent()}
                  onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('保存当前文件', event.clientX, event.clientY))}
                  onMouseMove={(event) => onTipChange(buildFloatingHelpTip('保存当前文件', event.clientX, event.clientY))}
                  onMouseLeave={() => onTipChange(null)}
                  onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('保存当前文件', event.currentTarget))}
                  onBlur={() => onTipChange(null)}
                >
                  {saving ? '保存中' : dirty ? '保存*' : '保存'}
                </button>
              </>
            )}
            {canOpenExternalVSCode && (
              <button
                {...transientTriggerProps()}
                className="workspace-files-icon-btn"
                type="button"
                aria-label="用外部 VS Code 打开文件"
                onClick={() => void onOpenInVSCode()}
                onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('用外部 VS Code 打开文件', event.clientX, event.clientY))}
                onMouseMove={(event) => onTipChange(buildFloatingHelpTip('用外部 VS Code 打开文件', event.clientX, event.clientY))}
                onMouseLeave={() => onTipChange(null)}
                onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('用外部 VS Code 打开文件', event.currentTarget))}
                onBlur={() => onTipChange(null)}
              >
                <VSCodeIcon />
              </button>
            )}
            <button
              {...transientTriggerProps()}
              className="workspace-files-icon-btn"
              type="button"
              aria-label="用系统默认应用打开"
              onClick={() => void onOpenExternal()}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('用系统默认应用打开', event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip('用系统默认应用打开', event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('用系统默认应用打开', event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <ExternalOpenIcon />
            </button>
          </div>
        )}
      </div>
      {meta && <div className="workspace-preview-meta">{meta}</div>}
      {(saveMessage || saveError) && (
        <div className={`workspace-editor-status ${saveError ? 'error' : ''}`}>
          {saveError || saveMessage}
        </div>
      )}
      <div
        className="workspace-preview-body"
        onKeyDownCapture={(event) => {
          if (!editable || !dirty || saving) return
          const key = event.key.toLowerCase()
          if ((event.ctrlKey || event.metaKey) && key === 's') {
            event.preventDefault()
            void saveEditorContent()
          }
        }}
      >
        {loading && <WorkspacePlaceholder title="读取中" text="正在读取文件预览。" />}
        {!loading && error && <WorkspacePlaceholder title="预览失败" text={error} />}
        {!loading && !error && !preview && <WorkspacePlaceholder title="文件预览" text="代码、脚本、配置和可识别文本会进入内置 VS Code 工作台；图片/PDF 预览，Word/PPT/Excel 用文件卡片和系统应用。" />}
        {!loading && !error && editable && (
          <div className="workspace-editor-shell">
            <div className="workspace-editor-monaco">
              <Suspense fallback={<WorkspacePlaceholder title="载入编辑器" text="正在打开内置代码编辑器。" />}>
                <MonacoEditor
                  height="100%"
                  language={editorLanguage}
                  value={editorText}
                  theme="vs-dark"
                  onChange={(value) => updateEditorText(value ?? '')}
                  options={{
                    automaticLayout: true,
                    bracketPairColorization: { enabled: true },
                    cursorBlinking: 'smooth',
                    detectIndentation: true,
                    folding: true,
                    fontFamily: 'Consolas, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
                    fontSize: 12,
                    formatOnPaste: true,
                    guides: { bracketPairs: true, indentation: true },
                    lineDecorationsWidth: 8,
                    lineNumbers: 'on',
                    lineNumbersMinChars: 3,
                    minimap: { enabled: false },
                    overviewRulerBorder: false,
                    padding: { top: 10, bottom: 10 },
                    readOnly: !editing,
                    renderLineHighlight: editing ? 'all' : 'none',
                    renderWhitespace: 'selection',
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    tabSize: 2,
                    wordWrap: 'on',
                  }}
                />
              </Suspense>
            </div>
            <div className="workspace-editor-statusbar" aria-label="内置代码工作台状态">
              <span>{editing ? (dirty ? '编辑中*' : '编辑中') : '只读'}</span>
              <span>{editorLanguageLabel}</span>
              <span>{editorLineCount} 行</span>
              <span>{editorSize}</span>
              <span>{editorEol}</span>
              <span>{dirty ? '未保存' : '已同步'}</span>
            </div>
          </div>
        )}
        {!loading && !error && preview?.kind === 'image' && (
          <div className="workspace-preview-media">
            <img src={attachmentFileUrl(preview.path)} alt={preview.name} />
          </div>
        )}
        {!loading && !error && preview?.kind === 'pdf' && (
          <iframe className="workspace-preview-pdf" src={attachmentFileUrl(preview.path)} title={preview.name} />
        )}
        {!loading && !error && preview?.kind === 'unsupported' && (
          <div className="workspace-preview-unsupported">
            <FileGlyphIcon />
            <strong>{preview.name}</strong>
            <span>{preview.reason ?? '这个文件类型暂不支持内联预览。'}</span>
            <div className="workspace-preview-unsupported-actions">
              {canOpenExternalVSCode && (
                <button type="button" onClick={() => void onOpenInVSCode()}>
                  用外部 VS Code 打开
                </button>
              )}
              <button type="button" onClick={() => void onOpenExternal()}>
                用系统默认应用打开
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function WorkspaceTerminal({
  workspacePath,
  sessionId,
  onRequestCommandApproval,
  onTipChange,
}: {
  workspacePath: string
  sessionId?: string
  onRequestCommandApproval: (detail: unknown) => Promise<boolean>
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTermTerminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const streamAbortRef = useRef<AbortController | null>(null)
  const terminalSessionRef = useRef<string>('')
  const terminalBackendRef = useRef<'pty' | 'spawn'>('spawn')
  const terminalSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })
  const [command, setCommand] = useState('')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('启动中')
  const [terminalBackend, setTerminalBackend] = useState<'pty' | 'spawn' | ''>('')
  const [activities, setActivities] = useState<TerminalActivityRecord[]>([])
  const [activityError, setActivityError] = useState('')
  const [recentCommands, setRecentCommands] = useState<string[]>([])
  const [historyCursor, setHistoryCursor] = useState(-1)
  const historyDraftRef = useRef('')
  const commandInputRef = useRef<HTMLInputElement>(null)
  const focusFrameRef = useRef<number>()
  const activityRequestRef = useRef(0)
  const mountedRef = useRef(true)
  const commandHistory = useMemo(
    () => dedupeTerminalCommands([
      ...recentCommands,
      ...activities.map((activity) => activity.command),
    ]),
    [activities, recentCommands],
  )

  useEffect(() => {
    void refreshTerminalActivities()
  }, [workspacePath, sessionId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      activityRequestRef.current += 1
      window.cancelAnimationFrame(focusFrameRef.current ?? 0)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let terminal: XTermTerminal | null = null
    let resizeObserver: ResizeObserver | null = null
    let fitFrame = 0

    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !hostRef.current) return
        terminal = new Terminal({
          cols: 80,
          rows: 24,
          convertEol: true,
          cursorBlink: false,
          disableStdin: true,
          fontFamily: 'Consolas, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
          fontSize: 12,
          lineHeight: 1.32,
          theme: {
            background: '#1f1f1f',
            foreground: '#d7d7d7',
            cursor: '#d7d7d7',
            black: '#1f1f1f',
            red: '#d86666',
            green: '#77c38a',
            yellow: '#d8b45c',
            blue: '#7ea7d8',
            magenta: '#b99ad9',
            cyan: '#8ecaca',
            white: '#d7d7d7',
            brightBlack: '#777777',
            brightRed: '#ef8b8b',
            brightGreen: '#9ad8a9',
            brightYellow: '#e4c879',
            brightBlue: '#9bbfe3',
            brightMagenta: '#cdb2ea',
            brightCyan: '#a8dada',
            brightWhite: '#f0f0f0',
          },
        })
        const fitAddon = new FitAddon()
        terminal.loadAddon(fitAddon)
        terminal.open(hostRef.current)
        terminalRef.current = terminal
        fitAddonRef.current = fitAddon
        const fitTerminal = () => {
          if (disposed || !terminalRef.current || !fitAddonRef.current) return
          try {
            fitAddonRef.current.fit()
            reportTerminalSize()
          } catch {
            // The terminal can be momentarily hidden during animated layout changes.
          }
        }
        fitFrame = window.requestAnimationFrame(fitTerminal)
        resizeObserver = new ResizeObserver(() => {
          if (fitFrame) window.cancelAnimationFrame(fitFrame)
          fitFrame = window.requestAnimationFrame(fitTerminal)
        })
        resizeObserver.observe(hostRef.current)
        writeTerminalLine('LittleSheep PowerShell')
        writeTerminalLine(`cwd: ${workspacePath}`)
        writeTerminalLine('正在启动 LS 内置终端...')
        writeTerminalLine('')
        void startTerminalSession(() => disposed)
      })
      .catch((err) => {
        setStatus((err as Error).message)
      })

    return () => {
      disposed = true
      if (fitFrame) window.cancelAnimationFrame(fitFrame)
      resizeObserver?.disconnect()
      streamAbortRef.current?.abort()
      streamAbortRef.current = null
      const activeSessionId = terminalSessionRef.current
      terminalSessionRef.current = ''
      if (activeSessionId) void closeWorkspaceTerminalSession(activeSessionId).catch(() => undefined)
      terminal?.dispose()
      if (terminalRef.current === terminal) terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [workspacePath])

  async function startTerminalSession(isDisposed: () => boolean) {
    streamAbortRef.current?.abort()
    const controller = new AbortController()
    streamAbortRef.current = controller
    setStatus('启动中')
    try {
      const terminalSession = await createWorkspaceTerminalSession(
        workspacePath,
        terminalSizeRef.current.cols > 0 && terminalSizeRef.current.rows > 0
          ? terminalSizeRef.current
          : undefined,
      )
      if (isDisposed()) {
        await closeWorkspaceTerminalSession(terminalSession.sessionId).catch(() => undefined)
        return
      }
      terminalSessionRef.current = terminalSession.sessionId
      terminalBackendRef.current = terminalSession.backend ?? 'spawn'
      setTerminalBackend(terminalSession.backend ?? 'spawn')
      terminalSizeRef.current = { cols: terminalSession.cols, rows: terminalSession.rows }
      reportTerminalSize()
      setStatus(`${terminalSession.shell} 就绪`)
      await streamWorkspaceTerminalSession(terminalSession.sessionId, {
        signal: controller.signal,
        onStart: (event) => {
          if (isDisposed()) return
          terminalBackendRef.current = event.backend ?? 'spawn'
          setTerminalBackend(event.backend ?? 'spawn')
          setStatus(`${event.shell} 就绪`)
        },
        onStdout: (text) => {
          if (!isDisposed()) writeTerminalText(text)
        },
        onStderr: (text) => {
          if (!isDisposed()) writeTerminalText(text, 'stderr')
        },
        onExit: () => {
          if (!isDisposed()) setStatus('终端已退出')
        },
        onError: (message) => {
          if (isDisposed()) return
          writeTerminalLine(`\x1b[31m${message}\x1b[0m`)
          setStatus('终端错误')
        },
      })
    } catch (err) {
      const error = err as Error
      if (error.name === 'AbortError') return
      if (isDisposed()) return
      setStatus(error.message)
      writeTerminalLine(`\x1b[31m${error.message}\x1b[0m`)
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null
    }
  }

  function writeTerminalLine(line = '') {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.writeln(line)
  }

  function writeTerminalText(text: string, tone: 'normal' | 'stderr' = 'normal') {
    const terminal = terminalRef.current
    if (!terminal || !text) return
    if (terminalBackendRef.current === 'pty') {
      terminal.write(text)
      return
    }
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n')
    terminal.write(tone === 'stderr' ? `\x1b[33m${normalized}\x1b[0m` : normalized)
  }

  function reportTerminalSize() {
    const terminal = terminalRef.current
    if (!terminal || terminal.cols <= 0 || terminal.rows <= 0) return
    const nextSize = { cols: terminal.cols, rows: terminal.rows }
    if (nextSize.cols === terminalSizeRef.current.cols && nextSize.rows === terminalSizeRef.current.rows) return
    terminalSizeRef.current = nextSize
    const activeSessionId = terminalSessionRef.current
    if (activeSessionId) {
      void resizeWorkspaceTerminalSession(activeSessionId, nextSize.cols, nextSize.rows).catch(() => undefined)
    }
  }

  async function refreshTerminalActivities() {
    const requestId = ++activityRequestRef.current
    setActivityError('')
    try {
      const records = await listWorkspaceTerminalActivity(workspacePath, sessionId, 8)
      if (!mountedRef.current || requestId !== activityRequestRef.current) return
      setActivities(records)
    } catch (err) {
      if (!mountedRef.current || requestId !== activityRequestRef.current) return
      setActivityError((err as Error).message)
    }
  }

  function rememberTerminalCommand(nextCommand: string) {
    setRecentCommands((commands) => dedupeTerminalCommands([nextCommand, ...commands]).slice(0, 24))
    setHistoryCursor(-1)
    historyDraftRef.current = ''
  }

  function pickTerminalCommand(nextCommand: string) {
    setCommand(nextCommand)
    setHistoryCursor(-1)
    historyDraftRef.current = ''
    window.cancelAnimationFrame(focusFrameRef.current ?? 0)
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = undefined
      commandInputRef.current?.focus()
    })
  }

  function moveTerminalHistory(direction: 'older' | 'newer') {
    if (commandHistory.length === 0) return
    if (direction === 'older') {
      const nextCursor = historyCursor < 0 ? 0 : Math.min(historyCursor + 1, commandHistory.length - 1)
      if (historyCursor < 0) historyDraftRef.current = command
      setHistoryCursor(nextCursor)
      setCommand(commandHistory[nextCursor] ?? '')
      return
    }

    if (historyCursor < 0) return
    const nextCursor = historyCursor - 1
    if (nextCursor < 0) {
      setHistoryCursor(-1)
      setCommand(historyDraftRef.current)
      historyDraftRef.current = ''
      return
    }
    setHistoryCursor(nextCursor)
    setCommand(commandHistory[nextCursor] ?? '')
  }

  function handleTerminalInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveTerminalHistory('older')
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveTerminalHistory('newer')
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setCommand('')
      setHistoryCursor(-1)
      historyDraftRef.current = ''
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault()
      clearTerminal()
    }
  }

  async function submitCommand(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextCommand = command.trim()
    if (!nextCommand || running) return

    setCommand('')
    setRunning(true)
    try {
      const approved = await onRequestCommandApproval({
        command: nextCommand,
        cwd: workspacePath,
        root: workspacePath,
      })
      if (!approved) {
        writeTerminalLine('\x1b[33m已取消执行。\x1b[0m')
        writeTerminalLine('')
        setStatus('已取消')
        return
      }
      const activeSessionId = terminalSessionRef.current
      if (!activeSessionId) throw new Error('终端还没有启动完成。')
      await writeWorkspaceTerminalSession(activeSessionId, nextCommand, sessionId)
      rememberTerminalCommand(nextCommand)
      setStatus('PowerShell 就绪')
      void refreshTerminalActivities()
    } catch (err) {
      const error = err as Error
      writeTerminalLine(`\x1b[31m${error.message}\x1b[0m`)
      writeTerminalLine('')
      setStatus('失败')
    } finally {
      setRunning(false)
    }
  }

  async function interruptTerminal() {
    const activeSessionId = terminalSessionRef.current
    if (!activeSessionId) return
    try {
      await interruptWorkspaceTerminalSession(activeSessionId)
      setStatus('已发送 Ctrl+C')
    } catch (err) {
      const error = err as Error
      writeTerminalLine(`\x1b[31m${error.message}\x1b[0m`)
      setStatus('中断失败')
    }
  }

  async function stopAndRestartTerminal() {
    const activeSessionId = terminalSessionRef.current
    terminalSessionRef.current = ''
    streamAbortRef.current?.abort()
    setRunning(true)
    setStatus('正在停止')
    if (activeSessionId) await closeWorkspaceTerminalSession(activeSessionId).catch(() => undefined)
    writeTerminalLine('')
    writeTerminalLine('\x1b[33m正在停止当前 PowerShell 会话并重启...\x1b[0m')
    void startTerminalSession(() => false)
    setRunning(false)
  }

  function clearTerminal() {
    terminalRef.current?.clear()
    writeTerminalLine('LittleSheep PowerShell')
    writeTerminalLine(`cwd: ${workspacePath}`)
    writeTerminalLine('')
  }

  return (
    <div className="workspace-terminal">
      <header className="workspace-terminal-header">
        <div className="workspace-terminal-title">
          <span>终端</span>
          <small>{compactPath(workspacePath)}{terminalBackend ? ` · ${terminalBackend === 'pty' ? 'PTY' : 'fallback'}` : ''}</small>
        </div>
        <div className="workspace-terminal-actions">
          <span className={`workspace-terminal-status ${running ? 'running' : ''}`}>{status}</span>
          <button
            {...transientTriggerProps()}
            className="workspace-files-text-btn"
            type="button"
            onClick={() => void interruptTerminal()}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('向当前终端发送 Ctrl+C', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('向当前终端发送 Ctrl+C', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('向当前终端发送 Ctrl+C', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            中断
          </button>
          <button
            {...transientTriggerProps()}
            className="workspace-files-text-btn"
            type="button"
            onClick={() => void stopAndRestartTerminal()}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('停止当前 PowerShell 会话并重启', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('停止当前 PowerShell 会话并重启', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('停止当前 PowerShell 会话并重启', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            重启
          </button>
          <button
            {...transientTriggerProps()}
            className="workspace-files-text-btn"
            type="button"
            onClick={clearTerminal}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('清空终端输出', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('清空终端输出', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('清空终端输出', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            清空
          </button>
        </div>
      </header>
      <div className="workspace-terminal-activity" aria-label="最近终端命令">
        <div className="workspace-terminal-activity-heading">
          <span>最近命令</span>
          <button
            {...transientTriggerProps()}
            className="workspace-terminal-activity-refresh"
            type="button"
            onClick={() => void refreshTerminalActivities()}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('刷新最近命令', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('刷新最近命令', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('刷新最近命令', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            <RefreshIcon />
          </button>
        </div>
        <div className="workspace-terminal-activity-list">
          {activities.length === 0 && !activityError && (
            <span className="workspace-terminal-activity-empty">暂无命令记录</span>
          )}
          {activityError && (
            <span className="workspace-terminal-activity-empty error">{activityError}</span>
          )}
          {activities.map((activity) => (
            <button
              key={activity.id}
              type="button"
              className={`workspace-terminal-activity-row ${activity.exitCode === 0 && !activity.timedOut ? 'ok' : 'warn'}`}
              onClick={() => pickTerminalCommand(activity.command)}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(terminalActivityTip(activity), event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip(terminalActivityTip(activity), event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(terminalActivityTip(activity), event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <span className="workspace-terminal-activity-command">{activity.command}</span>
              <span className="workspace-terminal-activity-meta">
                {terminalActivityStatus(activity)} · {formatDurationMs(activity.durationMs)}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="workspace-terminal-shell" ref={hostRef} aria-label="终端输出" />
      <form className="workspace-terminal-command" onSubmit={submitCommand}>
        <span className="workspace-terminal-prompt" aria-hidden="true">$</span>
        <input
          ref={commandInputRef}
          value={command}
          disabled={running}
          placeholder={running ? '命令发送中...' : '输入 PowerShell 命令，在当前工作区执行'}
          aria-label="终端命令"
          spellCheck={false}
          onChange={(event) => {
            setCommand(event.target.value)
            setHistoryCursor(-1)
            historyDraftRef.current = ''
          }}
          onKeyDown={handleTerminalInputKeyDown}
        />
        <button
          {...transientTriggerProps()}
          className="workspace-terminal-run"
          type="submit"
          disabled={!command.trim() || running}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('执行命令', event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip('执行命令', event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('执行命令', event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          执行
        </button>
      </form>
    </div>
  )
}

function terminalActivityStatus(activity: TerminalActivityRecord): string {
  if (activity.signal === 'session') return '已发送'
  if (activity.signal === 'captured' || activity.signal === 'next-command') return '已记录'
  if (activity.signal === 'interrupt') return '已中断'
  if (activity.signal === 'closed') return '已关闭'
  if (activity.signal === 'send-failed') return '发送失败'
  if (activity.timedOut) return '超时'
  if (activity.exitCode === 0) return '成功'
  return `退出 ${activity.exitCode ?? activity.signal ?? '异常'}`
}

function dedupeTerminalCommands(commands: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const command of commands) {
    const normalized = command.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function terminalActivityTip(activity: TerminalActivityRecord): string {
  const parts = [
    activity.command,
    `cwd: ${activity.cwd}`,
    `${terminalActivityStatus(activity)} · ${formatDurationMs(activity.durationMs)}`,
  ]
  if (activity.stdoutPreview) parts.push(`stdout: ${activity.stdoutPreview.slice(0, 240)}`)
  if (activity.stderrPreview) parts.push(`stderr: ${activity.stderrPreview.slice(0, 240)}`)
  return parts.join('\n')
}

function WorkspacePlaceholder({ title, text }: { title: string; text: string }) {
  return (
    <div className="workspace-placeholder">
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  )
}

function ApprovalPrompt({
  prompt,
  onResolve,
}: {
  prompt: PendingApprovalPrompt | null
  onResolve: (decision: ApprovalDecision) => void
}) {
  const lastPromptRef = useRef<PendingApprovalPrompt | null>(prompt)
  if (prompt) lastPromptRef.current = prompt
  const displayedPrompt = prompt ?? lastPromptRef.current
  return createPortal(
    <FadePresence show={Boolean(prompt)} exitMs={APPROVAL_PROMPT_MOTION_MS} className="approval-presence">
      {displayedPrompt && (
        <ApprovalPromptSurface prompt={displayedPrompt} onResolve={onResolve} />
      )}
    </FadePresence>,
    document.body,
  )
}

function ApprovalPromptSurface({
  prompt,
  onResolve,
}: {
  prompt: PendingApprovalPrompt
  onResolve: (decision: ApprovalDecision) => void
}) {
  const { request } = prompt
  const source = request.source ?? 'agent'
  return (
    <div
      className="approval-layer"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onResolve('deny')
      }}
    >
      <section className="approval-prompt" role="dialog" aria-modal="true" aria-label="权限确认">
        <div className="approval-kicker">{source === 'workspace' ? '用户工作区操作' : 'Agent 工具调用'}</div>
        <h2>{approvalActionTitle(request.action)}</h2>
        <p>{approvalModeDescription(request.permissionMode)}</p>
        <p className="approval-risk-note">{approvalActionRiskDescription(request.action, source)}</p>
        <pre>{formatApprovalDetail(request.detail)}</pre>
        <p className="approval-session-note">“本对话允许”只授权当前对话中的同来源、同类操作；切换类别或重启应用后仍会重新询问。</p>
        <div className="approval-actions">
          <button type="button" className="approval-action" onClick={() => onResolve('deny')}>
            拒绝
          </button>
          <button type="button" className="approval-action session" onClick={() => onResolve('session')}>
            本对话允许
          </button>
          <button type="button" className="approval-action primary" autoFocus onClick={() => onResolve('once')}>
            仅本次
          </button>
        </div>
      </section>
    </div>
  )
}

function DirtyFileClosePrompt({
  file,
  onCancel,
  onConfirm,
}: {
  file: { root: string; path: string } | null
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!file) return null
  return createPortal(
    <div className="approval-layer" role="presentation">
      <section className="approval-prompt dirty-file-prompt" role="dialog" aria-modal="true" aria-label="关闭未保存文件">
        <div className="approval-kicker">未保存修改</div>
        <h2>关闭这个文件？</h2>
        <p>这个文件还有未保存的修改。继续关闭会放弃当前标签里的编辑内容。</p>
        <pre>{file.path}</pre>
        <div className="approval-actions">
          <button type="button" className="approval-action" onClick={onCancel}>
            返回编辑
          </button>
          <button type="button" className="approval-action primary danger" onClick={onConfirm}>
            继续关闭
          </button>
        </div>
      </section>
    </div>,
    document.body,
  )
}

function approvalActionTitle(action: string): string {
  if (action === 'exec') return '允许执行命令？'
  if (action === 'write') return '允许写入文件？'
  if (action === 'edit') return '允许修改文件？'
  if (action === 'write_memory') return '允许写入长期记忆？'
  if (action === 'create_skill') return '允许创建技能？'
  if (action === 'record_experience') return '允许记录经验？'
  if (action === 'save_file') return '允许保存工作区文件？'
  return `允许执行 ${action}？`
}

function approvalModeDescription(mode: PermissionModeId): string {
  if (mode === 'restricted') return '当前为受限权限，所有工具调用都需要你批准后才会继续。'
  if (mode === 'research') return '当前为研究权限，涉及修改、命令或长期沉淀的动作需要你批准。'
  return '当前为完全访问权限。'
}

function approvalActionRiskDescription(action: string, source: 'agent' | 'workspace'): string {
  const actor = source === 'workspace' ? '你在拓展工作区发起的操作' : 'Agent 为完成当前任务发起的操作'
  if (action === 'exec') return `${actor}将执行命令，可能修改工作区文件或启动本地进程。`
  if (action === 'write' || action === 'edit' || action === 'save_file') {
    return `${actor}将修改所示文件；请确认目标路径和变更范围。`
  }
  return `${actor}需要临时使用这项工具能力。`
}

function formatApprovalDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return '无额外参数'
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail, null, 2)
  } catch {
    return String(detail)
  }
}

function AssistantTurnMessage({
  message,
  now,
  onOpenFile,
  onToggleActivity,
}: {
  message: ChatMessage
  now: number
  onOpenFile: (path: string) => void
  onToggleActivity: () => void
}) {
  const activity = message.activity
  if (!activity) {
    return (
      <div className="message assistant">
        {message.text ? <Markdown text={message.text} /> : <span className="loading">思考中...</span>}
        {(message.trace || message.toolCalls) && (
          <TraceCard trace={message.trace} toolCalls={message.toolCalls} durationMs={message.durationMs} onOpenFile={onOpenFile} />
        )}
        {message.artifacts && message.artifacts.length > 0 && (
          <MessageFileStrip files={message.artifacts} label="产物" onOpenFile={onOpenFile} />
        )}
      </div>
    )
  }

  const collapsed = Boolean(message.activityCollapsed)
  const commandCount = activity.tools.length
  const runningCommands = activity.tools.filter((tool) => tool.ok === undefined).length

  return (
    <section className={`assistant-turn ${activity.status} ${collapsed ? 'collapsed' : ''}`}>
      <button
        type="button"
        className="assistant-turn-header"
        aria-expanded={!collapsed}
        onClick={onToggleActivity}
      >
        <span className={`assistant-turn-status ${activity.status === 'running' ? 'is-running' : ''}`}>
          {assistantTurnStatusLabel(activity, now)}
        </span>
        <span className="assistant-turn-chevron" aria-hidden="true" />
      </button>
      <div className={`assistant-turn-process disclosure-panel ${collapsed ? '' : 'open'}`} aria-hidden={collapsed}>
        <div className="assistant-turn-process-inner">
          <ActivityDisclosure title="指令" meta="1 条" defaultOpen={false}>
            <div className="assistant-turn-instruction">
              <Markdown text={activity.instruction} />
            </div>
          </ActivityDisclosure>
          <ActivityDisclosure
            title="执行过程"
            meta={runningCommands > 0 ? `正在运行 ${runningCommands} 条命令` : commandCount > 0 ? `已运行 ${commandCount} 条命令` : '等待执行'}
            defaultOpen={executionDisclosureDefaultOpen(activity.status)}
            resetKey={executionDisclosureResetKey(activity.status)}
          >
            <ActivityTimeline activity={activity} now={now} onOpenFile={onOpenFile} />
          </ActivityDisclosure>
          {(activity.verificationRunning || (activity.verificationHistory?.length ?? 0) > 0) && (
            <ActivityDisclosure
              title="验证"
              meta={activity.verificationRunning ? '正在验证' : verificationSummary(activity.verificationHistory)}
              defaultOpen={verificationDisclosureDefaultOpen(Boolean(activity.verificationRunning))}
              resetKey={verificationDisclosureResetKey(activity.status, Boolean(activity.verificationRunning))}
            >
              <VerificationTimeline activity={activity} />
            </ActivityDisclosure>
          )}
        </div>
      </div>
      <div className="message assistant assistant-final">
        {message.text ? <Markdown text={message.text} /> : <span className="loading task-running-text is-running">正在执行...</span>}
        {message.artifacts && message.artifacts.length > 0 && (
          <MessageFileStrip files={message.artifacts} label="产物" onOpenFile={onOpenFile} />
        )}
      </div>
    </section>
  )
}

function ActivityDisclosure({
  title,
  meta,
  defaultOpen = false,
  resetKey,
  children,
}: {
  title: string
  meta?: string
  defaultOpen?: boolean
  resetKey?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => {
    if (resetKey !== undefined) setOpen(defaultOpen)
  }, [defaultOpen, resetKey])

  return (
    <section className={`activity-disclosure ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="activity-disclosure-header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="activity-disclosure-title">{title}</span>
        {meta && <span className="activity-disclosure-meta">{meta}</span>}
        <span className="activity-disclosure-chevron" aria-hidden="true" />
      </button>
      <div className={`activity-disclosure-body disclosure-panel ${open ? 'open' : ''}`} aria-hidden={!open}>
        <div className="activity-disclosure-inner">{children}</div>
      </div>
    </section>
  )
}

function ActivityTimeline({
  activity,
  now,
  onOpenFile,
}: {
  activity: AssistantTurnActivity
  now: number
  onOpenFile: (path: string) => void
}) {
  if (activity.steps.length === 0 && activity.tools.length === 0) {
    return <div className="activity-empty">等待状态机进入执行阶段。</div>
  }

  return (
    <div className="activity-timeline">
      {activity.steps.map((step) => {
        const tools = activity.tools.filter((tool) => tool.stepId === step.stepId)
        return (
          <div key={step.stepId} className={`activity-timeline-step ${step.status}`}>
            <div className="activity-timeline-step-head">
              <span className="activity-step-dot" aria-hidden="true" />
              <span className={`activity-timeline-title ${step.status === 'running' ? 'is-running' : ''}`}>
                {step.status === 'running' ? '正在执行' : liveStepStatusLabel(step.status)}：{step.title}
              </span>
              <span className="activity-timeline-duration">{formatMaybeDuration(step.startedAt, step.endedAt, now)}</span>
            </div>
            {step.description && <div className="activity-timeline-copy">{shortActivityText(step.description, 130)}</div>}
            {tools.length > 0 && <ActivityToolList tools={tools} now={now} onOpenFile={onOpenFile} />}
          </div>
        )
      })}
      {activity.tools.some((tool) => !tool.stepId) && (
        <ActivityToolList tools={activity.tools.filter((tool) => !tool.stepId)} now={now} onOpenFile={onOpenFile} />
      )}
    </div>
  )
}

function VerificationTimeline({ activity }: { activity: AssistantTurnActivity }) {
  const records = activity.verificationHistory ?? []
  return (
    <div className="verification-timeline">
      {records.map((record) => (
        <div key={`${record.attempt}:${record.verifiedAt}`} className={`verification-record ${record.verdict}`}>
          <span className="verification-record-dot" aria-hidden="true" />
          <span className="verification-record-main">
            <strong>{verificationVerdictLabel(record.verdict)}</strong>
            <span>{record.reason}</span>
          </span>
          <span className="verification-record-attempt">第 {record.attempt} 次</span>
        </div>
      ))}
      {activity.verificationRunning && (
        <div className="verification-record running">
          <span className="verification-record-dot" aria-hidden="true" />
          <span className="verification-record-main">
            <strong className="is-running">正在验证</strong>
            <span>按任务目标、步骤证据和验收标准检查结果。</span>
          </span>
        </div>
      )}
    </div>
  )
}

function ActivityToolList({
  tools,
  now,
  onOpenFile,
}: {
  tools: LiveToolEvent[]
  now: number
  onOpenFile: (path: string) => void
}) {
  return (
    <div className="activity-command-list">
      {tools.map((tool) => (
        <ActivityCommandItem key={tool.callId} tool={tool} now={now} onOpenFile={onOpenFile} />
      ))}
    </div>
  )
}

function ActivityCommandItem({
  tool,
  now,
  onOpenFile,
}: {
  tool: LiveToolEvent
  now: number
  onOpenFile: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const status = tool.ok === undefined ? '正在运行' : tool.ok ? '已运行' : '运行失败'
  const commandText = formatToolInput(tool)
  const resultText = formatToolResult(tool)
  const targetPath = toolFilePath(tool.input)

  return (
    <section className={`activity-command ${liveToolStatusClass(tool)} ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="activity-command-header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="activity-command-icon" aria-hidden="true" />
        <span className={`activity-command-label ${tool.ok === undefined ? 'is-running' : ''}`}>
          {status} {tool.name}
        </span>
        <span className="activity-command-duration">{formatMaybeDuration(tool.startedAt, tool.endedAt, now)}</span>
        <span className="activity-command-chevron" aria-hidden="true" />
      </button>
      <div className={`activity-command-body disclosure-panel ${open ? 'open' : ''}`} aria-hidden={!open}>
        <div className="activity-command-shell">
          <div className="activity-command-shell-title">
            <span>{toolShellTitle(tool.name)}</span>
            {targetPath && (
              <button
                type="button"
                className="activity-command-file-action"
                onClick={() => onOpenFile(targetPath)}
              >
                <FileGlyphIcon />
                <span>打开文件</span>
              </button>
            )}
          </div>
          {commandText && <pre>{commandText}</pre>}
          {resultText && <pre className={tool.ok === false ? 'error' : ''}>{resultText}</pre>}
          {!commandText && !resultText && <div className="activity-command-empty">暂无可展开内容。</div>}
          {tool.ok !== undefined && (
            <div className={`activity-command-shell-status ${tool.ok ? 'pass' : 'fail'}`}>
              {tool.ok ? '成功' : '失败'}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function historyMessageToChatMessage(message: HistoryMessage): ChatMessage {
  const artifacts = buildArtifactsFromLiveTools(message.activity?.tools)
  return {
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
    durationMs: message.durationMs,
    activity: message.activity,
    activityCollapsed: message.activityCollapsed,
    artifacts,
  }
}

function collectWorkspaceArtifacts(messages: ChatMessage[]): WorkspaceArtifactRef[] {
  const byPath = new Map<string, WorkspaceArtifactRef>()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const artifacts = messages[index]?.artifacts ?? []
    for (const artifact of artifacts) {
      const key = normalizePathForCompare(artifact.path)
      if (!key || byPath.has(key)) continue
      byPath.set(key, artifact)
    }
  }
  return Array.from(byPath.values()).slice(0, 12)
}

function workspaceArtifactRecordToRef(record: WorkspaceArtifactRecord): WorkspaceArtifactRef {
  return {
    path: record.path,
    name: record.name,
    action: record.action,
    toolName: record.toolName,
  }
}

function mergeWorkspaceArtifacts(artifacts: WorkspaceArtifactRef[]): WorkspaceArtifactRef[] {
  const byPath = new Map<string, WorkspaceArtifactRef>()
  for (const artifact of artifacts) {
    const key = normalizePathForCompare(artifact.path)
    if (!key || byPath.has(key)) continue
    byPath.set(key, artifact)
  }
  return Array.from(byPath.values()).slice(0, 12)
}

function buildWorkspaceActivityFeed(
  messages: ChatMessage[],
  terminalActivities: TerminalActivityRecord[],
  indexedArtifacts: WorkspaceArtifactRecord[] = [],
): WorkspaceActivityFeedItem[] {
  const items: WorkspaceActivityFeedItem[] = []

  messages.forEach((message, index) => {
    const fallbackTimestamp = parseMessageTimestamp(message, index)
    if (message.role === 'assistant' && message.activity) {
      const activity = message.activity
      const timestamp = activity.endedAt ?? activity.startedAt ?? fallbackTimestamp
      const stepCount = activity.steps.length
      const toolCount = activity.tools.length
      const duration = formatDurationMs(activity.durationMs ?? Math.max(0, (activity.endedAt ?? timestamp) - activity.startedAt))
      items.push({
        id: `agent:${index}:${timestamp}`,
        kind: 'agent',
        title: workspaceActivityStatusLabel(activity.status),
        detail: `${stepCount} 个步骤 · ${toolCount} 个工具 · ${duration}`,
        timestamp,
        status: activity.status,
      })
    }

    for (const artifact of message.artifacts ?? []) {
      items.push({
        id: `artifact:${index}:${artifact.action}:${artifact.path}`,
        kind: 'artifact',
        title: `${fileActionLabel(artifact.action)} ${artifact.name}`,
        detail: compactPath(artifact.path),
        timestamp: fallbackTimestamp,
        artifact,
      })
    }
  })

  const indexedArtifactKeys = new Set(items
    .filter((item) => item.kind === 'artifact' && item.artifact)
    .map((item) => normalizePathForCompare(item.artifact!.path)))
  for (const artifact of indexedArtifacts) {
    const key = normalizePathForCompare(artifact.path)
    if (!key || indexedArtifactKeys.has(key)) continue
    indexedArtifactKeys.add(key)
    items.push({
      id: `indexed-artifact:${artifact.id}`,
      kind: 'artifact',
      title: `${fileActionLabel(artifact.action)} ${artifact.name}`,
      detail: `${artifact.source === 'user' ? '用户保存' : 'Agent 产物'} · ${compactPath(artifact.path)}`,
      timestamp: Date.parse(artifact.createdAt),
      artifact: workspaceArtifactRecordToRef(artifact),
    })
  }

  for (const activity of terminalActivities) {
    const timestamp = Date.parse(activity.endedAt)
    items.push({
      id: `terminal:${activity.id}`,
      kind: 'terminal',
      title: `终端 · ${shortActivityText(activity.command, 48)}`,
      detail: `${terminalActivityStatus(activity)} · ${formatDurationMs(activity.durationMs)}`,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      status: terminalActivityStatus(activity),
    })
  }

  return items
    .filter((item) => Number.isFinite(item.timestamp))
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, 14)
}

function workspaceActivitySearchText(item: WorkspaceActivityFeedItem): string {
  return [
    item.kind,
    item.title,
    item.detail,
    item.status,
    item.artifact?.name,
    item.artifact?.path,
    item.artifact?.toolName,
  ].filter(Boolean).join(' ').toLowerCase()
}

function parseMessageTimestamp(message: ChatMessage, fallbackIndex: number): number {
  const parsed = message.timestamp ? Date.parse(message.timestamp) : NaN
  return Number.isFinite(parsed) ? parsed : fallbackIndex
}

function workspaceActivityStatusLabel(status: AssistantTurnStatus): string {
  if (status === 'running') return 'Agent 正在执行'
  if (status === 'failed') return 'Agent 执行失败'
  if (status === 'aborted') return 'Agent 已停止'
  return 'Agent 完成一轮任务'
}

function readNumberPreference(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key)
    const value = raw ? Number(raw) : fallback
    return clampNumber(Number.isFinite(value) ? value : fallback, min, max)
  } catch {
    return fallback
  }
}

function writeNumberPreference(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(Math.round(value)))
  } catch {
    // Local UI preferences are best-effort only.
  }
}

function readBooleanPreference(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === 'true') return true
    if (raw === 'false') return false
    return fallback
  } catch {
    return fallback
  }
}

function writeBooleanPreference(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? 'true' : 'false')
  } catch {
    // Local UI preferences are best-effort only.
  }
}

function readStringSetPreference(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return new Set()
    const values = JSON.parse(raw)
    if (!Array.isArray(values)) return new Set()
    return new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))
  } catch {
    return new Set()
  }
}

function writeStringSetPreference(key: string, values: Set<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(values)))
  } catch {
    // Local UI preferences are best-effort only.
  }
}

function readStringPreference(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeStringPreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Local UI preferences are best-effort only.
  }
}

function removePreference(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Local UI preferences are best-effort only.
  }
}

function readWorkspaceOpenRequestPreference(): WorkspaceOpenRequest | null {
  try {
    const root = window.localStorage.getItem(WORKSPACE_PANEL_OPEN_ROOT_KEY) ?? ''
    const path = window.localStorage.getItem(WORKSPACE_PANEL_OPEN_PATH_KEY) ?? ''
    if (!root || !path) return null
    return { id: Date.now(), root, path }
  } catch {
    return null
  }
}

function writeWorkspaceOpenRequestPreference(request: WorkspaceOpenRequest | null): void {
  try {
    if (!request) {
      window.localStorage.removeItem(WORKSPACE_PANEL_OPEN_ROOT_KEY)
      window.localStorage.removeItem(WORKSPACE_PANEL_OPEN_PATH_KEY)
      return
    }
    window.localStorage.setItem(WORKSPACE_PANEL_OPEN_ROOT_KEY, request.root)
    window.localStorage.setItem(WORKSPACE_PANEL_OPEN_PATH_KEY, request.path)
  } catch {
    // Local UI preferences are best-effort only.
  }
}

function readWorkspaceFileDraftsPreference(): Record<string, WorkspaceFileDraftState> {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_FILE_DRAFTS_KEY)
    if (!raw || raw.length > WORKSPACE_FILE_DRAFTS_MAX_CHARS * 2) return {}
    return hydrateWorkspaceFileDrafts(JSON.parse(raw) as unknown)
  } catch {
    return {}
  }
}

function writeWorkspaceFileDraftsPreference(
  drafts: Record<string, WorkspaceFileDraftState>,
  openTabs: WorkspacePanelTabId[],
): void {
  try {
    const payload = serializeWorkspaceFileDrafts(drafts, openTabs)
    if (Object.keys(payload).length === 0) {
      window.localStorage.removeItem(WORKSPACE_FILE_DRAFTS_KEY)
      return
    }
    window.localStorage.setItem(WORKSPACE_FILE_DRAFTS_KEY, JSON.stringify(payload))
  } catch {
    // Draft recovery is best-effort; the source files remain authoritative.
  }
}

function readWorkspaceLayoutFallbackMarkers() {
  try {
    return {
      width: window.localStorage.getItem(WORKSPACE_PANEL_WIDTH_KEY),
      activeTab: window.localStorage.getItem(WORKSPACE_PANEL_TAB_KEY),
      openTabs: window.localStorage.getItem(WORKSPACE_PANEL_OPEN_TABS_KEY),
      openRoot: window.localStorage.getItem(WORKSPACE_PANEL_OPEN_ROOT_KEY),
      openPath: window.localStorage.getItem(WORKSPACE_PANEL_OPEN_PATH_KEY),
      drafts: window.localStorage.getItem(WORKSPACE_FILE_DRAFTS_KEY),
    }
  } catch {
    return {
      width: null,
      activeTab: null,
      openTabs: null,
      openRoot: null,
      openPath: null,
      drafts: null,
    }
  }
}

function shouldApplyWorkspaceLayoutFallback(
  snapshotWorkspacePath: string,
  defaultWorkspacePath: string,
  openRequest: WorkspaceOpenRequest | null,
): boolean {
  if (isSamePath(snapshotWorkspacePath, defaultWorkspacePath)) return true
  return Boolean(openRequest && isSamePath(openRequest.root, snapshotWorkspacePath))
}

function readProjectSortPreference(key: string): ProjectSortMode {
  try {
    const value = window.localStorage.getItem(key)
    if (value === 'fixed' || value === 'recent' || value === 'name') return value
  } catch {
    // Local UI preferences are best-effort only.
  }
  return 'fixed'
}

function readWorkspacePanelTabPreference(key: string): WorkspacePanelTabId {
  try {
    const value = normalizeWorkspacePanelTabId(window.localStorage.getItem(key))
    if (value) return value
  } catch {
    // Local UI preferences are best-effort only.
  }
  return 'review'
}

function readWorkspacePanelOpenTabsPreference(): WorkspacePanelTabId[] {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_PANEL_OPEN_TABS_KEY)
    if (!raw) return DEFAULT_WORKSPACE_PANEL_TABS
    const values = JSON.parse(raw)
    return hydrateWorkspacePanelTabs(values)
  } catch {
    return DEFAULT_WORKSPACE_PANEL_TABS
  }
}

function writeWorkspacePanelOpenTabsPreference(tabs: WorkspacePanelTabId[]): void {
  try {
    window.localStorage.setItem(WORKSPACE_PANEL_OPEN_TABS_KEY, JSON.stringify(dedupeWorkspacePanelTabs(tabs)))
  } catch {
    // Local UI preferences are best-effort only.
  }
}

function useListReorderAnimation<T extends HTMLElement>(keys: string[]) {
  const nodesRef = useRef(new Map<string, T>())
  const positionsRef = useRef(new Map<string, DOMRect>())
  const keySignature = keys.join('\u001f')

  useLayoutEffect(() => {
    const previous = positionsRef.current
    const next = new Map<string, DOMRect>()

    for (const key of keys) {
      const node = nodesRef.current.get(key)
      if (!node) continue
      const rect = node.getBoundingClientRect()
      const oldRect = previous.get(key)
      next.set(key, rect)
      if (!oldRect) continue
      const dx = oldRect.left - rect.left
      const dy = oldRect.top - rect.top
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
      node.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: 'translate(0, 0)' },
        ],
        {
          duration: 240,
          easing: 'cubic-bezier(0.22, 0.72, 0.2, 1)',
        },
      )
    }

    positionsRef.current = next
  }, [keySignature])

  return (key: string) => (node: T | null) => {
    if (node) {
      nodesRef.current.set(key, node)
    } else {
      nodesRef.current.delete(key)
    }
  }
}

function formatRelativeSessionTime(timestamp: number, now: number): string {
  const diffMs = Math.max(0, now - timestamp)
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}月`
  return `${Math.floor(days / 365)}年`
}

function sortSessionsForSidebar(sessions: SessionMeta[], pinnedIds: Set<string>): SessionMeta[] {
  return [...sessions].sort((left, right) => {
    const leftPinned = pinnedIds.has(left.id)
    const rightPinned = pinnedIds.has(right.id)
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1
    return right.lastMessageAt - left.lastMessageAt
  })
}

function sortProjectsForSidebar(projects: ProjectMeta[], mode: ProjectSortMode): ProjectMeta[] {
  if (mode === 'fixed') return projects
  return [...projects].sort((left, right) => {
    if (mode === 'recent') {
      return Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt)
    }
    return (left.name || lastPathSegment(left.path)).localeCompare(
      right.name || lastPathSegment(right.path),
      'zh-Hans-CN',
      { sensitivity: 'base' },
    )
  })
}

function standaloneSessionsForSidebar(sessions: SessionMeta[]): SessionMeta[] {
  return standaloneSessions(sessions)
}

function routesEqual(left: AppRoute | undefined, right: AppRoute): boolean {
  if (!left || left.section !== right.section) return false
  if (left.section === 'chat' && right.section === 'chat') return true
  if (left.section === 'settings' && right.section === 'settings') return left.page === right.page
  if (left.section === 'module' && right.section === 'module') return left.page === right.page
  return false
}

function isDirectModulePage(page: SettingsPage): page is DirectModulePage {
  return page === 'memoryTree' || page === 'scheduled' || page === 'plugins'
}

function rebindNavigationSnapshotWorkspace(
  snapshot: AppNavigationSnapshot,
  fromPath: string,
  toPath: string,
): AppNavigationSnapshot {
  const rebound = rebindWorkspacePanelState({
    openRequest: snapshot.workspaceOpenRequest
      ? { id: 0, ...snapshot.workspaceOpenRequest }
      : null,
    openTabs: snapshot.workspacePanelOpenTabs,
    activeTab: snapshot.workspacePanelTab,
    drafts: {},
  }, fromPath, toPath)
  return {
    ...snapshot,
    workspacePanelTab: rebound.activeTab,
    workspacePanelOpenTabs: rebound.openTabs,
    workspaceOpenRequest: rebound.openRequest
      ? { root: rebound.openRequest.root, path: rebound.openRequest.path }
      : null,
    workspaceExpandedPaths: [...new Set(snapshot.workspaceExpandedPaths.map((path) => (
      rebindWorkspacePath(path, fromPath, toPath)
    )))],
  }
}

function navigationSnapshotsEqual(
  left: AppNavigationSnapshot | undefined,
  right: AppNavigationSnapshot,
): boolean {
  if (!left) return false
  return routesEqual(left.route, right.route)
    && left.sidebarCollapsed === right.sidebarCollapsed
    && left.sidebarWidth === right.sidebarWidth
    && left.conversationCollapsed === right.conversationCollapsed
    && left.sidebarPanel === right.sidebarPanel
    && left.workspacePanelCollapsed === right.workspacePanelCollapsed
    && left.workspacePanelFullscreen === right.workspacePanelFullscreen
    && left.workspacePanelWidth === right.workspacePanelWidth
    && left.workspacePanelTab === right.workspacePanelTab
    && stringListsEqual(left.workspacePanelOpenTabs, right.workspacePanelOpenTabs)
    && left.workspaceOpenRequest?.root === right.workspaceOpenRequest?.root
    && left.workspaceOpenRequest?.path === right.workspaceOpenRequest?.path
    && left.workspaceFileNavigatorCollapsed === right.workspaceFileNavigatorCollapsed
    && stringListsEqual(left.workspaceExpandedPaths, right.workspaceExpandedPaths)
}

function stringListsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function upsertLiveStep(
  steps: LiveStepEvent[],
  next: Partial<LiveStepEvent> & { stepId: string },
): LiveStepEvent[] {
  const existing = steps.find((step) => step.stepId === next.stepId)
  const merged: LiveStepEvent = {
    stepId: next.stepId,
    title: (next.title || existing?.title || '执行步骤').trim(),
    description: next.description ?? existing?.description,
    status: next.status ?? existing?.status ?? 'running',
    startedAt: next.startedAt ?? existing?.startedAt,
    endedAt: next.endedAt ?? existing?.endedAt,
    output: next.output ?? existing?.output,
    error: next.error ?? existing?.error,
    toolCount: next.toolCount ?? existing?.toolCount ?? 0,
    activeTools: Math.max(0, next.activeTools ?? existing?.activeTools ?? 0),
  }

  if (!existing) return [...steps, merged]
  return steps.map((step) => (step.stepId === next.stepId ? merged : step))
}

function mergeTaskBookIntoLiveSteps(steps: LiveStepEvent[], taskBook: TaskBook): LiveStepEvent[] {
  const existing = new Map(steps.map((step) => [step.stepId, step]))
  return taskBook.steps.map((step, index) => {
    const stepId = step.id ?? `step-${index + 1}`
    const current = existing.get(stepId)
    return {
      stepId,
      title: step.title || current?.title || step.description || '执行步骤',
      description: step.description || current?.description,
      status: current?.status ?? coerceLiveStepStatus(step.status ?? 'pending'),
      startedAt: current?.startedAt,
      endedAt: current?.endedAt,
      output: current?.output,
      error: current?.error,
      toolCount: current?.toolCount ?? 0,
      activeTools: current?.activeTools ?? 0,
    }
  })
}

function bumpLiveStepTools(steps: LiveStepEvent[], stepId: string, delta: 1 | -1): LiveStepEvent[] {
  if (!stepId) return steps
  const hasStep = steps.some((step) => step.stepId === stepId)
  if (!hasStep && delta > 0) {
    return [
      ...steps,
      {
        stepId,
        title: '执行步骤',
        status: 'running',
        startedAt: Date.now(),
        toolCount: 1,
        activeTools: 1,
      },
    ]
  }

  return steps.map((step) => {
    if (step.stepId !== stepId) return step
    if (delta > 0) {
      return {
        ...step,
        toolCount: step.toolCount + 1,
        activeTools: step.activeTools + 1,
      }
    }
    return {
      ...step,
      activeTools: Math.max(0, step.activeTools - 1),
    }
  })
}

function upsertLiveTool(
  tools: LiveToolEvent[],
  next: Partial<LiveToolEvent> & { callId: string; name: string },
): LiveToolEvent[] {
  const existing = tools.find((tool) => tool.callId === next.callId)
  const merged: LiveToolEvent = {
    callId: next.callId,
    name: next.name || existing?.name || 'tool',
    stepId: next.stepId ?? existing?.stepId,
    startedAt: next.startedAt ?? existing?.startedAt,
    endedAt: next.endedAt ?? existing?.endedAt,
    input: next.input ?? existing?.input,
    ok: Object.prototype.hasOwnProperty.call(next, 'ok') ? next.ok : existing?.ok,
    output: next.output ?? existing?.output,
    error: next.error ?? existing?.error,
  }

  if (!existing) return [...tools, merged]
  return tools.map((tool) => (tool.callId === next.callId ? merged : tool))
}

function updateLastAssistantActivity(
  setMessages: (updater: (messages: ChatMessage[]) => ChatMessage[]) => void,
  update: (activity: AssistantTurnActivity) => AssistantTurnActivity,
): void {
  setMessages((messages) => {
    const next = [...messages]
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const message = next[index]
      if (message?.role !== 'assistant' || !message.activity) continue
      next[index] = { ...message, activity: update(message.activity) }
      break
    }
    return next
  })
}

function assistantTurnStatusLabel(activity: AssistantTurnActivity, now: number): string {
  const duration = formatDurationMs(activity.durationMs ?? ((activity.endedAt ?? now) - activity.startedAt))
  if (activity.status === 'running') return `处理中 ${duration}`
  if (activity.status === 'failed') return `处理失败 ${duration}`
  if (activity.status === 'aborted') return `已停止 ${duration}`
  return `已处理 ${duration}`
}

function formatMaybeDuration(startedAt: number | undefined, endedAt: number | undefined, now: number): string {
  if (!startedAt) return ''
  return formatDurationMs((endedAt ?? now) - startedAt)
}

function formatDurationMs(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms))
  if (safeMs < 60_000) {
    const seconds = safeMs / 1000
    return `${seconds < 10 ? seconds.toFixed(1) : seconds.toFixed(1).replace(/\.0$/, '')}s`
  }
  const totalSeconds = Math.max(1, Math.floor(safeMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

function taskStepToLiveStep(step: {
  stepId: string
  title?: string
  description: string
  status: string
  startedAt?: string
  endedAt?: string
  output?: string
  error?: string
  toolCallIds?: string[]
}): LiveStepEvent {
  return {
    stepId: step.stepId,
    title: step.title || step.description || '执行步骤',
    description: step.description,
    status: coerceLiveStepStatus(step.status),
    startedAt: step.startedAt ? Date.parse(step.startedAt) : undefined,
    endedAt: step.endedAt ? Date.parse(step.endedAt) : undefined,
    output: step.output,
    error: step.error,
    toolCount: step.toolCallIds?.length ?? 0,
    activeTools: 0,
  }
}

function coerceLiveStepStatus(status: string): LiveStepStatus {
  if (status === 'pending') return 'pending'
  if (status === 'done' || status === 'failed' || status === 'skipped') return status
  if (status === 'blocked') return 'failed'
  return 'running'
}

function liveStepStatusLabel(status: LiveStepStatus): string {
  if (status === 'pending') return '待执行'
  if (status === 'done') return '完成'
  if (status === 'failed') return '失败'
  if (status === 'skipped') return '跳过'
  return '执行中'
}

function verificationVerdictLabel(verdict: VerificationRecord['verdict']): string {
  if (verdict === 'pass') return '验证通过'
  if (verdict === 'needs_replan') return '需要调整'
  return '验证失败'
}

function verificationSummary(records: VerificationRecord[] | undefined): string {
  const last = records?.at(-1)
  if (!last) return '等待验证'
  return verificationVerdictLabel(last.verdict)
}

const TASK_PROGRESS_COMPLETE_HOLD_MS = 700
const TASK_PROGRESS_EXIT_MS = 260
const TASK_PROGRESS_HOVER_DELAY_MS = 500
const TASK_PROGRESS_CLOSE_DELAY_MS = 100

function TaskProgressPresence({
  activity,
  now,
}: {
  activity: AssistantTurnActivity | null
  now: number
}) {
  const [presentation, setPresentation] = useState<{
    activity: AssistantTurnActivity
    exiting: boolean
  } | null>(null)
  const activeKeyRef = useRef<string>()
  const completedKeyRef = useRef<string>()
  const holdTimerRef = useRef<number>()
  const exitTimerRef = useRef<number>()

  function clearTimers() {
    window.clearTimeout(holdTimerRef.current)
    window.clearTimeout(exitTimerRef.current)
    holdTimerRef.current = undefined
    exitTimerRef.current = undefined
  }

  useEffect(() => {
    const key = activity ? `${activity.startedAt}:${activity.instruction}` : undefined
    if (activity?.status === 'running' && key) {
      clearTimers()
      activeKeyRef.current = key
      completedKeyRef.current = undefined
      setPresentation({ activity, exiting: false })
      return
    }

    if (activity && key && key === activeKeyRef.current) {
      setPresentation((current) => current ? { ...current, activity, exiting: false } : { activity, exiting: false })
      if (completedKeyRef.current === key) return
      completedKeyRef.current = key
      holdTimerRef.current = window.setTimeout(() => {
        setPresentation((current) => current ? { ...current, exiting: true } : current)
        exitTimerRef.current = window.setTimeout(() => {
          setPresentation(null)
          activeKeyRef.current = undefined
          completedKeyRef.current = undefined
        }, TASK_PROGRESS_EXIT_MS)
      }, TASK_PROGRESS_COMPLETE_HOLD_MS)
      return
    }

    clearTimers()
    activeKeyRef.current = undefined
    completedKeyRef.current = undefined
    setPresentation(null)
  }, [activity])

  useEffect(() => () => clearTimers(), [])

  if (!presentation) return null
  return (
    <div className={`task-progress-anchor ${presentation.exiting ? 'exiting' : ''}`}>
      <TaskProgressIndicator activity={presentation.activity} now={now} />
    </div>
  )
}

function TaskProgressIndicator({
  activity,
  now,
}: {
  activity: AssistantTurnActivity
  now: number
}) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const indicatorRef = useRef<HTMLButtonElement>(null)
  const hoverTimerRef = useRef<number>()
  const closeTimerRef = useRef<number>()
  const popoverId = useId()
  const progress = buildTaskProgress(activity)
  const style = { '--task-progress-angle': `${progress.percent * 3.6}deg` } as CSSProperties
  const currentDetail = progress.phase === 'planning'
    ? '正在校准需求并生成执行计划'
    : progress.phase === 'verifying'
      ? '正在按验收标准检查执行结果'
      : progress.activeStep ?? '等待下一步'
  const compactStatus = progress.totalSteps > 0
    ? `${progress.completedSteps}/${progress.totalSteps} 步`
    : '准备中'

  function clearHoverTimer() {
    window.clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = undefined
  }

  function clearCloseTimer() {
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = undefined
  }

  function openImmediately() {
    clearHoverTimer()
    clearCloseTimer()
    setPopoverOpen(true)
  }

  function scheduleOpen() {
    clearCloseTimer()
    if (popoverOpen || hoverTimerRef.current !== undefined) return
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = undefined
      setPopoverOpen(true)
    }, TASK_PROGRESS_HOVER_DELAY_MS)
  }

  function scheduleClose() {
    clearHoverTimer()
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = undefined
      setPopoverOpen(false)
    }, TASK_PROGRESS_CLOSE_DELAY_MS)
  }

  useEffect(() => {
    if (!popoverOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!indicatorRef.current?.contains(event.target as Node)) setPopoverOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [popoverOpen])

  useEffect(() => () => {
    clearHoverTimer()
    clearCloseTimer()
  }, [])

  return (
    <button
      ref={indicatorRef}
      type="button"
      className={`task-progress-indicator phase-${progress.phase} ${popoverOpen ? 'popover-open' : ''}`}
      style={style}
      aria-label={`${progress.label}，${compactStatus}，${progress.percent}%`}
      aria-expanded={popoverOpen}
      aria-controls={popoverId}
      onPointerEnter={scheduleOpen}
      onPointerLeave={scheduleClose}
      onFocus={openImmediately}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleClose()
      }}
      onClick={openImmediately}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        setPopoverOpen(false)
        event.currentTarget.blur()
      }}
    >
      <span className="task-progress-ring" aria-hidden="true" />
      <span id={popoverId} className={`task-progress-popover ${popoverOpen ? 'open' : ''}`}>
          <span className="task-progress-popover-head">
            <strong>{progress.label}</strong>
            <span>{progress.percent}%</span>
          </span>
          <span className="task-progress-popover-copy">{currentDetail}</span>
          <span className="task-progress-popover-meta">{compactStatus} · {formatDurationMs(now - activity.startedAt)}</span>
          {activity.taskBook?.assessment.requiresTaskBook && activity.steps.length > 0 && (
            <span className="task-progress-step-list">
              {activity.steps.map((step) => (
                <span key={step.stepId} className={`task-progress-step ${step.status}`}>
                  <span className="task-progress-step-dot" aria-hidden="true" />
                  <span>{step.title}</span>
                </span>
              ))}
            </span>
          )}
      </span>
    </button>
  )
}

function liveToolStatusClass(tool: LiveToolEvent): 'pending' | 'pass' | 'fail' {
  if (tool.ok === undefined) return 'pending'
  return tool.ok ? 'pass' : 'fail'
}

function liveToolGlyph(tool: LiveToolEvent): string {
  if (tool.ok === undefined) return '·'
  return tool.ok ? '✓' : '!'
}

function shortActivityText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function toolShellTitle(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes('exec') || lower.includes('shell') || lower.includes('command')) return 'Shell'
  return name
}

function formatToolInput(tool: LiveToolEvent): string {
  if (tool.input === undefined) return ''
  if (typeof tool.input === 'string') return tool.input
  if (isRecord(tool.input)) {
    const command = tool.input.command
    if (typeof command === 'string') return `$ ${command}`
  }
  return formatUnknownForActivity(tool.input)
}

function formatToolResult(tool: LiveToolEvent): string {
  if (tool.error) return tool.error
  if (tool.output === undefined) return ''
  return typeof tool.output === 'string' ? tool.output : formatUnknownForActivity(tool.output)
}

function formatUnknownForActivity(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getComposerInputMaxHeight(): number {
  return Math.max(96, Math.min(COMPOSER_INPUT_MAX_HEIGHT, Math.round(window.innerHeight * COMPOSER_INPUT_VIEWPORT_RATIO)))
}

function syncComposerInputHeight(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return
  textarea.style.height = 'auto'
  const maxHeight = getComposerInputMaxHeight()
  const nextHeight = Math.min(textarea.scrollHeight, maxHeight)
  textarea.style.height = `${nextHeight}px`
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
}

function beginResize(axis: 'column'): void {
  document.body.classList.add('is-resizing', `is-resizing-${axis}`)
}

function endResize(axis: 'column'): void {
  document.body.classList.remove(`is-resizing-${axis}`)
  if (!document.body.classList.contains('is-resizing-column')) {
    document.body.classList.remove('is-resizing')
  }
}

type PresencePhase = 'entering' | 'open' | 'exiting'

function FadePresence({
  show,
  children,
  exitMs = 190,
  className = '',
}: {
  show: boolean
  children: ReactNode
  exitMs?: number
  className?: string
}) {
  const [mounted, setMounted] = useState(show)
  const [visible, setVisible] = useState(false)
  const [phase, setPhase] = useState<PresencePhase>(show ? 'open' : 'exiting')

  useLayoutEffect(() => {
    let frame = 0
    let innerFrame = 0
    let timer = 0
    let settleTimer = 0

    if (show) {
      setPhase('entering')
      setMounted(true)
      if (mounted) {
        setVisible(true)
        settleTimer = window.setTimeout(() => setPhase('open'), exitMs)
      } else {
        setVisible(false)
        frame = window.requestAnimationFrame(() => {
          innerFrame = window.requestAnimationFrame(() => {
            setVisible(true)
            settleTimer = window.setTimeout(() => setPhase('open'), exitMs)
          })
        })
      }
      return () => {
        window.cancelAnimationFrame(frame)
        window.cancelAnimationFrame(innerFrame)
        window.clearTimeout(settleTimer)
      }
    }

    setVisible(false)
    setPhase('exiting')
    timer = window.setTimeout(() => setMounted(false), exitMs)
    return () => window.clearTimeout(timer)
  }, [exitMs, show])

  if (!mounted) return null
  return (
    <div className={`presence-layer presence-${phase} ${visible ? 'visible' : ''} ${className}`.trim()}>
      {children}
    </div>
  )
}

type DismissEventName = 'pointerdown' | 'click'

function useDismissOnOutside(
  active: boolean,
  refs: Array<RefObject<HTMLElement>>,
  onDismiss: () => void,
  eventName: DismissEventName = 'pointerdown',
) {
  const onDismissRef = useRef(onDismiss)
  const refsRef = useRef(refs)
  refsRef.current = refs

  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    if (!active) return

    const handlePointer = (event: MouseEvent | PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (refsRef.current.some((ref) => ref.current?.contains(target))) return
      if (isTransientTriggerTarget(target)) return
      onDismissRef.current()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismissRef.current()
    }

    window.addEventListener(eventName, handlePointer)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener(eventName, handlePointer)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [active, eventName])
}

function isTransientTriggerTarget(target: Node): boolean {
  return target instanceof Element && Boolean(target.closest(`[${TRANSIENT_TRIGGER_ATTR}]`))
}

function transientTriggerProps(): { [TRANSIENT_TRIGGER_ATTR]: string } {
  return { [TRANSIENT_TRIGGER_ATTR]: 'true' }
}

function ProjectCreatorDialog({
  show,
  defaultParentPath,
  onClose,
  onChooseExisting,
  onChooseParent,
  onCreateNew,
}: {
  show: boolean
  defaultParentPath: string
  onClose: () => void
  onChooseExisting: () => Promise<void>
  onChooseParent: () => Promise<string | null>
  onCreateNew: (parentPath: string, name: string) => Promise<void>
}) {
  const [mounted, setMounted] = useState(show)
  const [visible, setVisible] = useState(false)
  const [mode, setMode] = useState<'choose' | 'create'>('choose')
  const [parentPath, setParentPath] = useState(defaultParentPath)
  const [folderName, setFolderName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let frame = 0
    let innerFrame = 0
    let timer = 0
    if (show) {
      setVisible(false)
      setMounted(true)
      setError(null)
      setParentPath(defaultParentPath)
      frame = window.requestAnimationFrame(() => {
        innerFrame = window.requestAnimationFrame(() => setVisible(true))
      })
    } else {
      setVisible(false)
      timer = window.setTimeout(() => {
        setMounted(false)
        setMode('choose')
        setFolderName('')
        setError(null)
      }, PROJECT_CREATOR_MOTION_MS)
    }
    return () => {
      window.cancelAnimationFrame(frame)
      window.cancelAnimationFrame(innerFrame)
      window.clearTimeout(timer)
    }
  }, [defaultParentPath, show])

  useDismissOnOutside(mounted && visible, [dialogRef], onClose, 'click')

  if (!mounted) return null

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      if (!mountedRef.current) return
    } catch (err) {
      if (mountedRef.current) setError((err as Error).message)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  async function pickParent() {
    const selected = await onChooseParent()
    if (mountedRef.current && selected) setParentPath(selected)
  }

  async function submitCreate() {
    const name = folderName.trim()
    if (!parentPath || !name) return
    await onCreateNew(parentPath, name)
  }

  return (
    <div className={`project-creator-layer ${visible ? 'visible' : ''}`} aria-hidden={!visible}>
      <div className="project-creator-scrim" />
      <div
        ref={dialogRef}
        className="project-creator-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="创建项目"
      >
        <div className="project-creator-header">
          <span>
            <strong>新项目</strong>
            <small>选择一个项目工作区，之后的对话会归入这个项目。</small>
          </span>
          <button className="project-creator-close" type="button" aria-label="关闭" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className={`project-creator-body ${mode === 'create' ? 'creating' : ''}`}>
          <button
            className="project-creator-option"
            type="button"
            disabled={busy}
            onClick={() => void run(onChooseExisting)}
          >
            <span className="project-creator-option-icon"><ProjectIcon /></span>
            <span>
              <strong>选择目标文件夹</strong>
              <small>使用已有文件夹作为项目</small>
            </span>
          </button>

          <button
            className={`project-creator-option ${mode === 'create' ? 'active' : ''}`}
            type="button"
            disabled={busy}
            onClick={() => setMode((value) => (value === 'create' ? 'choose' : 'create'))}
          >
            <span className="project-creator-option-icon">+</span>
            <span>
              <strong>创建新文件夹</strong>
              <small>在指定位置新建项目文件夹</small>
            </span>
          </button>

          <div className={`project-create-panel ${mode === 'create' ? 'visible' : ''}`}>
            <button className="project-parent-picker" type="button" disabled={busy} onClick={() => void run(pickParent)}>
              <span>
                <strong>存放位置</strong>
                <small>{parentPath ? compactPath(parentPath) : '选择父文件夹'}</small>
              </span>
              <span className="project-parent-arrow" aria-hidden="true" />
            </button>
            <label className="project-name-input">
              <span>文件夹名称</span>
              <input
                value={folderName}
                disabled={busy}
                onChange={(event) => setFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void run(submitCreate)
                  }
                }}
                placeholder="例如 LittleSheep Research"
              />
            </label>
            <button
              className="project-create-submit"
              type="button"
              disabled={busy || !parentPath || !folderName.trim()}
              onClick={() => void run(submitCreate)}
            >
              {busy ? '创建中' : '创建项目'}
            </button>
          </div>
        </div>

        {error && <div className="project-creator-error">{error}</div>}
      </div>
    </div>
  )
}

function GlobalTitlebar({
  sidebarCollapsed,
  sidebarToggleTip,
  canNavigateBack,
  canNavigateForward,
  onToggleSidebar,
  onBack,
  onForward,
  onTipChange,
}: {
  sidebarCollapsed: boolean
  sidebarToggleTip: string
  canNavigateBack: boolean
  canNavigateForward: boolean
  onToggleSidebar: () => void
  onBack: () => void
  onForward: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  return (
    <header className="window-titlebar" aria-label="LittleSheep titlebar">
      <div className="app-nav-controls" aria-label="全局导航">
        <button
          className="sidebar-toggle-btn"
          type="button"
          aria-label={sidebarToggleTip}
          aria-expanded={!sidebarCollapsed}
          onClick={onToggleSidebar}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(sidebarToggleTip, event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip(sidebarToggleTip, event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(sidebarToggleTip, event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <span className="sidebar-toggle-icon" aria-hidden="true">
            <span className="sidebar-toggle-divider" />
          </span>
        </button>
        <button
          className="app-nav-btn nav-back"
          type="button"
          disabled={!canNavigateBack}
          onClick={onBack}
          aria-label="返回"
        >
          ←
        </button>
        <button
          className="app-nav-btn nav-forward"
          type="button"
          disabled={!canNavigateForward}
          onClick={onForward}
          aria-label="前进"
        >
          →
        </button>
      </div>
      <div className="window-titlebar-brand">
        <span className="window-titlebar-icon" aria-hidden="true">LS</span>
        <span>LittleSheep</span>
      </div>
    </header>
  )
}

function SettingsGearIcon() {
  return (
    <svg className="settings-gear-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function SettingsEntryBridge({
  settingsOpen,
  onOpen,
  onClose,
  rippling,
}: {
  settingsOpen: boolean
  onOpen: () => void
  onClose: () => void
  rippling: boolean
}) {
  return (
    <button
      className={`settings-entry-bridge ${rippling ? 'rippling' : ''}`}
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      onClick={settingsOpen ? onClose : onOpen}
    >
      <SettingsGearIcon />
      <span className="settings-entry-bridge-label">设置</span>
    </button>
  )
}

function SidebarQuickNav({
  activePanel,
  activeModule,
  onNewConversation,
  onOpenPanel,
  onOpenModulePage,
  onTipChange,
}: {
  activePanel: SidebarPanel
  activeModule: DirectModulePage | null
  onNewConversation: () => void
  onOpenPanel: (panel: NonNullable<SidebarPanel>) => void
  onOpenModulePage: (page: DirectModulePage) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  return (
    <nav className="sidebar-quick-nav" aria-label="基础功能">
      <SidebarNavButton
        label="新对话"
        icon={<NavComposeIcon />}
        onClick={onNewConversation}
        onTipChange={onTipChange}
      />
      <SidebarNavButton
        label="搜索"
        icon={<SearchIcon />}
        active={activePanel === 'search'}
        onClick={() => onOpenPanel('search')}
        onTipChange={onTipChange}
      />
      <SidebarNavButton
        label="记忆树"
        icon={<MemoryTreeNavIcon />}
        active={activeModule === 'memoryTree'}
        onClick={() => onOpenModulePage('memoryTree')}
        onTipChange={onTipChange}
      />
      <SidebarNavButton
        label="已安排"
        icon={<ScheduleIcon />}
        active={activeModule === 'scheduled'}
        onClick={() => onOpenModulePage('scheduled')}
        onTipChange={onTipChange}
      />
      <SidebarNavButton
        label="插件"
        icon={<PluginIcon />}
        active={activeModule === 'plugins'}
        onClick={() => onOpenModulePage('plugins')}
        onTipChange={onTipChange}
      />
    </nav>
  )
}

function SidebarNavButton({
  label,
  icon,
  active = false,
  onClick,
  onTipChange,
}: {
  label: string
  icon: ReactNode
  active?: boolean
  onClick: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  return (
    <button
      {...transientTriggerProps()}
      className={`sidebar-nav-button ${active ? 'active' : ''}`}
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={() => {
        onTipChange(null)
        onClick()
      }}
      onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(label, event.clientX, event.clientY))}
      onMouseMove={(event) => onTipChange(buildFloatingHelpTip(label, event.clientX, event.clientY))}
      onMouseLeave={() => onTipChange(null)}
      onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(label, event.currentTarget))}
      onBlur={() => onTipChange(null)}
    >
      <span className="sidebar-nav-icon" aria-hidden="true">{icon}</span>
      <span className="sidebar-nav-label">{label}</span>
    </button>
  )
}

function SidebarProjectSection({
  projects,
  sessions,
  currentSession,
  pinnedSessionIds,
  now,
  activeProjectId,
  fallbackPath,
  onOpenProject,
  onOpenWorkspace,
  onOpenSession,
  onTogglePin,
  onArchiveSession,
  onDeleteSession,
  onArchiveProject,
  onRebindProject,
  onDeleteProject,
  onTipChange,
}: {
  projects: ProjectMeta[]
  sessions: SessionMeta[]
  currentSession?: string
  pinnedSessionIds: Set<string>
  now: number
  activeProjectId?: string
  fallbackPath: string
  onOpenProject: (project: ProjectMeta) => void
  onOpenWorkspace: () => void
  onOpenSession: (session: SessionMeta) => void
  onTogglePin: (id: string) => void
  onArchiveSession: (id: string) => void | Promise<void>
  onDeleteSession: (id: string) => void | Promise<void>
  onArchiveProject: (project: ProjectMeta) => void | Promise<void>
  onRebindProject: (project: ProjectMeta) => void | Promise<void>
  onDeleteProject: (project: ProjectMeta) => void | Promise<void>
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set())
  const [sortMode, setSortMode] = useState<ProjectSortMode>(() => readProjectSortPreference(PROJECT_SORT_KEY))
  const baseProjects = useMemo(
    () => projects.filter((project) => !isSamePath(project.path, fallbackPath)),
    [fallbackPath, projects],
  )
  const visibleProjects = useMemo(() => sortProjectsForSidebar(baseProjects, sortMode), [baseProjects, sortMode])
  const activeProject = visibleProjects.find((project) => project.id === activeProjectId)
  const projectMotionRef = useListReorderAnimation<HTMLDivElement>(visibleProjects.map((project) => project.id))
  const projectSessionKeys = visibleProjects.flatMap((project) =>
    sessionsForSidebarProject(sessions, project).map((session) => `${project.id}:${session.id}`),
  )
  const projectSessionMotionRef = useListReorderAnimation<HTMLDivElement>(projectSessionKeys)

  useEffect(() => {
    writeStringPreference(PROJECT_SORT_KEY, sortMode)
  }, [sortMode])

  useEffect(() => {
    if (!activeProject) return
    setExpandedProjectIds((ids) => {
      if (ids.has(activeProject.id)) return ids
      const next = new Set(ids)
      next.add(activeProject.id)
      return next
    })
  }, [activeProject?.id])

  function toggleProject(project: ProjectMeta, active: boolean) {
    setExpandedProjectIds((ids) => {
      const next = new Set(ids)
      if (active && next.has(project.id)) {
        next.delete(project.id)
      } else {
        next.add(project.id)
      }
      return next
    })
    if (!active) onOpenProject(project)
  }

  return (
    <section className={`sidebar-section project-section ${collapsed ? 'collapsed' : ''}`} aria-label="项目">
      <div className="sidebar-section-header">
        <button
          className="sidebar-section-toggle"
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span>项目</span>
          <span className="sidebar-section-arrow" aria-hidden="true" />
        </button>
        <div className="sidebar-section-actions" aria-hidden={collapsed ? undefined : false}>
          <SidebarActionMenu
            label="项目菜单"
            onTipChange={onTipChange}
            items={[
              {
                label: '保持原位置',
                icon: sortMode === 'fixed' ? <CheckIcon /> : <SortIcon />,
                onSelect: () => setSortMode('fixed'),
              },
              {
                label: '按最近使用',
                icon: sortMode === 'recent' ? <CheckIcon /> : <SortIcon />,
                onSelect: () => setSortMode('recent'),
              },
              {
                label: '按项目名称',
                icon: sortMode === 'name' ? <CheckIcon /> : <SortIcon />,
                onSelect: () => setSortMode('name'),
              },
              {
                label: '归档所有项目',
                icon: <ArchiveIcon />,
                onSelect: async () => {
                  for (const project of visibleProjects) await onArchiveProject(project)
                },
              },
            ]}
          >
            <MoreIcon />
          </SidebarActionMenu>
          <button
            className="sidebar-section-action sidebar-new-action"
            type="button"
            aria-label="添加项目"
            onClick={onOpenWorkspace}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('添加项目', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('添加项目', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('添加项目', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            <ComposeIcon />
          </button>
        </div>
      </div>
      <div className="project-tree">
        {visibleProjects.map((project) => {
          const tip = `项目工作区\n${project.path}`
          const active = project.id === activeProjectId
          const expanded = expandedProjectIds.has(project.id)
          const projectSessions = sessionsForSidebarProject(sessions, project)
          const lastActiveAt = Date.parse(project.lastActiveAt)
          return (
            <div
              key={project.id}
              ref={projectMotionRef(project.id)}
              className={`project-group ${expanded ? 'expanded' : 'collapsed'}`}
            >
              <div className={`session-item project-item ${active ? 'active' : ''} ${expanded ? 'expanded' : ''}`}>
                <button
                  className="project-row-trigger"
                  type="button"
                  onClick={() => toggleProject(project, active)}
                  aria-label={tip}
                  aria-expanded={expanded}
                  aria-current={active ? 'page' : undefined}
                  onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
                  onMouseMove={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
                  onMouseLeave={() => onTipChange(null)}
                  onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(tip, event.currentTarget))}
                  onBlur={() => onTipChange(null)}
                >
                  <span className="project-row-arrow" aria-hidden="true" />
                  <ProjectIcon />
                  <span className="project-row-title">{project.name || lastPathSegment(project.path)}</span>
                </button>
                <span className="session-tail" aria-hidden="true">
                  <span className="session-time">
                    {Number.isFinite(lastActiveAt) ? formatRelativeSessionTime(lastActiveAt, now) : ''}
                  </span>
                </span>
                <span className="session-row-actions" aria-label="项目操作">
                  <SidebarActionMenu
                    label="项目菜单"
                    onTipChange={onTipChange}
                    items={[
                      {
                        label: '重新定位项目',
                        icon: <ProjectIcon />,
                        onSelect: () => onRebindProject(project),
                      },
                      {
                        label: '归档项目',
                        icon: <ArchiveIcon />,
                        onSelect: () => onArchiveProject(project),
                      },
                      {
                        label: '删除项目',
                        icon: <TrashIcon />,
                        tone: 'danger',
                        onSelect: () => onDeleteProject(project),
                      },
                    ]}
                  >
                    <MoreIcon />
                  </SidebarActionMenu>
                </span>
              </div>
              <div className="project-session-list" aria-hidden={!expanded}>
                {projectSessions.length > 0 ? (
                  projectSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      active={session.id === currentSession}
                      pinned={pinnedSessionIds.has(session.id)}
                      now={now}
                      className="project-session-item"
                      itemRef={projectSessionMotionRef(`${project.id}:${session.id}`)}
                      onOpen={() => onOpenSession(session)}
                      onTogglePin={() => onTogglePin(session.id)}
                      onArchive={() => onArchiveSession(session.id)}
                      onDelete={() => onDeleteSession(session.id)}
                      onTipChange={onTipChange}
                    />
                  ))
                ) : (
                  <div className="project-session-empty">暂无对话</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function sessionsForSidebarProject(
  sessions: SessionMeta[],
  project: ProjectMeta,
): SessionMeta[] {
  return projectSessions(sessions, project.id)
}

function SidebarFeaturePanel({
  panel,
  search,
  sessions,
  currentSession,
  now,
  onSearchChange,
  onClose,
  onOpenSession,
}: {
  panel: SidebarPanel
  search: string
  sessions: SessionMeta[]
  currentSession?: string
  now: number
  onSearchChange: (value: string) => void
  onClose: () => void
  onOpenSession: (session: SessionMeta) => void
}) {
  const [renderedPanel, setRenderedPanel] = useState<SidebarPanel>(panel)
  const [visible, setVisible] = useState(false)
  const [contentVisible, setContentVisible] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const focusFrameRef = useRef<number>()

  useEffect(() => {
    let frame = 0
    let innerFrame = 0
    let timer = 0
    let swapTimer = 0

    if (panel) {
      if (renderedPanel && panel !== renderedPanel && visible) {
        setContentVisible(false)
        swapTimer = window.setTimeout(() => {
          setRenderedPanel(panel)
          frame = window.requestAnimationFrame(() => setContentVisible(true))
        }, 120)
      } else {
        setRenderedPanel(panel)
        frame = window.requestAnimationFrame(() => {
          setVisible(true)
          innerFrame = window.requestAnimationFrame(() => setContentVisible(true))
        })
      }
    } else {
      setContentVisible(false)
      setVisible(false)
      timer = window.setTimeout(() => setRenderedPanel(null), 180)
    }
    return () => {
      window.cancelAnimationFrame(frame)
      window.cancelAnimationFrame(innerFrame)
      window.clearTimeout(timer)
      window.clearTimeout(swapTimer)
    }
  }, [panel, renderedPanel, visible])

  useEffect(() => {
    if (renderedPanel === 'search' && visible && contentVisible) {
      window.cancelAnimationFrame(focusFrameRef.current ?? 0)
      focusFrameRef.current = window.requestAnimationFrame(() => {
        focusFrameRef.current = undefined
        searchRef.current?.focus()
      })
    }
    return () => window.cancelAnimationFrame(focusFrameRef.current ?? 0)
  }, [contentVisible, renderedPanel, visible])

  useDismissOnOutside(Boolean(renderedPanel && visible), [panelRef], onClose, 'click')

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return sessions.slice(0, 8)
    return sessions.filter((session) => session.title.toLowerCase().includes(query)).slice(0, 24)
  }, [search, sessions])

  if (!renderedPanel) return null

  const title = '搜索'
  const desc = '搜索当前侧栏中的本地会话'

  return (
    <aside
      ref={panelRef}
      className={`sidebar-feature-panel ${visible ? 'visible' : ''}`}
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className={`sidebar-feature-content ${contentVisible ? 'visible' : ''}`}>
        <div className="sidebar-feature-header">
          <span>
            <strong>{title}</strong>
            <small>{desc}</small>
          </span>
          <button className="sidebar-feature-close" type="button" aria-label="关闭" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="sidebar-search-panel">
          <label className="sidebar-search-box">
            <SearchIcon />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="搜索会话"
            />
          </label>
          <div className="sidebar-search-results" role="listbox" aria-label="搜索结果">
            {searchResults.length > 0 ? (
              searchResults.map((session) => (
                <button
                  key={session.id}
                  className={`sidebar-search-result ${session.id === currentSession ? 'active' : ''}`}
                  type="button"
                  role="option"
                  aria-selected={session.id === currentSession}
                  onClick={() => onOpenSession(session)}
                >
                  <span>{session.title}</span>
                  <small>{formatRelativeSessionTime(session.lastMessageAt || session.createdAt, now)}</small>
                </button>
              ))
            ) : (
              <div className="sidebar-feature-empty">没有找到匹配的会话</div>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}

interface SidebarMenuItem {
  label: string
  icon: ReactNode
  tone?: 'danger'
  onSelect: () => void | Promise<void>
}

function SidebarActionMenu({
  label,
  items,
  children,
  onTipChange,
}: {
  label: string
  items: SidebarMenuItem[]
  children: ReactNode
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number>()
  const frameRef = useRef<number>()
  const menuIdRef = useRef(`sidebar-menu-${Math.random().toString(36).slice(2)}`)

  function syncPosition() {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 10
    const anchor = trigger.closest('.session-item, .sidebar-section-header') as HTMLElement | null
    const anchorRect = anchor?.getBoundingClientRect() ?? rect
    const panelWidth = panelRef.current?.offsetWidth || 154
    const panelHeight = panelRef.current?.offsetHeight || Math.max(44, items.length * 34 + 14)
    const x = clampNumber(anchorRect.right - panelWidth, margin, window.innerWidth - panelWidth - margin)
    const below = rect.bottom + 3
    const y = below + panelHeight > window.innerHeight - margin
      ? Math.max(margin, rect.top - panelHeight - 3)
      : below
    setPosition({ x, y })
  }

  function openMenu() {
    window.clearTimeout(closeTimerRef.current)
    window.dispatchEvent(new CustomEvent(SIDEBAR_MENU_EVENT, { detail: menuIdRef.current }))
    setMounted(true)
    frameRef.current = window.requestAnimationFrame(() => {
      syncPosition()
      setOpen(true)
    })
  }

  function closeMenu() {
    setOpen(false)
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => setMounted(false), 170)
  }

  useDismissOnOutside(mounted, [rootRef, panelRef], closeMenu)

  useEffect(() => {
    const handleSidebarMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== menuIdRef.current) closeMenu()
    }
    window.addEventListener(SIDEBAR_MENU_EVENT, handleSidebarMenuOpen)
    return () => window.removeEventListener(SIDEBAR_MENU_EVENT, handleSidebarMenuOpen)
  }, [])

  useEffect(() => {
    if (!mounted) return
    const handleReposition = () => syncPosition()
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [mounted])

  useLayoutEffect(() => {
    if (mounted) syncPosition()
  }, [mounted, items.length])

  useEffect(() => () => {
    window.clearTimeout(closeTimerRef.current)
    window.cancelAnimationFrame(frameRef.current ?? 0)
  }, [])

  return (
    <div ref={rootRef} className={`sidebar-action-menu ${open ? 'open' : ''}`}>
      <button
        {...transientTriggerProps()}
        ref={triggerRef}
        className="sidebar-section-action sidebar-action-menu-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          onTipChange(null)
          if (open) closeMenu()
          else openMenu()
        }}
        onMouseEnter={(event) => {
          if (!open) onTipChange(buildFloatingHelpTip(label, event.clientX, event.clientY))
        }}
        onMouseMove={(event) => {
          if (!open) onTipChange(buildFloatingHelpTip(label, event.clientX, event.clientY))
        }}
        onMouseLeave={() => onTipChange(null)}
        onFocus={(event) => {
          if (!open) onTipChange(buildFloatingHelpTipFromElement(label, event.currentTarget))
        }}
        onBlur={() => onTipChange(null)}
      >
        {children}
      </button>
      {mounted && createPortal(
        <div
          ref={panelRef}
          className={`sidebar-menu-panel ${open ? 'visible' : ''}`}
          role="menu"
          aria-label={label}
          style={{ left: position.x, top: position.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {items.map((item) => (
            <button
              key={item.label}
              className={`sidebar-menu-item ${item.tone === 'danger' ? 'danger' : ''}`}
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu()
                void Promise.resolve(item.onSelect()).catch((error) => console.error(error))
              }}
            >
              <span className="sidebar-menu-item-icon" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

function SessionRow({
  session,
  active,
  pinned,
  now,
  className,
  itemRef,
  onOpen,
  onTogglePin,
  onArchive,
  onDelete,
  onTipChange,
}: {
  session: SessionMeta
  active: boolean
  pinned: boolean
  now: number
  className?: string
  itemRef?: (node: HTMLDivElement | null) => void
  onOpen: () => void
  onTogglePin: () => void
  onArchive: () => void | Promise<void>
  onDelete: () => void | Promise<void>
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const pinLabel = pinned ? '取消置顶' : '置顶对话'
  const menuLabel = '对话菜单'
  const lastActiveAt = session.lastMessageAt || session.createdAt

  return (
    <div
      ref={itemRef}
      className={`session-item ${className ?? ''} ${active ? 'active' : ''} ${pinned ? 'pinned' : ''}`}
      role="button"
      tabIndex={0}
      aria-current={active ? 'page' : undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen()
      }}
    >
      <span className="session-title">{session.title}</span>
      <span className="session-tail" aria-hidden="true">
        <span className="session-time">{formatRelativeSessionTime(lastActiveAt, now)}</span>
      </span>
      <span className="session-row-actions" aria-label="对话操作">
        <button
          className={`sidebar-section-action session-pin-action ${pinned ? 'active' : ''}`}
          type="button"
          aria-label={pinLabel}
          aria-pressed={pinned}
          onClick={(event) => {
            event.stopPropagation()
            onTogglePin()
          }}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(pinLabel, event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip(pinLabel, event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(pinLabel, event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <PinIcon active={pinned} />
        </button>
        <SidebarActionMenu
          label={menuLabel}
          onTipChange={onTipChange}
          items={[
            {
              label: '归档对话',
              icon: <ArchiveIcon />,
              onSelect: onArchive,
            },
            {
              label: '删除对话',
              icon: <TrashIcon />,
              tone: 'danger',
              onSelect: onDelete,
            },
          ]}
        >
          <MoreIcon />
        </SidebarActionMenu>
      </span>
    </div>
  )
}

function NavComposeIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.4 12.6h2.4l6.45-6.45a1.7 1.7 0 0 0-2.4-2.4L3.4 10.2v2.4zM9.05 4.55l2.4 2.4" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="7.1" cy="7.1" r="4.25" />
      <path d="M10.25 10.25l2.8 2.8" />
    </svg>
  )
}

function ScheduleIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.35" />
      <path d="M8 4.65v3.55l2.35 1.35" />
    </svg>
  )
}

function MemoryTreeNavIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="3.35" r="1.35" />
      <circle cx="4.45" cy="11.85" r="1.35" />
      <circle cx="11.55" cy="11.85" r="1.35" />
      <path d="M8 4.75v2.25M8 7l-3.05 3.65M8 7l3.05 3.65" />
    </svg>
  )
}

function PluginIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M6.15 2.8v3.35M9.85 2.8v3.35M5.2 6.15h5.6v2.9a2.8 2.8 0 0 1-5.6 0v-2.9zM8 11.85v1.35" />
    </svg>
  )
}

function ProjectIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 4.45h3.2l1.05 1.25H13v5.85H3z" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="4" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12" cy="8" r="1.25" />
    </svg>
  )
}

function ComposeIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="3.25" y="3.25" width="9.5" height="9.5" rx="2.1" />
      <path d="M8 5.15v5.7M5.15 8h5.7" />
    </svg>
  )
}

function PinIcon({ active }: { active: boolean }) {
  return (
    <svg className={`sidebar-svg-icon pin-icon ${active ? 'active' : ''}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5.15 2.75h5.7M6.25 3.1l.5 4.15-2 2.2v1.05h6.5V9.45l-2-2.2.5-4.15M8 10.5v3" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.5 8.25l2.75 2.75 6.25-6.5" />
    </svg>
  )
}

function SortIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.1 4.2h7.8M4.1 8h5.7M4.1 11.8h3.2" />
    </svg>
  )
}

function ArchiveIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 5.3h10M4.05 5.3v7.05h7.9V5.3M3.55 2.9h8.9l.55 2.4H3zM6.45 8.2h3.1" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.4 4.45h9.2M6.35 4.45V3.1h3.3v1.35M4.65 4.45l.55 8.15h5.6l.55-8.15M6.8 6.8v3.65M9.2 6.8v3.65" />
    </svg>
  )
}

function WorkspaceFeatureIcon({ id }: { id: WorkspacePanelTab }) {
  if (id === 'review') {
    return (
      <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="3.05" y="2.75" width="9.9" height="10.5" rx="2.1" />
        <path d="M5.55 6.15h4.9M5.55 8h4.9M5.55 9.85h2.7" />
        <path d="M8 1.95v2.1M6.95 3h2.1" />
      </svg>
    )
  }
  if (id === 'terminal') {
    return (
      <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="2.65" y="3.25" width="10.7" height="9.5" rx="2.1" />
        <path d="M5.05 6.4 6.65 8l-1.6 1.6M7.8 9.6h3.1" />
      </svg>
    )
  }
  if (id === 'artifacts') {
    return (
      <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4.05 3.15h5.25l2.65 2.65v6.95h-7.9z" />
        <path d="M9.15 3.35v2.65h2.65M6 8.1h4M6 10.05h3" />
        <path d="M2.85 4.95v8.1h7.1" />
      </svg>
    )
  }
  if (id === 'browser') {
    return (
      <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="5.25" />
        <path d="M2.9 8h10.2M8 2.75c1.35 1.4 2 3.15 2 5.25s-.65 3.85-2 5.25M8 2.75C6.65 4.15 6 5.9 6 8s.65 3.85 2 5.25" />
      </svg>
    )
  }
  if (id === 'sideChat') {
    return (
      <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M3.1 4.15h9.8v6.1H7.55l-2.65 2.1v-2.1H3.1z" />
        <path d="M5.35 6.45h5.3M5.35 8.15h3.4" />
      </svg>
    )
  }
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 4.25h3.2l1.05 1.25H13v6.25H3z" />
    </svg>
  )
}

function CloseMiniIcon() {
  return (
    <svg className="workspace-panel-svg-icon close-mini-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5.25 5.25 10.75 10.75M10.75 5.25 5.25 10.75" />
    </svg>
  )
}

function WorkspacePanelIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2.4" y="2.65" width="11.2" height="10.7" rx="2.1" />
      <path d="M9.75 2.9v10.2" />
      <path className="workspace-panel-icon-arrow" d={collapsed ? 'M5.45 5.35 7.95 8l-2.5 2.65' : 'M7.95 5.35 5.45 8l2.5 2.65'} />
    </svg>
  )
}

function SendRunIcon() {
  return (
    <svg className="send-round-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" />
    </svg>
  )
}

function StopRunIcon() {
  return (
    <svg className="send-round-icon stop" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="5" y="5" width="6" height="6" rx="1" />
    </svg>
  )
}

function PanelFullscreenIcon({ active }: { active: boolean }) {
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {active ? (
        <path d="M6.7 3.2H3.25v3.45M9.3 3.2h3.45v3.45M6.7 12.8H3.25V9.35M9.3 12.8h3.45V9.35M5.15 5.15l-1.9-1.9M10.85 5.15l1.9-1.9M5.15 10.85l-1.9 1.9M10.85 10.85l1.9 1.9" />
      ) : (
        <path d="M3.45 6.45v-3h3M9.55 3.45h3v3M12.55 9.55v3h-3M6.45 12.55h-3v-3M3.45 3.45l3 3M12.55 3.45l-3 3M12.55 12.55l-3-3M3.45 12.55l3-3" />
      )}
    </svg>
  )
}

function PanelCollapseIcon() {
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M10.1 4.35 6.45 8l3.65 3.65" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M12.7 6.05A4.65 4.65 0 1 0 13 8M12.85 3.75v2.4h-2.4" />
    </svg>
  )
}

function ExternalOpenIcon() {
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M6.6 3.45H3.5v9.05h9.05V9.4M8.25 3.45h4.3v4.3M12.35 3.65 7.35 8.65" />
    </svg>
  )
}

function VSCodeIcon() {
  return (
    <svg className="workspace-panel-svg-icon vscode-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M11.95 2.9 6.35 8l5.6 5.1 1.65-.75V3.65z" />
      <path d="M6.35 5.4 3.9 3.6 2.45 4.35 4.85 8l-2.4 3.65 1.45.75 2.45-1.8" />
    </svg>
  )
}

function TreeChevronIcon() {
  return (
    <svg className="workspace-tree-chevron-icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M4.4 2.9 7.55 6 4.4 9.1" />
    </svg>
  )
}

function FolderGlyphIcon() {
  return (
    <svg className="workspace-tree-glyph-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.4 4.25h4l1.05 1.3h6.15v6.2H2.4z" />
    </svg>
  )
}

function FileGlyphIcon() {
  return (
    <svg className="workspace-tree-glyph-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.15 2.65h5.4l2.3 2.3v8.4h-7.7zM9.4 2.9v2.25h2.2" />
    </svg>
  )
}

function DirectModuleWorkspace({ page }: { page: DirectModulePage }) {
  return (
    <main className="direct-module-workspace" aria-label={directModuleLabel(page)}>
      <div key={page} className="direct-module-page settings-page-transition with-motion">
        <DirectModulePageContent page={page} />
      </div>
    </main>
  )
}

function DirectModulePageContent({ page }: { page: DirectModulePage }) {
  if (page === 'memoryTree') return <MemoryTreeView />
  if (page === 'scheduled') return <SettingsScheduledPage />
  return <SettingsPluginsPage />
}

function directModuleLabel(page: DirectModulePage): string {
  if (page === 'memoryTree') return '记忆树'
  if (page === 'scheduled') return '已安排'
  return '插件'
}

function SettingsWorkspace({
  page,
  runtime,
  sidebarCollapsed,
  sidebarWidth,
  sidebarToggleTip,
  canBack,
  canForward,
  onBeginSidebarResize,
  onNudgeSidebar,
  onSetSidebarWidth,
  onToggleSidebar,
  onBack,
  onForward,
  onClose,
  settingsEntryRippling,
  onOpenPage,
  onProfileChange,
  onContextCompressionThresholdChange,
  onArchiveChanged,
  onTipChange,
}: {
  page: SettingsPage
  runtime: RuntimeState | null
  sidebarCollapsed: boolean
  sidebarWidth: number
  sidebarToggleTip: string
  canBack: boolean
  canForward: boolean
  onBeginSidebarResize: (event: React.PointerEvent<HTMLDivElement>) => void
  onNudgeSidebar: (delta: number) => void
  onSetSidebarWidth: (width: number) => void
  onToggleSidebar: () => void
  onBack: () => void
  onForward: () => void
  onClose: () => void
  settingsEntryRippling: boolean
  onOpenPage: (page: SettingsPage) => void
  onProfileChange: (profile: AgentProfileId) => void
  onContextCompressionThresholdChange: (ratio: number) => Promise<void>
  onArchiveChanged: () => void | Promise<void>
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const returnHome = () => onOpenPage('home')
  const initialPageRef = useRef(page)
  const pageHasChangedRef = useRef(false)

  if (page !== initialPageRef.current) {
    pageHasChangedRef.current = true
  }

  return (
    <div className="settings-workspace">
      <GlobalTitlebar
        sidebarCollapsed={sidebarCollapsed}
        sidebarToggleTip={sidebarToggleTip}
        canNavigateBack={canBack}
        canNavigateForward={canForward}
        onToggleSidebar={onToggleSidebar}
        onBack={onBack}
        onForward={onForward}
        onTipChange={onTipChange}
      />
      <div className="settings-layout">
        <aside className="settings-sidebar" aria-hidden={sidebarCollapsed} {...(sidebarCollapsed ? { inert: '' } : {})}>
          <div className="settings-sidebar-contents">
            <div className="brand-block">
              <div className="brand-title">设置</div>
              <div className="brand-subtitle">系统能力与本地工作台</div>
            </div>
            <section className="settings-nav-section" aria-label="设置分组">
              {SETTINGS_NAV_GROUPS.map((group) => (
                <div key={group.title} className="settings-nav-group">
                  <div className="settings-nav-group-title">{group.title}</div>
                  <div className="settings-nav-group-items">
                    {group.items.map((item) => (
                      <button
                        key={item.page}
                        className={`settings-nav-item ${page === item.page ? 'active' : ''}`}
                        type="button"
                        aria-current={page === item.page ? 'page' : undefined}
                        onClick={() => onOpenPage(item.page)}
                      >
                        <span>
                          <strong>{item.title}</strong>
                          <small>{item.desc}</small>
                        </span>
                        <span className="settings-nav-arrow" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </section>
            <div className="sidebar-footer settings-sidebar-footer">
              <button
                className={`settings-entry-btn active ${settingsEntryRippling ? 'rippling' : ''}`}
                type="button"
                onClick={onClose}
                aria-label="关闭设置"
                aria-expanded="true"
              >
                <SettingsGearIcon />
                <span className="settings-entry-label">设置</span>
              </button>
            </div>
          </div>
        </aside>
        <div
          className="settings-sidebar-resizer"
          role="separator"
          aria-hidden={sidebarCollapsed}
          aria-label="调整设置侧栏宽度"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_WIDTH_MIN}
          aria-valuemax={SIDEBAR_WIDTH_MAX}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={sidebarCollapsed ? -1 : 0}
          onPointerDown={onBeginSidebarResize}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              onNudgeSidebar(event.shiftKey ? -32 : -12)
            } else if (event.key === 'ArrowRight') {
              event.preventDefault()
              onNudgeSidebar(event.shiftKey ? 32 : 12)
            } else if (event.key === 'Home') {
              event.preventDefault()
              onSetSidebarWidth(SIDEBAR_WIDTH_MIN)
            } else if (event.key === 'End') {
              event.preventDefault()
              onSetSidebarWidth(SIDEBAR_WIDTH_MAX)
            }
          }}
        />
        <main className="settings-workspace-body">
          <div key={page} className={`settings-page-transition ${pageHasChangedRef.current ? 'with-motion' : ''}`}>
            {page === 'home' && <SettingsHome onOpenPage={onOpenPage} />}
            {page === 'agent' && (
              <SettingsAgentProfilePage
                profile={runtime?.profile ?? 'general'}
                contextCompressionThresholdRatio={runtime?.contextCompressionThresholdRatio ?? 0.8}
                onChange={onProfileChange}
                onContextCompressionThresholdChange={onContextCompressionThresholdChange}
              />
            )}
            {page === 'api' && <Settings onClose={returnHome} embedded />}
            {page === 'storage' && <SettingsStoragePage />}
            {page === 'channels' && <ChannelConnections onClose={returnHome} embedded />}
            {page === 'archive' && <ArchiveManager onChanged={onArchiveChanged} />}
            {isDirectModulePage(page) && <DirectModulePageContent page={page} />}
            {page === 'skills' && <MemorySkills onClose={returnHome} embedded />}
          </div>
        </main>
      </div>
    </div>
  )
}

function SettingsHome({ onOpenPage }: { onOpenPage: (page: SettingsPage) => void }) {
  return (
    <div className="settings-home">
      <div className="settings-home-heading">
        <h2>设置</h2>
        <p>系统能力、渠道、记忆和后续功能模块都会归入这里。</p>
      </div>
      <div className="settings-overview-list">
        {SETTINGS_NAV_GROUPS.map((group) => {
          const items = group.items.filter((item) => item.page !== 'home')
          if (items.length === 0) return null
          return (
            <section key={group.title} className="settings-overview-group">
              <div className="settings-overview-group-title">{group.title}</div>
              <div className="settings-overview-group-items">
                {items.map((item) => (
                  <button
                    key={item.page}
                    className="settings-overview-row"
                    type="button"
                    onClick={() => onOpenPage(item.page)}
                  >
                    <strong>{item.title}</strong>
                    <span>{item.desc}</span>
                    <span className="settings-nav-arrow" aria-hidden="true" />
                  </button>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function SettingsAgentProfilePage({
  profile,
  contextCompressionThresholdRatio,
  onChange,
  onContextCompressionThresholdChange,
}: {
  profile: AgentProfileId
  contextCompressionThresholdRatio: number
  onChange: (profile: AgentProfileId) => void
  onContextCompressionThresholdChange: (ratio: number) => Promise<void>
}) {
  const [compressionThreshold, setCompressionThreshold] = useState(contextCompressionThresholdRatio)
  const [savingCompressionThreshold, setSavingCompressionThreshold] = useState(false)

  useEffect(() => {
    setCompressionThreshold(contextCompressionThresholdRatio)
  }, [contextCompressionThresholdRatio])

  async function saveCompressionThreshold() {
    if (savingCompressionThreshold || compressionThreshold === contextCompressionThresholdRatio) return
    setSavingCompressionThreshold(true)
    try {
      await onContextCompressionThresholdChange(compressionThreshold)
    } finally {
      setSavingCompressionThreshold(false)
    }
  }

  return (
    <div className="settings-module-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">通用</div>
        <h2>Agent 行为</h2>
        <p>这里选择系统提示词侧的行为配置；权限仍由输入栏的权限模式单独控制。</p>
      </header>
      <div className="profile-choice-list" role="radiogroup" aria-label="Agent 行为配置">
        {PROFILE_OPTIONS.map((item) => {
          const active = item.id === profile
          return (
            <button
              key={item.id}
              type="button"
              className={`profile-choice ${active ? 'active' : ''}`}
              role="radio"
              aria-checked={active}
              onClick={() => {
                if (!active) onChange(item.id)
              }}
            >
              <span>
                <strong>{item.label}</strong>
                <small>{item.desc}</small>
              </span>
              <span className="profile-choice-check" aria-hidden="true">{active ? '✓' : ''}</span>
            </button>
          )
        })}
      </div>
      <section className="settings-policy-section" aria-label="上下文策略">
        <div className="settings-policy-heading">
          <strong>上下文</strong>
          <span>长期对话与模型窗口</span>
        </div>
        <div className="settings-policy-row">
          <span>
            <strong>压缩触发阈值</strong>
            <small>达到模型上下文占用比例后生成可追溯摘要</small>
          </span>
          <input
            type="range"
            min="0.5"
            max="0.95"
            step="0.05"
            value={compressionThreshold}
            aria-label="上下文压缩触发阈值"
            onChange={(event) => setCompressionThreshold(Number(event.target.value))}
          />
          <output>{Math.round(compressionThreshold * 100)}%</output>
          <button
            type="button"
            onClick={() => void saveCompressionThreshold()}
            disabled={savingCompressionThreshold || compressionThreshold === contextCompressionThresholdRatio}
          >
            {savingCompressionThreshold ? '保存中' : '保存'}
          </button>
        </div>
      </section>
    </div>
  )
}

function SettingsStoragePage() {
  const [status, setStatus] = useState<DataRootStatus | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void getDataRootStatus()
      .then((next) => {
        if (active) setStatus(next)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
    }
  }, [])

  async function runStatusAction(label: string, action: () => Promise<DataRootStatus>) {
    if (busyAction) return
    setBusyAction(label)
    setError(null)
    try {
      setStatus(await action())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyAction(null)
    }
  }

  async function chooseMigrationTarget() {
    if (busyAction) return
    setBusyAction('select')
    setError(null)
    try {
      const target = await selectDataRootTarget()
      if (target) setStatus(await requestDataRootMigration(target))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyAction(null)
    }
  }

  async function restartNow() {
    if (busyAction) return
    setBusyAction('restart')
    setError(null)
    try {
      await restartApplication()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusyAction(null)
    }
  }

  const pendingMigration = status?.pendingMigration
  const pendingRollback = status?.pendingRollback
  const pending = !!pendingMigration || !!pendingRollback

  return (
    <div className="settings-module-page storage-settings-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">通用</div>
        <h2>存储与数据</h2>
        <p>管理 LS 的配置、会话、记忆、插件数据和默认工作区位置。迁移只在重启后的启动阶段执行。</p>
      </header>

      <section className="storage-settings-section" aria-label="数据目录状态">
        <div className="storage-settings-heading">
          <strong>当前状态</strong>
          <span>{status?.managed === false ? '环境变量接管' : '应用管理'}</span>
        </div>
        <div className="storage-settings-row">
          <span>
            <strong>当前数据目录</strong>
            <small>LS 当前读取和写入的权威目录</small>
          </span>
          <code>{status?.currentDataDir ?? '读取中...'}</code>
        </div>
        {status?.environmentOverride && (
          <div className="storage-settings-notice" data-tone="neutral">
            当前目录由 <code>LITTLESHEEP_DATA_DIR</code> 指定。应用内迁移与回滚已禁用，避免与环境配置冲突。
          </div>
        )}
      </section>

      {pending && (
        <section className="storage-settings-section" aria-label="待处理的数据目录操作">
          <div className="storage-settings-heading">
            <strong>等待重启</strong>
            <span>{pendingMigration ? migrationPhaseLabel(pendingMigration.phase) : '等待回滚'}</span>
          </div>
          <div className="storage-settings-row">
            <span>
              <strong>{pendingMigration ? '迁移目标' : '回滚目标'}</strong>
              <small>{pendingMigration ? '源目录会被保留，校验完成后才切换' : '回到前一个仍然存在的数据目录'}</small>
            </span>
            <code>{pendingMigration?.targetDir ?? pendingRollback?.toDir}</code>
          </div>
          {(pendingMigration?.error || pendingRollback?.error) && (
            <div className="storage-settings-notice" data-tone="error">
              {pendingMigration?.error ?? pendingRollback?.error}
            </div>
          )}
          <div className="storage-settings-actions">
            <button
              type="button"
              onClick={() => void runStatusAction('cancel', cancelDataRootOperation)}
              disabled={!!busyAction}
            >
              取消待处理操作
            </button>
            <button
              className="primary"
              type="button"
              onClick={() => void restartNow()}
              disabled={!!busyAction}
            >
              {busyAction === 'restart' ? '正在重启' : '重启并执行'}
            </button>
          </div>
        </section>
      )}

      {!pending && status?.managed !== false && (
        <section className="storage-settings-section" aria-label="数据目录操作">
          <div className="storage-settings-heading">
            <strong>目录管理</strong>
            <span>下次启动生效</span>
          </div>
          <div className="storage-settings-row">
            <span>
              <strong>迁移完整数据根</strong>
              <small>目标必须不存在或为空；复制、重绑定和哈希校验成功后才会原子切换</small>
            </span>
            <button type="button" onClick={() => void chooseMigrationTarget()} disabled={!!busyAction}>
              {busyAction === 'select' ? '选择中' : '选择新位置'}
            </button>
          </div>
          {status?.canRollback && status.previousDataDir && (
            <div className="storage-settings-row">
              <span>
                <strong>回滚到前一个目录</strong>
                <small>{status.previousDataDir}</small>
              </span>
              <button
                type="button"
                onClick={() => void runStatusAction('rollback', requestDataRootRollback)}
                disabled={!!busyAction}
              >
                登记回滚
              </button>
            </div>
          )}
        </section>
      )}

      {status?.lastMigration && (
        <section className="storage-settings-section" aria-label="最近迁移记录">
          <div className="storage-settings-heading">
            <strong>最近迁移</strong>
            <span>{new Date(status.lastMigration.completedAt).toLocaleString('zh-CN')}</span>
          </div>
          <div className="storage-settings-row compact">
            <span>
              <strong>{status.lastMigration.fileCount} 个文件</strong>
              <small>{formatDataSize(status.lastMigration.totalBytes)}，完整清单已通过 SHA-256 校验</small>
            </span>
            <code>{status.lastMigration.targetDir}</code>
          </div>
        </section>
      )}

      {error && <div className="storage-settings-notice" data-tone="error" role="alert">{error}</div>}
    </div>
  )
}

function migrationPhaseLabel(phase: DataRootMigrationState['phase']): string {
  if (phase === 'copying') return '复制中断，等待续传'
  if (phase === 'verifying') return '校验中断，等待续传'
  if (phase === 'committing') return '提交中断，等待恢复'
  if (phase === 'failed') return '上次迁移失败'
  return '迁移已登记'
}

function formatDataSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function SettingsScheduledPage() {
  return (
    <div className="settings-module-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">工作</div>
        <h2>已安排</h2>
        <p>计划任务、提醒和周期执行会集中在这里。</p>
      </header>
      <div className="settings-module-toolbar" role="toolbar" aria-label="已安排筛选">
        <button className="settings-filter-pill active" type="button">全部</button>
        <button className="settings-filter-pill" type="button">提醒</button>
        <button className="settings-filter-pill" type="button">自动任务</button>
      </div>
      <div className="settings-module-empty">
        <div className="settings-module-empty-icon" aria-hidden="true">
          <ScheduleIcon />
        </div>
        <strong>暂无已安排任务</strong>
        <span>等计划任务接入后，这里会显示待执行、周期执行和已暂停的项目。</span>
      </div>
    </div>
  )
}

type PluginListFilter = 'all' | 'builtin' | 'local' | 'channel' | 'tool' | 'skill'

const PLUGIN_FILTERS: Array<{ id: PluginListFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'builtin', label: '内置' },
  { id: 'local', label: '本地' },
  { id: 'channel', label: '渠道' },
  { id: 'tool', label: '工具' },
  { id: 'skill', label: '技能' },
]

const PLUGIN_STATE_LABELS: Record<PluginStatus['state'], string> = {
  disabled: '已停用',
  inactive: '按需待命',
  activating: '正在启动',
  active: '运行中',
  blocked: '等待信任',
  failed: '启动失败',
}

const PLUGIN_CAPABILITY_LABELS: Record<string, string> = {
  channel: '渠道',
  tool: '工具',
  skill: '技能',
}

const PLUGIN_PERMISSION_LABELS: Record<string, string> = {
  'agent:run': '调用 Agent',
  'channels:register': '注册渠道',
  'tools:register': '注册工具',
  'skills:register': '注册技能',
  network: '访问网络',
  process: '启动进程',
  secrets: '读取所需密钥',
  'filesystem:plugin-data': '读写插件数据',
  'filesystem:workspace': '访问授权工作区',
}

function SettingsPluginsPage() {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PluginListFilter>('all')
  const [status, setStatus] = useState<PluginsStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [expandedPluginId, setExpandedPluginId] = useState<string | null>(null)
  const [confirmLocalCode, setConfirmLocalCode] = useState(false)
  const trustSectionRef = useRef<HTMLElement | null>(null)
  const mountedRef = useRef(true)
  const requestRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestRef.current += 1
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [])

  useEffect(() => {
    if (!confirmLocalCode) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!trustSectionRef.current?.contains(event.target as Node)) setConfirmLocalCode(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [confirmLocalCode])

  const filteredPlugins = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return (status?.plugins ?? []).filter((plugin) => {
      const matchesFilter = filter === 'all'
        || plugin.source === filter
        || plugin.capabilities.includes(filter as 'channel' | 'tool' | 'skill')
      if (!matchesFilter) return false
      if (!needle) return true
      return [
        plugin.name,
        plugin.id,
        plugin.description,
        plugin.publisher ?? '',
        ...plugin.capabilities,
        ...plugin.contributes.channels,
        ...plugin.contributes.tools,
        ...plugin.contributes.skills,
      ].some((value) => value.toLocaleLowerCase('zh-CN').includes(needle))
    })
  }, [filter, query, status])

  async function loadStatus(showLoading = true): Promise<void> {
    const requestId = ++requestRef.current
    if (showLoading) setLoading(true)
    try {
      const next = await getPluginsStatus()
      if (!mountedRef.current || requestId !== requestRef.current) return
      setStatus(next)
      setError(null)
    } catch (loadError) {
      if (!mountedRef.current || requestId !== requestRef.current) return
      setError((loadError as Error).message)
    } finally {
      if (showLoading && mountedRef.current && requestId === requestRef.current) setLoading(false)
    }
  }

  async function handleReload(): Promise<void> {
    setBusyAction('reload')
    setNotice(null)
    try {
      await reloadPlugins()
      if (!mountedRef.current) return
      await loadStatus(false)
      if (!mountedRef.current) return
      setNotice('插件已重新发现并加载')
    } catch (reloadError) {
      if (mountedRef.current) setError((reloadError as Error).message)
    } finally {
      if (mountedRef.current) setBusyAction(null)
    }
  }

  async function handlePluginEnabled(plugin: PluginStatus, enabled: boolean): Promise<void> {
    setBusyAction(plugin.id)
    setNotice(null)
    try {
      await setPluginEnabled(plugin.id, enabled)
      if (!mountedRef.current) return
      await loadStatus(false)
      if (!mountedRef.current) return
      setNotice(`${plugin.name}已${enabled ? '启用' : '停用'}`)
    } catch (toggleError) {
      if (mountedRef.current) setError((toggleError as Error).message)
    } finally {
      if (mountedRef.current) setBusyAction(null)
    }
  }

  async function handleLocalCodeAllowed(allowed: boolean): Promise<void> {
    setBusyAction('local-code')
    setNotice(null)
    try {
      await setLocalPluginCodeAllowed(allowed)
      if (!mountedRef.current) return
      await loadStatus(false)
      if (!mountedRef.current) return
      setConfirmLocalCode(false)
      setNotice(allowed ? '已允许执行本地插件代码' : '已停止执行本地插件代码')
    } catch (trustError) {
      if (mountedRef.current) setError((trustError as Error).message)
    } finally {
      if (mountedRef.current) setBusyAction(null)
    }
  }

  const localPluginCount = status?.plugins.filter((plugin) => plugin.source === 'local').length ?? 0
  const operationBusy = busyAction !== null

  return (
    <div className="settings-module-page">
      <header className="settings-module-heading plugin-page-heading">
        <div>
          <div className="settings-module-kicker">扩展</div>
          <h2>插件</h2>
          <p>管理 LS 的可选渠道、工具和本地扩展。</p>
        </div>
        <button
          className="plugin-reload-button"
          type="button"
          onClick={() => void handleReload()}
          disabled={operationBusy}
          aria-label="重新发现并加载插件"
          title="重新加载插件"
        >
          <RefreshIcon />
          <span>{busyAction === 'reload' ? '加载中' : '重新加载'}</span>
        </button>
      </header>

      <section ref={trustSectionRef} className="plugin-trust-section" aria-label="本地插件信任">
        <div className="plugin-trust-summary">
          <span className="plugin-trust-icon" aria-hidden="true"><PluginIcon /></span>
          <span className="plugin-trust-copy">
            <strong>本地插件代码</strong>
            <small>{localPluginCount > 0 ? `已发现 ${localPluginCount} 个本地插件` : '当前未发现本地插件'}</small>
          </span>
          <button
            className={`plugin-switch ${status?.allowLocalCode ? 'checked' : ''}`}
            type="button"
            role="switch"
            aria-checked={status?.allowLocalCode ?? false}
            aria-label="允许执行本地插件代码"
            disabled={!status || operationBusy}
            onClick={() => {
              if (status?.allowLocalCode) void handleLocalCodeAllowed(false)
              else setConfirmLocalCode(true)
            }}
          >
            <span aria-hidden="true" />
          </button>
        </div>
        <div
          className={`plugin-trust-confirmation ${confirmLocalCode ? 'visible' : ''}`}
          aria-hidden={!confirmLocalCode}
          {...(!confirmLocalCode ? { inert: '' } : {})}
        >
          <div className="plugin-trust-confirmation-inner">
            <div>
              <strong>信任本机安装的插件代码？</strong>
              <span>本地插件与主进程拥有同等权限，可访问本机数据和网络。只启用来源明确且已审查的插件。</span>
            </div>
            <div className="plugin-trust-actions">
              <button type="button" onClick={() => setConfirmLocalCode(false)}>取消</button>
              <button
                className="danger"
                type="button"
                disabled={operationBusy}
                onClick={() => void handleLocalCodeAllowed(true)}
              >
                确认信任
              </button>
            </div>
          </div>
        </div>
      </section>

      <label className="settings-module-search">
        <SearchIcon />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索插件"
        />
      </label>
      <div className="settings-module-toolbar" role="toolbar" aria-label="插件筛选">
        {PLUGIN_FILTERS.map((item) => (
          <button
            key={item.id}
            className={`settings-filter-pill ${filter === item.id ? 'active' : ''}`}
            type="button"
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
        {status && (
          <span className={`plugin-host-state ${status.started ? 'ready' : 'starting'}`}>
            <span aria-hidden="true" />
            {status.started ? `${status.plugins.length} 个插件` : '插件宿主初始化中'}
          </span>
        )}
      </div>

      {notice && <div className="plugin-page-notice" role="status">{notice}</div>}
      {error && <div className="plugin-page-error" role="alert">{error}</div>}

      {loading && (
        <div className="plugin-list-loading">
          <span className="plugin-loading-indicator" aria-hidden="true" />
          正在读取插件状态
        </div>
      )}

      {!loading && status && filteredPlugins.length > 0 && (
        <div className="plugin-list" aria-label="已发现插件">
          {filteredPlugins.map((plugin) => {
            const expanded = expandedPluginId === plugin.id
            const capabilityText = plugin.capabilities
              .map((capability) => PLUGIN_CAPABILITY_LABELS[capability] ?? capability)
              .join(' · ')
            const detailId = `plugin-details-${plugin.id}`
            return (
              <article key={plugin.id} className={`plugin-list-item ${expanded ? 'expanded' : ''}`}>
                <div className="plugin-list-summary">
                  <button
                    className="plugin-list-disclosure"
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={detailId}
                    onClick={() => setExpandedPluginId(expanded ? null : plugin.id)}
                  >
                    <span className="plugin-list-icon" aria-hidden="true"><PluginIcon /></span>
                    <span className="plugin-list-main">
                      <span className="plugin-list-title">
                        <strong>{plugin.name}</strong>
                        <small>v{plugin.version}</small>
                      </span>
                      <span className="plugin-list-description">{plugin.description || plugin.id}</span>
                      <span className="plugin-list-meta">
                        {plugin.source === 'builtin' ? '内置' : '本地'} · {capabilityText}
                      </span>
                      {plugin.error && <span className="plugin-list-error">{plugin.error}</span>}
                    </span>
                    <span className={`plugin-runtime-state ${plugin.state}`}>{PLUGIN_STATE_LABELS[plugin.state]}</span>
                    <span className="plugin-disclosure-chevron" aria-hidden="true" />
                  </button>
                  <button
                    className={`plugin-switch ${plugin.enabled ? 'checked' : ''}`}
                    type="button"
                    role="switch"
                    aria-checked={plugin.enabled}
                    aria-label={`${plugin.enabled ? '停用' : '启用'}${plugin.name}`}
                    disabled={operationBusy}
                    onClick={() => void handlePluginEnabled(plugin, !plugin.enabled)}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>
                <div
                  id={detailId}
                  className={`plugin-list-details ${expanded ? 'visible' : ''}`}
                  aria-hidden={!expanded}
                  {...(!expanded ? { inert: '' } : {})}
                >
                  <dl className="plugin-list-details-inner">
                    <div><dt>标识</dt><dd>{plugin.id}</dd></div>
                    <div>
                      <dt>贡献</dt>
                      <dd>{[
                        ...plugin.contributes.channels.map((item) => `渠道 ${item}`),
                        ...plugin.contributes.tools.map((item) => `工具 ${item}`),
                        ...plugin.contributes.skills.map((item) => `技能 ${item}`),
                      ].join('，') || '无'}</dd>
                    </div>
                    <div>
                      <dt>激活</dt>
                      <dd>{plugin.activationEvents.map(pluginActivationLabel).join('，')}</dd>
                    </div>
                    <div>
                      <dt>权限声明</dt>
                      <dd>{plugin.permissions.map((item) => PLUGIN_PERMISSION_LABELS[item] ?? item).join('，') || '无额外声明'}</dd>
                    </div>
                    {plugin.publisher && <div><dt>发布者</dt><dd>{plugin.publisher}</dd></div>}
                    {plugin.location && <div><dt>位置</dt><dd className="plugin-location">{plugin.location}</dd></div>}
                  </dl>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {!loading && status && filteredPlugins.length === 0 && (
        <div className="settings-module-empty">
          <div className="settings-module-empty-icon" aria-hidden="true"><PluginIcon /></div>
          <strong>没有匹配的插件</strong>
          <span>{query.trim() || filter !== 'all' ? '调整关键词或筛选条件后再试。' : '将插件放入用户插件目录后重新加载。'}</span>
        </div>
      )}

      {status && status.diagnostics.length > 0 && (
        <section className="plugin-diagnostics" aria-label="插件发现问题">
          <strong>未载入的插件</strong>
          {status.diagnostics.map((diagnostic, index) => (
            <div key={`${diagnostic.source}:${index}`}>
              <span>{diagnostic.source}</span>
              <small>{diagnostic.message}</small>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

function pluginActivationLabel(event: string): string {
  if (event === 'onStartup') return '应用启动时'
  if (event.startsWith('onChannel:')) return `启用 ${event.slice('onChannel:'.length)} 渠道时`
  return event
}

function MessageFileStrip({
  files,
  label,
  onOpenFile,
}: {
  files: WorkspaceArtifactRef[]
  label: string
  onOpenFile: (path: string) => void
}) {
  if (files.length === 0) return null

  return (
    <div className="message-file-strip" aria-label={label}>
      <span className="message-file-strip-label">{label}</span>
      <div className="message-file-list">
        {files.map((file) => (
          <button
            key={`${file.action}:${file.path}`}
            className={`message-file-card ${file.action}`}
            type="button"
            onClick={() => onOpenFile(file.path)}
          >
            <span className="message-file-icon" aria-hidden="true">
              <FileGlyphIcon />
            </span>
            <span className="message-file-main">
              <strong>{file.name}</strong>
              <small>{fileActionLabel(file.action)} · {compactPath(file.path)}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function fileActionLabel(action: WorkspaceArtifactRef['action']): string {
  if (action === 'attached') return '附件'
  return action === 'created' ? '新建' : '修改'
}

function AttachmentPreviewCard({
  file,
  onOpen,
  onRemove,
  onTipChange,
}: {
  file: AttachmentRef
  onOpen: () => void
  onRemove: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const name = file.name ?? lastPathSegment(file.path)
  const kind = file.kind ?? inferAttachmentKind(name || file.path)
  const isImage = kind === 'image'
  const tip = `${name}\n${file.path}`

  return (
    <div
      className={`attachment-preview-card ${isImage ? 'image' : 'file'}`}
      tabIndex={0}
      role="button"
      aria-label={tip}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen()
      }}
      onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
      onMouseMove={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
      onMouseLeave={() => onTipChange(null)}
      onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(tip, event.currentTarget))}
      onBlur={() => onTipChange(null)}
    >
      <button
        className="attachment-preview-remove"
        type="button"
        aria-label={`移除 ${name}`}
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
      >
        ×
      </button>
      {isImage ? (
        <img className="attachment-preview-thumb" src={attachmentFileUrl(file.path)} alt="" />
      ) : (
        <div className="attachment-preview-file-icon">{attachmentExtLabel(name)}</div>
      )}
      <div className="attachment-preview-meta">
        <span>{name}</span>
        <small>{formatFileSize(file.size)}</small>
      </div>
    </div>
  )
}

function formatUserMessage(text: string, attachments: AttachmentRef[]): string {
  if (attachments.length === 0) return text
  return text || '已上传附件。'
}

function shortPath(path: string, workplace: string): string {
  if (isSamePath(path, workplace)) return compactPath(workplace)
  return compactPath(path)
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return path
  return `${parts.at(-2)}\\${parts.at(-1)}`
}

function workspaceTitle(path: string, workplace: string): string {
  return isSamePath(path, workplace) ? `LittleSheep workplace: ${workplace}` : path
}

function workspaceBreadcrumbs(root: string, path: string): string[] {
  const rootName = lastPathSegment(root) || compactPath(root)
  const normalizedRoot = normalizePathForCompare(root)
  const normalizedPath = normalizePathForCompare(path)
  if (!normalizedPath.startsWith(normalizedRoot)) return [rootName, lastPathSegment(path)].filter(Boolean)
  const relative = path.slice(root.length).replace(/^[\\/]+/, '')
  const parts = relative.split(/[\\/]/).filter(Boolean)
  return [rootName, ...parts].slice(-5)
}

function attachmentToArtifact(file: AttachmentRef): WorkspaceArtifactRef {
  return {
    path: file.path,
    name: file.name ?? lastPathSegment(file.path),
    action: 'attached',
  }
}

function resolveWorkspacePreviewRoot(path: string, runtime: RuntimeState | null, fallbackRoot: string): string {
  const candidates = [runtime?.workspace, runtime?.workplace, fallbackRoot].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) {
    if (isPathInsideOrSameClient(path, candidate)) return candidate
  }
  return directoryPath(path) || fallbackRoot
}

function isPathInsideOrSameClient(path: string, root: string): boolean {
  const normalizedPath = normalizePathForCompare(path)
  const normalizedRoot = normalizePathForCompare(root)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`)
}

function isSamePath(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b)
}

function normalizePathForCompare(value: string): string {
  return value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}

function directoryPath(path: string): string {
  const normalized = path.replace(/\//g, '\\').replace(/[\\]+$/, '')
  const index = normalized.lastIndexOf('\\')
  if (index <= 0) return ''
  return normalized.slice(0, index)
}

function workspaceAncestorPaths(root: string, path: string): string[] {
  if (!root || !path || !isPathInsideOrSameClient(path, root) || isSamePath(path, root)) return []
  const ancestors: string[] = []
  let current = directoryPath(path)
  while (current && isPathInsideOrSameClient(current, root) && !isSamePath(current, root)) {
    ancestors.unshift(current)
    current = directoryPath(current)
  }
  return [root, ...ancestors]
}

function dataTransferHasFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

function inferAttachmentKind(name: string, mimeType = ''): AttachmentRef['kind'] {
  if (mimeType.startsWith('image/')) return 'image'
  const ext = extensionOf(name)
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'svg'].includes(ext)) return 'image'
  if (['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) return 'document'
  return 'file'
}

const WORKSPACE_EXTERNAL_EDITOR_BLOCKED_EXTS = new Set([
  'doc',
  'docx',
  'docm',
  'dot',
  'dotx',
  'ppt',
  'pptx',
  'pptm',
  'pps',
  'ppsx',
  'pot',
  'potx',
  'xls',
  'xlsx',
  'xlsm',
  'xlsb',
  'xlt',
  'xltx',
  'odt',
  'odp',
  'ods',
])

function shouldOfferExternalVSCode(preview: WorkspacePreview): boolean {
  if (preview.kind === 'image' || preview.kind === 'pdf') return false
  return !WORKSPACE_EXTERNAL_EDITOR_BLOCKED_EXTS.has(extensionOf(preview.name))
}

function attachmentFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const prefix = /^[A-Za-z]:/.test(normalized) ? 'file:///' : 'file://'
  const encoded = normalized
    .split('/')
    .map((part, index) => (index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)))
    .join('/')
  return `${prefix}${encoded}`
}

function attachmentExtLabel(name: string): string {
  const ext = extensionOf(name)
  return ext ? ext.slice(0, 4).toUpperCase() : 'FILE'
}

function extensionOf(name: string): string {
  const clean = lastPathSegment(name).toLowerCase()
  const index = clean.lastIndexOf('.')
  return index >= 0 ? clean.slice(index + 1) : ''
}

function formatFileSize(size?: number): string {
  if (!size || size <= 0) return 'unknown size'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function countEditorLines(text: string): number {
  if (!text) return 1
  return text.split(/\r\n|\r|\n/).length
}

function detectEditorEol(text: string): string {
  return text.includes('\r\n') ? 'CRLF' : 'LF'
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function formatEditorLanguageLabel(language: string): string {
  if (!language) return 'Text'
  const labels: Record<string, string> = {
    bat: 'Batch',
    cpp: 'C++',
    css: 'CSS',
    dockerfile: 'Dockerfile',
    hcl: 'HCL',
    html: 'HTML',
    ini: 'INI',
    javascript: 'JavaScript',
    json: 'JSON',
    markdown: 'Markdown',
    objective: 'Objective-C',
    'objective-c': 'Objective-C',
    powershell: 'PowerShell',
    python: 'Python',
    shell: 'Shell',
    sql: 'SQL',
    systemverilog: 'SystemVerilog',
    text: 'Text',
    typescript: 'TypeScript',
    xml: 'XML',
    yaml: 'YAML',
  }
  return labels[language] ?? language.replace(/(^|[-_])\w/g, (part) => part.replace(/[-_]/, '').toUpperCase())
}

function formatDateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return ''
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function lastPathSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function AddMenu({
  label,
  onAddFiles,
  onChooseWorkspace,
  onTipChange,
}: {
  label: string
  onAddFiles: () => void | Promise<void>
  onChooseWorkspace: () => void | Promise<void>
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useDismissOnOutside(open, [rootRef], () => setOpen(false))

  useEffect(() => {
    const handleComposerMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== 'add') setOpen(false)
    }
    window.addEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
    return () => window.removeEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
  }, [])

  function runAction(action: () => void | Promise<void>) {
    setOpen(false)
    onTipChange(null)
    void action()
  }

  return (
    <div ref={rootRef} className={`add-menu ${open ? 'open' : ''}`}>
      <button
        {...transientTriggerProps()}
        className="icon-btn add-menu-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          onTipChange(null)
          setOpen((value) => {
            const next = !value
            if (next) window.dispatchEvent(new CustomEvent(COMPOSER_MENU_EVENT, { detail: 'add' }))
            return next
          })
        }}
        onMouseEnter={(event) => {
          if (!open) onTipChange(buildFloatingHelpTip(label, event.clientX, event.clientY))
        }}
        onMouseMove={(event) => {
          if (!open) onTipChange(buildFloatingHelpTip(label, event.clientX, event.clientY))
        }}
        onMouseLeave={() => onTipChange(null)}
        onFocus={(event) => {
          if (!open) onTipChange(buildFloatingHelpTipFromElement(label, event.currentTarget))
        }}
        onBlur={() => onTipChange(null)}
      >
        +
      </button>
      <div className="add-menu-panel" role="menu" aria-label="添加">
        <div className="add-menu-title">添加</div>
        <button className="add-menu-item" type="button" role="menuitem" onClick={() => runAction(onAddFiles)}>
          <span className="add-menu-icon">+</span>
          <span className="add-menu-text">
            <strong>文件</strong>
            <small>添加图片或文档到这次请求</small>
          </span>
        </button>
        <button className="add-menu-item" type="button" role="menuitem" onClick={() => runAction(onChooseWorkspace)}>
          <span className="add-menu-icon">#</span>
          <span className="add-menu-text">
            <strong>目标工作区</strong>
            <small>指定这次任务在哪个文件夹里工作</small>
          </span>
        </button>
      </div>
    </div>
  )
}

function WorkspaceChip({
  path,
  tip,
  onReset,
  onTipChange,
}: {
  path: string
  tip: string
  onReset: () => void | Promise<void>
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const label = compactPath(path)

  return (
    <span
      className="workspace-context-chip"
      aria-label={`目标工作区: ${tip}`}
      onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
      onMouseMove={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
      onMouseLeave={() => onTipChange(null)}
      onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(tip, event.currentTarget))}
      onBlur={() => onTipChange(null)}
    >
      <span className="workspace-context-label">工作区</span>
      <span className="workspace-context-path">{label}</span>
      <button
        className="workspace-context-remove"
        type="button"
        aria-label="移除目标工作区"
        onClick={() => {
          onTipChange(null)
          void onReset()
        }}
      >
        ×
      </button>
    </span>
  )
}

function ModePicker({
  value,
  onChange,
}: {
  value: PermissionModeId
  onChange: (value: PermissionModeId) => void
}) {
  const [open, setOpen] = useState(false)
  const [tip, setTip] = useState<FloatingHelpTip | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = MODE_OPTIONS.find((item) => item.id === value) ?? MODE_OPTIONS[0]!

  useDismissOnOutside(open, [rootRef], () => setOpen(false))

  useEffect(() => {
    const handleComposerMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== 'mode') setOpen(false)
    }
    window.addEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
    return () => window.removeEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
  }, [])

  useEffect(() => {
    if (!open) setTip(null)
  }, [open])

  return (
    <div ref={rootRef} className={`model-picker option-picker mode-picker risk-${selected.risk} ${open ? 'open' : ''}`}>
      <button
        {...transientTriggerProps()}
        type="button"
        className="model-picker-trigger mode-picker-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${selected.label}: ${selected.riskLabel}，${selected.desc}`}
        onMouseEnter={(event) => {
          if (!open && selected?.desc) setTip(buildFloatingHelpTip(selected.desc, event.clientX, event.clientY))
        }}
        onMouseMove={(event) => {
          if (!open && selected?.desc) setTip(buildFloatingHelpTip(selected.desc, event.clientX, event.clientY))
        }}
        onMouseLeave={() => setTip(null)}
        onFocus={(event) => {
          if (open || !selected?.desc) return
          setTip(buildFloatingHelpTipFromElement(selected.desc, event.currentTarget))
        }}
        onBlur={() => setTip(null)}
        onClick={() => {
          setTip(null)
          setOpen((current) => {
            const next = !current
            if (next) window.dispatchEvent(new CustomEvent(COMPOSER_MENU_EVENT, { detail: 'mode' }))
            return next
          })
        }}
      >
        <ModeRiskIcon risk={selected.risk} className="mode-picker-mark" />
        <span className="model-picker-current">{selected.label}</span>
      </button>
      <div className="model-picker-panel option-picker-panel mode-picker-panel" role="dialog" aria-label="权限模式选择">
        <div className="option-picker-list" role="listbox" aria-label="权限模式">
          {MODE_OPTIONS.map((item) => {
            const isActive = item.id === value
            return (
              <button
                key={item.id}
                type="button"
                className={`model-option option-picker-option mode-option risk-${item.risk} ${isActive ? 'active' : ''}`}
                aria-label={`${item.label}: ${item.riskLabel}，${item.desc}`}
                onMouseEnter={(event) => setTip(buildFloatingHelpTip(item.desc, event.clientX, event.clientY))}
                onMouseMove={(event) => setTip(buildFloatingHelpTip(item.desc, event.clientX, event.clientY))}
                onMouseLeave={() => setTip(null)}
                onFocus={(event) => {
                  setTip(buildFloatingHelpTipFromElement(item.desc, event.currentTarget))
                }}
                onBlur={() => setTip(null)}
                onClick={() => {
                  if (!isActive) onChange(item.id)
                  setTip(null)
                  setOpen(false)
                }}
              >
                <ModeRiskIcon risk={item.risk} className="mode-option-mark" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>
      </div>
      <FloatingHelpTooltip tip={tip} />
    </div>
  )
}

function ModeRiskIcon({ risk, className }: { risk: ModeRisk; className: string }) {
  const isWarning = risk === 'critical' || risk === 'high'
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle className="mode-risk-ring" cx="8" cy="8" r="7" />
      {isWarning ? (
        <>
          <rect className="mode-risk-stem" x="6.75" y="3" width="2.5" height="7.5" rx="1.25" />
          <circle className="mode-risk-dot" cx="8" cy="12.25" r="1.35" />
        </>
      ) : (
        <circle className="mode-risk-dot" cx="8" cy="8" r="1.8" />
      )}
    </svg>
  )
}

interface FloatingHelpTip {
  text: string
  x: number
  y: number
}

function buildFloatingHelpTip(text: string, clientX: number, clientY: number): FloatingHelpTip {
  const maxWidth = 260
  const maxHeight = 86
  const margin = 12
  const x = Math.min(clientX + 14, window.innerWidth - maxWidth - margin)
  const y = Math.min(clientY + 10, window.innerHeight - maxHeight - margin)
  return {
    text,
    x: Math.max(margin, x),
    y: Math.max(margin, y),
  }
}

function buildFloatingHelpTipFromElement(text: string, element: HTMLElement): FloatingHelpTip {
  const rect = element.getBoundingClientRect()
  return buildFloatingHelpTip(text, rect.right, rect.top + rect.height / 2)
}

function FloatingHelpTooltip({ tip }: { tip: FloatingHelpTip | null }) {
  const [renderedTip, setRenderedTip] = useState<FloatingHelpTip | null>(null)
  const [shown, setShown] = useState(false)
  const renderedTipRef = useRef<FloatingHelpTip | null>(null)
  const activeRef = useRef(false)
  const tokenRef = useRef(0)
  const frameRef = useRef<number>()

  useEffect(() => {
    const token = tokenRef.current + 1
    tokenRef.current = token
    window.cancelAnimationFrame(frameRef.current ?? 0)

    if (!tip) {
      setShown(false)
      const hideTimer = window.setTimeout(() => {
        if (tokenRef.current !== token) return
        renderedTipRef.current = null
        activeRef.current = false
        setRenderedTip(null)
      }, FLOATING_HELP_EXIT_MS)
      return () => window.clearTimeout(hideTimer)
    }

    if (activeRef.current && renderedTipRef.current) {
      renderedTipRef.current = tip
      setRenderedTip(tip)
      setShown(true)
      return
    }

    setShown(false)
    const showTimer = window.setTimeout(() => {
      if (tokenRef.current !== token) return
      renderedTipRef.current = tip
      activeRef.current = true
      setRenderedTip(tip)
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = undefined
        if (tokenRef.current === token) setShown(true)
      })
    }, FLOATING_HELP_DELAY_MS)
    return () => {
      window.clearTimeout(showTimer)
      window.cancelAnimationFrame(frameRef.current ?? 0)
    }
  }, [tip])

  if (!renderedTip) return null
  return createPortal(
    <div
      className={`floating-help-tip ${shown ? 'visible' : ''}`}
      style={{ left: renderedTip.x, top: renderedTip.y }}
    >
      {renderedTip.text}
    </div>,
    document.body,
  )
}

type RuntimeProvider = RuntimeState['providers'][number]

function ContextUsageIndicator({ usage }: { usage: ContextUsage }) {
  const windowKnown = usage.maxTokens > 0
  const tone = usage.available && usage.percent >= 90 ? 'danger' : usage.available && usage.percent >= 70 ? 'warning' : 'normal'
  const style = {
    '--context-usage-angle': `${usage.available ? Math.max(0, Math.min(100, usage.percent)) * 3.6 : 0}deg`,
  } as CSSProperties
  const ariaLabel = !windowKnown
    ? '当前模型的上下文窗口尚未登记'
    : usage.available
    ? `上下文${usage.source === 'provider' ? '供应商实测' : '本地精确装配'}已用 ${formatTokenCount(usage.usedTokens)}，共 ${formatTokenCount(usage.maxTokens)}，${usage.percent}% 已用`
    : `上下文真实用量待模型供应商返回，共 ${formatTokenCount(usage.maxTokens)}`

  return (
    <div
      className={`context-usage tone-${tone}`}
      style={style}
      role="status"
      tabIndex={0}
      aria-label={ariaLabel}
    >
      <span className="context-usage-ring" aria-hidden="true" />
      <span className="context-usage-popover" aria-hidden="true">
        <span className="context-usage-title">上下文窗口：</span>
        {!windowKnown ? (
          <>
            <span>当前模型的上下文窗口尚未登记</span>
            <strong>不可用</strong>
          </>
        ) : usage.available ? (
          <>
            {usage.providerUsedTokens !== undefined ? (
              <span className="context-usage-source">
                供应商实测 {formatTokenCount(usage.providerUsedTokens)} · {formatUsageTime(usage.providerReportedAt)}
              </span>
            ) : (
              <span className="context-usage-source">供应商实测待返回</span>
            )}
            {usage.localUsedTokens !== undefined ? (
              <span className="context-usage-source" title={usage.localTokenizerId}>
                本地精确装配 {formatTokenCount(usage.localUsedTokens)} · {formatUsageTime(usage.localCountedAt)}
              </span>
            ) : (
              <span className="context-usage-source" title={usage.localUnavailableReason}>
                本地精确计数不可用
              </span>
            )}
            <span>共 {formatTokenCount(usage.maxTokens)}</span>
            <strong>{usage.percent}% 已用</strong>
          </>
        ) : (
          <>
            <span>等待模型供应商返回真实用量</span>
            <strong>共 {formatTokenCount(usage.maxTokens)}</strong>
          </>
        )}
      </span>
    </div>
  )
}

function formatUsageTime(value: string | undefined): string {
  if (!value) return '本轮'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '本轮'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000
    return `${Number.isInteger(value) ? value : value.toFixed(1)}M`
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

interface SelectedRuntimeModel {
  provider: RuntimeProvider
  model: string
  ref: string
}

function RuntimePicker({
  runtime,
  providers,
  selected,
  onModelChange,
  onReasoningChange,
}: {
  runtime: RuntimeState | null
  providers: RuntimeProvider[]
  selected: SelectedRuntimeModel | null
  onModelChange: (model: string) => void
  onReasoningChange: (value: RuntimeReasoning) => void
}) {
  const [open, setOpen] = useState(false)
  const [activeProviderId, setActiveProviderId] = useState('')
  const [activeSubmenu, setActiveSubmenu] = useState<'model' | 'provider' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const submenuCloseTimerRef = useRef<number>()
  const disabled = !runtime
  const activeProvider = providers.find((provider) => provider.id === activeProviderId) ?? providers[0]
  const activeModels = activeProvider?.models ?? []
  const reasoning = runtime?.reasoning ?? 'auto'
  const supportedReasoningIds = useMemo(
    () => getSupportedReasoningOptions(selected?.provider.id ?? '', selected?.model ?? ''),
    [selected?.model, selected?.provider.id],
  )
  const effectiveReasoning = supportedReasoningIds.includes(reasoning) ? reasoning : 'auto'
  const visibleReasoningOptions = REASONING_OPTIONS.filter((item) => supportedReasoningIds.includes(item.id))
  const reasoningOption = REASONING_OPTIONS.find((item) => item.id === effectiveReasoning) ?? REASONING_OPTIONS[0]
  const modelLabel = selected?.model ?? (providers.length === 0 ? '无可用模型' : '选择模型')

  useEffect(() => {
    if (providers.length === 0) {
      setActiveProviderId('')
      setActiveSubmenu(null)
      setOpen(false)
      return
    }
    const selectedProviderId = selected?.provider.id
    setActiveProviderId((current) => {
      if (selectedProviderId && providers.some((provider) => provider.id === selectedProviderId)) {
        return selectedProviderId
      }
      if (providers.some((provider) => provider.id === current)) return current
      return providers[0]?.id ?? ''
    })
  }, [providers, selected?.provider.id])

  useEffect(() => {
    if (!open) setActiveSubmenu(null)
  }, [open])

  useEffect(() => () => window.clearTimeout(submenuCloseTimerRef.current), [])

  useEffect(() => {
    if (!runtime || reasoning === effectiveReasoning) return
    onReasoningChange(effectiveReasoning)
  }, [effectiveReasoning, reasoning, runtime?.model])

  useEffect(() => {
    const handleComposerMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== 'runtime') {
        setActiveSubmenu(null)
        setOpen(false)
      }
    }
    window.addEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
    return () => window.removeEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
  }, [])

  function closePicker() {
    window.clearTimeout(submenuCloseTimerRef.current)
    setActiveSubmenu(null)
    setOpen(false)
  }

  function openRuntimeSubmenu(submenu: 'model' | 'provider') {
    window.clearTimeout(submenuCloseTimerRef.current)
    setActiveSubmenu(submenu)
  }

  function scheduleRuntimeSubmenuClose(delay = 140) {
    window.clearTimeout(submenuCloseTimerRef.current)
    submenuCloseTimerRef.current = window.setTimeout(() => {
      setActiveSubmenu(null)
    }, delay)
  }

  function cancelRuntimeSubmenuClose() {
    window.clearTimeout(submenuCloseTimerRef.current)
  }

  useDismissOnOutside(open, [rootRef], closePicker)

  return (
    <div ref={rootRef} className={`runtime-picker ${open ? 'open' : ''}`}>
      <button
        {...transientTriggerProps()}
        type="button"
        className="runtime-picker-trigger"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`模型 ${modelLabel}, 推理 ${reasoningOption?.label ?? effectiveReasoning}`}
        onClick={() => {
          setOpen((value) => {
            const next = !value
            if (next) window.dispatchEvent(new CustomEvent(COMPOSER_MENU_EVENT, { detail: 'runtime' }))
            return next
          })
        }}
      >
        <span className="runtime-picker-model">{modelLabel}</span>
        <span className="runtime-picker-reasoning">{reasoningOption?.label ?? effectiveReasoning}</span>
      </button>
      <div
        className="runtime-menu-shell"
        aria-hidden={!open}
        onMouseEnter={cancelRuntimeSubmenuClose}
        onMouseLeave={() => scheduleRuntimeSubmenuClose(80)}
      >
        <div className="runtime-picker-panel runtime-menu-panel" role="menu" aria-label="模型和推理选择">
          <div className="runtime-section-title">推理程度</div>
          <div
            className="runtime-menu-list"
            role="group"
            aria-label="推理强度"
            onMouseEnter={() => scheduleRuntimeSubmenuClose(80)}
          >
            {visibleReasoningOptions.map((item) => {
              const isActive = item.id === effectiveReasoning
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`runtime-menu-item runtime-reasoning-option ${isActive ? 'active' : ''}`}
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => {
                    if (!isActive) onReasoningChange(item.id)
                    closePicker()
                  }}
                >
                  <span>{item.label}</span>
                  <small>{item.desc}</small>
                  <span className="runtime-menu-check" aria-hidden="true">{isActive ? '✓' : ''}</span>
                </button>
              )
            })}
          </div>
          <div className="runtime-menu-divider" />
          {providers.length === 0 ? (
            <div className="runtime-empty">没有已配置的可用模型</div>
          ) : (
            <button
              type="button"
              className={`runtime-menu-item runtime-submenu-trigger ${activeSubmenu === 'model' ? 'active' : ''}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={activeSubmenu === 'model'}
              onMouseEnter={() => openRuntimeSubmenu('model')}
              onMouseLeave={() => scheduleRuntimeSubmenuClose()}
              onFocus={() => openRuntimeSubmenu('model')}
              onClick={() => setActiveSubmenu((value) => (value === 'model' ? null : 'model'))}
            >
              <span>模型</span>
              <small>{modelLabel}</small>
              <span className="runtime-submenu-arrow" aria-hidden="true">&gt;</span>
            </button>
          )}
          {providers.length > 0 && (
            <>
              <div className="runtime-menu-divider" />
              <button
                type="button"
                className={`runtime-menu-item runtime-submenu-trigger ${activeSubmenu === 'provider' ? 'active' : ''}`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={activeSubmenu === 'provider'}
                onMouseEnter={() => openRuntimeSubmenu('provider')}
                onMouseLeave={() => scheduleRuntimeSubmenuClose()}
                onFocus={() => openRuntimeSubmenu('provider')}
                onClick={() => setActiveSubmenu((value) => (value === 'provider' ? null : 'provider'))}
              >
                <span>厂商</span>
                <small>{activeProvider?.name ?? '选择厂商'}</small>
                <span className="runtime-submenu-arrow" aria-hidden="true">&gt;</span>
              </button>
            </>
          )}
        </div>
        <div
          className={`runtime-submenu runtime-${activeSubmenu ?? 'model'}-menu ${activeSubmenu && providers.length > 0 ? 'visible' : ''}`}
          role="menu"
          aria-label={
            activeSubmenu === 'provider'
              ? '供应商'
              : activeProvider ? `${activeProvider.name} 模型` : '模型'
          }
          aria-hidden={!activeSubmenu || providers.length === 0}
          onMouseEnter={cancelRuntimeSubmenuClose}
          onMouseLeave={() => scheduleRuntimeSubmenuClose()}
        >
          <div className="runtime-menu-list">
            {activeSubmenu === 'provider'
              ? providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className={`runtime-menu-item runtime-provider-option ${
                    provider.id === activeProvider?.id ? 'active' : ''
                  }`}
                  role="menuitemradio"
                  aria-checked={provider.id === activeProvider?.id}
                  onMouseEnter={() => setActiveProviderId(provider.id)}
                  onFocus={() => setActiveProviderId(provider.id)}
                  onClick={() => setActiveProviderId(provider.id)}
                >
                  <span>{provider.name}</span>
                  <small>{provider.models.length}</small>
                </button>
              ))
              : activeModels.map((model) => {
                const ref = `${activeProvider?.id}/${model}`
                const isActive = ref === runtime?.model
                return (
                  <button
                    key={ref}
                    type="button"
                    className={`runtime-menu-item runtime-model-option ${isActive ? 'active' : ''}`}
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => {
                      if (!isActive) onModelChange(ref)
                      closePicker()
                    }}
                  >
                    <span>{model}</span>
                    <span className="runtime-menu-check" aria-hidden="true">{isActive ? '✓' : ''}</span>
                  </button>
                )
              })}
          </div>
        </div>
      </div>
    </div>
  )
}

function splitModelRef(ref: string): { providerId: string; model: string } {
  const idx = ref.indexOf('/')
  if (idx < 0) return { providerId: '', model: ref }
  return { providerId: ref.slice(0, idx), model: ref.slice(idx + 1) }
}

function buildTraceData(result: {
  trace?: { name: string; ok: boolean }[]
  durationMs?: number
  messages?: { role: string; content: unknown[] }[]
}) {
  const msgs = result.messages ?? []
  const toolCalls: { name: string; input: unknown; output?: unknown; error?: string; ok: boolean }[] = []
  for (const m of msgs) {
    if (m.role !== 'assistant') continue
    const tcBlock = (m.content as Array<
      { type?: string; calls?: Array<{ id: string; name: string; input: unknown }> }
    >).find((c) => c.type === 'tool_calls')
    if (!tcBlock?.calls) continue
    for (const tc of tcBlock.calls) {
      const trBlock = msgs
        .filter((rm) => rm.role === 'tool')
        .flatMap((rm) => rm.content as Array<
          { type?: string; result?: { callId: string; ok: boolean; output?: unknown; error?: string } }
        >)
        .find((c) => c.type === 'tool_result' && c.result?.callId === tc.id)
      toolCalls.push({
        name: tc.name,
        input: tc.input,
        output: trBlock?.result?.output,
        error: trBlock?.result?.error,
        ok: trBlock?.result?.ok ?? true,
      })
    }
  }
  return { trace: result.trace, durationMs: result.durationMs, toolCalls: toolCalls.length > 0 ? toolCalls : undefined }
}

function buildArtifactsFromToolCalls(
  toolCalls?: { name: string; input: unknown; ok: boolean }[],
): WorkspaceArtifactRef[] | undefined {
  if (!toolCalls?.length) return undefined
  const byPath = new Map<string, WorkspaceArtifactRef>()
  for (const tool of toolCalls) {
    if (!tool.ok) continue
    const path = toolFilePath(tool.input)
    if (!path) continue
    const action = tool.name === 'write' || tool.name === 'write_file' ? 'created' : tool.name === 'edit' || tool.name === 'edit_file' ? 'modified' : null
    if (!action) continue
    byPath.set(path, {
      path,
      name: lastPathSegment(path),
      action,
      toolName: tool.name,
    })
  }
  return byPath.size > 0 ? Array.from(byPath.values()) : undefined
}

function buildArtifactsFromLiveTools(tools?: LiveToolEvent[]): WorkspaceArtifactRef[] | undefined {
  if (!tools?.length) return undefined
  return buildArtifactsFromToolCalls(tools
    .filter((tool) => tool.ok === true)
    .map((tool) => ({
      name: tool.name,
      input: tool.input,
      ok: true,
    })))
}

function toolFilePath(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  const value = record.file_path ?? record.path ?? record.filePath
  return typeof value === 'string' ? value.trim() : ''
}
