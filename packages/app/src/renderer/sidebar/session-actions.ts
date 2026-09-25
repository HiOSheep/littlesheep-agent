// Session lifecycle, sidebar conversation actions, and session-scoped approval cleanup.
import '@xterm/xterm/css/xterm.css'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { projectSessions } from '../../shared/session-scope'
import {
  deleteSession,
  getSessionMessagePage,
  renameSession as requestSessionRename,
  type SessionMessagePage,
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
import { waitForExecutionReady } from '../runtime-readiness/runtime-readiness-state'
import { projectCompactionOperations } from '../chat/context-projections'
import { ChatMessage } from '../chat/types'
import type { CompactionOperationRecord } from '../../shared/compaction-operation-contracts'
import {
  buildContextUsageSnapshotFromSession,
  type ContextUsageSnapshot
} from '../context-usage'
import { FloatingHelpTip } from '../ui/floating-help'

export interface CachedSessionHistory {
  lastMessageAt: number
  page: Promise<SessionMessagePage>
}

class SessionExecutionFailedError extends Error {}

/**
 * Annotate the newest assistant activity with the session's real compaction
 * operation so the existing context-projection rows show it in history.
 */
export function attachCompactionNotice(
  messages: ChatMessage[],
  operations: readonly CompactionOperationRecord[] | undefined,
): ChatMessage[] {
  const rows = projectCompactionOperations(operations)
  if (rows.length === 0) return messages
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant' || !message.activity) continue
    const activity = message.activity
    return messages.map((candidate, position) => (position === index
      ? Object.assign({}, candidate, {
        activity: Object.assign({}, activity, {
          contextProjections: [...(activity.contextProjections ?? []), ...rows],
        }),
      }) as ChatMessage
      : candidate))
  }
  return messages
}

export interface SessionActionContext {
  abortRef: MutableRefObject<AbortController | null>
  alignWorkspacePanelToWorkspaceRoot: (root: string, sessionId?: string | null) => void
  appMountedRef: MutableRefObject<boolean>
  approvalGrantsRef: MutableRefObject<SessionApprovalGrantStore>
  beginDraftApprovalScope: () => void
  currentSession: string | undefined
  pushRoute: (route: AppRoute) => void
  refreshSessions: () => Promise<SessionMeta[]>
  removeWorkspaceSessionLayout: (sessionId: string) => void
  resetWorkspaceSessionLayout: (sessionId?: string) => void
  runtime: RuntimeState | null
  sessionLoadRequestRef: MutableRefObject<number>
  historyLoadRequestRef: MutableRefObject<number>
  sessionHistoryCacheRef: MutableRefObject<Map<string, CachedSessionHistory>>
  selectedSessionWorkspaceRef: MutableRefObject<string | undefined>
  defaultWorkspaceRef: MutableRefObject<string | undefined>
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
  resetDraftPermissionMode: () => void
  forgetSessionPermissionMode: (sessionId: string) => void
  settleApprovalPrompt: (decision: ApprovalDecision) => void
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
  const {
    abortRef, appMountedRef, approvalGrantsRef, historyLoadRequestRef, sessionLoadRequestRef,
    sessionHistoryCacheRef, selectedSessionWorkspaceRef, defaultWorkspaceRef,
    alignWorkspacePanelToWorkspaceRoot, pushRoute, removeWorkspaceSessionLayout,
    resetWorkspaceSessionLayout,
    beginDraftApprovalScope, refreshSessions, settleApprovalPrompt,
    currentSession, historyWindow, runtime, sessions, visibleSessions,
    setContextUsageSnapshot, setConversationCollapsed, setControlTip, setCurrentSession,
    setHistoryWindow, setMessages, setPinnedSessionIds, setRuntime, setRuntimeError,
    setSessionOwnership, setSessions, setSidebarPanel, resetDraftPermissionMode,
    forgetSessionPermissionMode,
  } = context

  function invalidateConversationView() {
    sessionLoadRequestRef.current += 1
    historyLoadRequestRef.current = 0
    abortRef.current?.abort()
  }

