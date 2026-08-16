// Session lifecycle, sidebar conversation actions, and session-scoped approval cleanup.
import '@xterm/xterm/css/xterm.css'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { projectSessions } from '../../shared/session-scope'
import {
  deleteSession,
  getSessionMessagePage,
  renameSession as requestSessionRename,
  updateRuntime,
  type ProjectMeta,
  type RuntimeState,
  type SessionMeta
} from '../api'
import { AppRoute, SidebarPanel } from '../app-shell/types'
import {
  SessionApprovalGrantStore,
  sessionApprovalScopeKey,
  type ApprovalDecision
} from '../approval-grants'
import { historyMessageToChatMessage } from '../chat/assistant-turn'
import { ChatMessage } from '../chat/types'
import {
  type ContextUsageSnapshot
} from '../context-usage'
import { FloatingHelpTip } from '../ui/floating-help'
import { isSamePath } from '../workspace/path-utils'

export interface SessionActionContext {
  abortRef: MutableRefObject<AbortController | null>
  activeApprovalScopeKey: (sessionId?: string) => string
  alignWorkspacePanelToWorkspaceRoot: (root: string, sessionId?: string | null) => void
  appMountedRef: MutableRefObject<boolean>
  approvalGrantsRef: MutableRefObject<SessionApprovalGrantStore>
  beginDraftApprovalScope: () => void
  currentSession: string | undefined
  pushRoute: (route: AppRoute) => void
  refreshProjects: () => Promise<void>
  refreshRuntime: () => Promise<void>
  refreshSessions: () => Promise<SessionMeta[]>
  removeWorkspaceSessionLayout: (sessionId: string) => void
  resetWorkspaceSessionLayout: (sessionId?: string) => void
  runtime: RuntimeState | null
  sessionLoadRequestRef: MutableRefObject<number>
  historyLoadRequestRef: MutableRefObject<number>
  historyWindow: SessionHistoryWindow
  sessions: SessionMeta[]
  setContextUsageSnapshot: Dispatch<SetStateAction<ContextUsageSnapshot | null>>
  setConversationCollapsed: Dispatch<SetStateAction<boolean>>
  setControlTip: Dispatch<SetStateAction<FloatingHelpTip | null>>
  setCurrentSession: Dispatch<SetStateAction<string | undefined>>
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  setHistoryWindow: Dispatch<SetStateAction<SessionHistoryWindow>>
  setPinnedSessionIds: Dispatch<SetStateAction<Set<string>>>
  setRuntime: Dispatch<SetStateAction<RuntimeState | null>>
  setRuntimeError: Dispatch<SetStateAction<string | null>>
  setSessionOwnership: Dispatch<SetStateAction<Pick<SessionMeta, 'scope' | 'projectId'>>>
  setSessions: Dispatch<SetStateAction<SessionMeta[]>>
  setSidebarPanel: Dispatch<SetStateAction<SidebarPanel>>
  settleApprovalPrompt: (decision: ApprovalDecision) => void
  sessionOwnership: Pick<SessionMeta, 'scope' | 'projectId'>
  visibleSessions: SessionMeta[]
}

export interface SessionHistoryWindow {
  hasMore: boolean
  beforeId?: string
  loading: boolean
}

const SESSION_HISTORY_PAGE_SIZE = 120
const SESSION_HISTORY_MEMORY_MAX = 480

