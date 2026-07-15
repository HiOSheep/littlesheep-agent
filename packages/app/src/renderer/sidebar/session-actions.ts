// Session lifecycle, sidebar conversation actions, and session-scoped approval cleanup.
import '@xterm/xterm/css/xterm.css'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { projectSessions } from '../../shared/session-scope'
import {
  deleteSession,
  getSessionMessages,
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
  alignWorkspacePanelToWorkspaceRoot: (root: string) => void
  appMountedRef: MutableRefObject<boolean>
  approvalGrantsRef: MutableRefObject<SessionApprovalGrantStore>
  beginDraftApprovalScope: () => void
  currentSession: string | undefined
  pushRoute: (route: AppRoute) => void
  refreshProjects: () => Promise<void>
  refreshRuntime: () => Promise<void>
  refreshSessions: () => Promise<void>
  runtime: RuntimeState | null
  sessionLoadRequestRef: MutableRefObject<number>
  sessions: SessionMeta[]
  setContextUsageSnapshot: Dispatch<SetStateAction<ContextUsageSnapshot | null>>
  setConversationCollapsed: Dispatch<SetStateAction<boolean>>
  setControlTip: Dispatch<SetStateAction<FloatingHelpTip | null>>
  setCurrentSession: Dispatch<SetStateAction<string | undefined>>
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
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

export function createSessionActions(context: SessionActionContext) {
  const { abortRef, activeApprovalScopeKey, alignWorkspacePanelToWorkspaceRoot, appMountedRef, approvalGrantsRef, beginDraftApprovalScope, currentSession, pushRoute, refreshProjects, refreshRuntime, refreshSessions, runtime, sessionLoadRequestRef, sessions, setContextUsageSnapshot, setConversationCollapsed, setControlTip, setCurrentSession, setMessages, setPinnedSessionIds, setRuntime, setRuntimeError, setSessionOwnership, setSessions, setSidebarPanel, settleApprovalPrompt, sessionOwnership, visibleSessions } = context


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
  return { newSession, createConversationFromSidebar, openSidebarPanel, closeSidebarPanel, switchSession, clearSessionFromLocalState, archiveSession, deleteSessionPermanently, sessionsForProject, archiveAllSessions, togglePinnedSession }
}