  function newSession(ownership: Pick<SessionMeta, 'scope' | 'projectId'> = { scope: 'standalone' }) {
    invalidateConversationView()
    selectedSessionWorkspaceRef.current = undefined
    setRuntime((current) => current && defaultWorkspaceRef.current
      ? { ...current, workspace: defaultWorkspaceRef.current }
      : current)
    pushRoute({ section: 'chat' })
    beginDraftApprovalScope()
    resetDraftPermissionMode()
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


  function createProjectConversationFromSidebar(projectId: string) {
    setSidebarPanel(null)
    setConversationCollapsed(false)
    newSession({ scope: 'project', projectId })
  }


  function openSidebarPanel(panel: NonNullable<SidebarPanel>) {
    setControlTip(null)
    setSidebarPanel((current) => (current === panel ? null : panel))
  }


  function closeSidebarPanel() {
    setSidebarPanel(null)
  }


  async function switchSession(session: SessionMeta, options: { forceReload?: boolean; preserveRoute?: boolean } = {}) {
    const requestId = ++sessionLoadRequestRef.current
    historyLoadRequestRef.current = 0
    const { id, workspacePath } = session
    setSidebarPanel(null)
    if (!options.preserveRoute) pushRoute({ section: 'chat' })
    // Session selection changes the effective workspace for this view and its
    // run request. It must not persist a new global default or rebuild Runner.
    selectedSessionWorkspaceRef.current = workspacePath
    const sessionWorkspace = workspacePath ?? defaultWorkspaceRef.current ?? runtime?.workspace
    if (sessionWorkspace) setRuntime((current) => current ? { ...current, workspace: sessionWorkspace } : current)
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
    // Only a selected session starts its history request. The promise belongs
    // to that session, so switching away does not cancel its load; switching
    // back can reuse either an in-flight or a completed first page.
    const cache = sessionHistoryCacheRef.current
    const cached = cache.get(id)
    const page = !options.forceReload && cached?.lastMessageAt === session.lastMessageAt
      ? cached.page
      : (async () => {
        const readiness = await waitForExecutionReady()
        if (readiness?.state === 'failed') throw new SessionExecutionFailedError()
        return getSessionMessagePage(id, { limit: SESSION_HISTORY_PAGE_SIZE })
      })()
    if (page !== cached?.page) {
      cache.delete(id)
      cache.set(id, { lastMessageAt: session.lastMessageAt, page })
      if (cache.size > 6) cache.delete(cache.keys().next().value!)
    }
    try {
      const history = await page.catch((error) => {
        if (cache.get(id)?.page === page) cache.delete(id)
        throw error
      })
      if (!appMountedRef.current || requestId !== sessionLoadRequestRef.current) return
      setRuntimeError(null)
      setMessages(attachCompactionNotice(
        history.messages.map(historyMessageToChatMessage),
        history.compactionOperations,
      ))
      // A force reload can follow checkpoint recovery, which has already
      // installed the completed run's live snapshot. Preserve it when the
      // history payload has no newer durable counter to restore.
      if (history.contextUsage) {
        setContextUsageSnapshot(buildContextUsageSnapshotFromSession(history.contextUsage))
      }
      setHistoryWindow({ hasMore: history.hasMore, beforeId: history.beforeId, loading: false })
    } catch (e) {
      if (!appMountedRef.current || requestId !== sessionLoadRequestRef.current) return
      setMessages([])
      setHistoryWindow({ hasMore: false, beforeId: undefined, loading: false })
      setRuntimeError(e instanceof SessionExecutionFailedError
        ? '执行能力启动失败，这段对话暂时无法加载。'
        : `加载历史失败: ${(e as Error).message}`)
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
    sessionHistoryCacheRef.current.delete(id)
    approvalGrantsRef.current.clear(sessionApprovalScopeKey(id))
    forgetSessionPermissionMode(id)
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
      resetDraftPermissionMode()
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
      resetDraftPermissionMode()
      setCurrentSession(undefined)
      setMessages([])
      setHistoryWindow({ hasMore: false, beforeId: undefined, loading: false })
      setContextUsageSnapshot(null)
    }
    for (const id of ids) forgetSessionPermissionMode(id)
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
  return { createConversationFromSidebar, createProjectConversationFromSidebar, openSidebarPanel, closeSidebarPanel, switchSession, loadOlderMessages, archiveSession, deleteSessionPermanently, renameSession, sessionsForProject, archiveAllSessions, togglePinnedSession }
}