export function createSessionActions(context: SessionActionContext) {
  const { abortRef, activeApprovalScopeKey, alignWorkspacePanelToWorkspaceRoot, appMountedRef, approvalGrantsRef, beginDraftApprovalScope, currentSession, historyLoadRequestRef, historyWindow, pushRoute, refreshProjects, refreshRuntime, refreshSessions, removeWorkspaceSessionLayout, resetWorkspaceSessionLayout, runtime, sessionLoadRequestRef, sessions, setContextUsageSnapshot, setConversationCollapsed, setControlTip, setCurrentSession, setHistoryWindow, setMessages, setPinnedSessionIds, setRuntime, setRuntimeError, setSessionOwnership, setSessions, setSidebarPanel, settleApprovalPrompt, sessionOwnership, visibleSessions } = context

  function invalidateConversationView() {
    sessionLoadRequestRef.current += 1
    historyLoadRequestRef.current = 0
    abortRef.current?.abort()
  }

  function newSession(ownership: Pick<SessionMeta, 'scope' | 'projectId'> = { scope: 'standalone' }) {
    invalidateConversationView()
    pushRoute({ section: 'chat' })
    beginDraftApprovalScope()
    resetWorkspaceSessionLayout()
    setCurrentSession(undefined)
    setSessionOwnership(ownership)
    setMessages([])
    setHistoryWindow({ hasMore: false, beforeId: undefined, loading: false })
    setContextUsageSnapshot(null)
    settleApprovalPrompt('deny')
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


  async function switchSession(session: SessionMeta, options: { forceReload?: boolean } = {}) {
    const requestId = ++sessionLoadRequestRef.current
    historyLoadRequestRef.current = 0
    const { id, workspacePath } = session
    setSidebarPanel(null)
    pushRoute({ section: 'chat' })
    if (workspacePath && (!runtime || !isSamePath(runtime.workspace, workspacePath))) {
      try {
        const next = await updateRuntime({ workspace: workspacePath })
        if (!appMountedRef.current || requestId !== sessionLoadRequestRef.current) return
        setRuntime(next)
        setRuntimeError(null)
        void refreshProjects()
      } catch (e) {
        if (!appMountedRef.current || requestId !== sessionLoadRequestRef.current) return
        setRuntimeError((e as Error).message)
        await refreshRuntime()
        return
      }
    }
    const sessionWorkspace = workspacePath ?? runtime?.workspace
    if (sessionWorkspace) alignWorkspacePanelToWorkspaceRoot(sessionWorkspace, id)
    setSessionOwnership({ scope: session.scope, projectId: session.projectId })
    const sessionChanged = id !== currentSession
    if (!sessionChanged && !options.forceReload) return
    if (sessionChanged) {
      abortRef.current?.abort()
      setCurrentSession(id)
      setContextUsageSnapshot(null)
    }
    // Loading status belongs to the message viewport. Do not route it through
    // runtimeError: that would insert/remove a row below the shared composer
    // and make the input surface jump on every session switch.
    setMessages([])
    setHistoryWindow({ hasMore: false, beforeId: undefined, loading: true })
    try {
      const history = await getSessionMessagePage(id, { limit: SESSION_HISTORY_PAGE_SIZE })
      if (!appMountedRef.current || requestId !== sessionLoadRequestRef.current) return
      setRuntimeError(null)
      setMessages(
        history.messages.length > 0
          ? history.messages.map(historyMessageToChatMessage)
          : [],
      )
      setHistoryWindow({ hasMore: history.hasMore, beforeId: history.beforeId, loading: false })
    } catch (e) {
      if (!appMountedRef.current || requestId !== sessionLoadRequestRef.current) return
      setMessages([])
      setHistoryWindow({ hasMore: false, beforeId: undefined, loading: false })
      setRuntimeError(`加载历史失败: ${(e as Error).message}`)
    }
  }


  async function loadOlderMessages(): Promise<boolean> {
    const cursor = historyWindow.beforeId
    if (!currentSession || historyLoadRequestRef.current !== 0 || historyWindow.loading || !historyWindow.hasMore || !cursor) return false
    setHistoryWindow({ ...historyWindow, loading: true })

    const sessionRequestId = sessionLoadRequestRef.current
    const requestId = ++historyLoadRequestRef.current
    try {
      const page = await getSessionMessagePage(currentSession, {
        limit: SESSION_HISTORY_PAGE_SIZE,
        beforeId: cursor,
      })
      if (
        !appMountedRef.current
        || sessionRequestId !== sessionLoadRequestRef.current
        || requestId !== historyLoadRequestRef.current
      ) return false
      const older = page.messages.map(historyMessageToChatMessage)
      setMessages((current) => {
        const seen = new Set<string>()
        const merged = [...older, ...current].filter((message) => {
          const key = message.id ?? `${message.role}:${message.timestamp ?? ''}:${message.text}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        return merged.length > SESSION_HISTORY_MEMORY_MAX
          ? merged.slice(merged.length - SESSION_HISTORY_MEMORY_MAX)
          : merged
      })
      setHistoryWindow({ hasMore: page.hasMore, beforeId: page.beforeId, loading: false })
      return older.length > 0
    } catch (error) {
      if (
        appMountedRef.current
        && sessionRequestId === sessionLoadRequestRef.current
        && requestId === historyLoadRequestRef.current
      ) {
        setHistoryWindow((state) => ({ ...state, loading: false }))
        setRuntimeError(`加载更早对话失败: ${(error as Error).message}`)
      }
      return false
    } finally {
      if (
        sessionRequestId === sessionLoadRequestRef.current
        && historyLoadRequestRef.current === requestId
      ) {
        historyLoadRequestRef.current = 0
      }
    }
  }


  function clearSessionFromLocalState(id: string, options: { forgetWorkspace?: boolean } = {}) {
    approvalGrantsRef.current.clear(sessionApprovalScopeKey(id))
    setSessions((items) => items.filter((item) => item.id !== id))
    setPinnedSessionIds((ids) => {
      const next = new Set(ids)
      next.delete(id)
      return next
    })
    if (options.forgetWorkspace) removeWorkspaceSessionLayout(id)
    if (id === currentSession) {
      invalidateConversationView()
      beginDraftApprovalScope()
      setCurrentSession(undefined)
      setMessages([])
      setHistoryWindow({ hasMore: false, beforeId: undefined, loading: false })
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
    clearSessionFromLocalState(id, { forgetWorkspace: true })
    void refreshSessions()
  }


  async function renameSession(id: string, title: string) {
    setControlTip(null)
    try {
      const { session } = await requestSessionRename(id, title)
      if (!appMountedRef.current) return
      setSessions((items) => items.map((item) => item.id === id ? session : item))
      setRuntimeError(null)
    } catch (error) {
      if (appMountedRef.current) setRuntimeError(`重命名对话失败：${(error as Error).message}`)
      throw error
    }
  }


  function sessionsForProject(project: ProjectMeta): SessionMeta[] {
    return projectSessions(sessions, project.id)
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
      invalidateConversationView()
      beginDraftApprovalScope()
      setCurrentSession(undefined)
      setMessages([])
      setHistoryWindow({ hasMore: false, beforeId: undefined, loading: false })
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
  return { newSession, createConversationFromSidebar, openSidebarPanel, closeSidebarPanel, switchSession, loadOlderMessages, clearSessionFromLocalState, archiveSession, deleteSessionPermanently, renameSession, sessionsForProject, archiveAllSessions, togglePinnedSession }
}
