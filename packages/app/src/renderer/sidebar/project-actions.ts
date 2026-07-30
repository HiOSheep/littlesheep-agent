// Project lifecycle, project-scoped conversations, and workspace path rebinding.
import '@xterm/xterm/css/xterm.css'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import {
  createProjectFolder,
  deleteProject,
  rebindProject,
  registerProject,
  selectWorkspace,
  updateRuntime,
  type ProjectMeta,
  type RuntimeState,
  type SessionMeta
} from '../api'
import { rebindNavigationSnapshotWorkspace } from '../app-shell/navigation'
import { AppNavigationSnapshot, AppRoute, SidebarPanel } from '../app-shell/types'
import { ChatMessage } from '../chat/types'
import {
  type ContextUsageSnapshot
} from '../context-usage'
import {
  type NavigationHistoryState
} from '../navigation-history'
import { FloatingHelpTip } from '../ui/floating-help'
import {
  parseWorkspaceFileTabId,
  rebindWorkspacePanelState,
  rebindWorkspacePath,
  workspaceFileTabId,
  type WorkspaceFileDraftState,
  type WorkspaceFileTabId,
  type WorkspaceOpenRequest,
  type WorkspacePanelTabId
} from '../workspace-persistence'
import { isSamePath } from '../workspace/path-utils'

type RuntimePatch = Partial<Pick<RuntimeState,
  'model' | 'reasoning' | 'profile' | 'contextCompressionThresholdRatio' | 'workspace'
>>

export interface ProjectActionContext {
  abortRef: MutableRefObject<AbortController | null>
  alignWorkspacePanelToWorkspaceRoot: (root: string) => void
  appHistoryRef: MutableRefObject<NavigationHistoryState<AppNavigationSnapshot>>
  appMountedRef: MutableRefObject<boolean>
  applyRuntimePatch: (patch: RuntimePatch) => Promise<boolean>
  beginDraftApprovalScope: () => void
  currentSession: string | undefined
  navigationRestoreTargetRef: MutableRefObject<AppNavigationSnapshot | null>
  pushRoute: (route: AppRoute) => void
  refreshProjects: () => Promise<void>
  refreshSessions: () => Promise<SessionMeta[]>
  runtime: RuntimeState | null
  sessionLoadRequestRef: MutableRefObject<number>
  sessionOwnership: Pick<SessionMeta, 'scope' | 'projectId'>
  sessions: SessionMeta[]
  sessionsForProject: (project: ProjectMeta) => SessionMeta[]
  setAppHistory: Dispatch<SetStateAction<NavigationHistoryState<AppNavigationSnapshot>>>
  setContextUsageSnapshot: Dispatch<SetStateAction<ContextUsageSnapshot | null>>
  setControlTip: Dispatch<SetStateAction<FloatingHelpTip | null>>
  setConversationCollapsed: Dispatch<SetStateAction<boolean>>
  setCurrentSession: Dispatch<SetStateAction<string | undefined>>
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  setPendingDirtyCloseTab: Dispatch<SetStateAction<WorkspaceFileTabId | null>>
  setPinnedSessionIds: Dispatch<SetStateAction<Set<string>>>
  setProjectCreatorOpen: Dispatch<SetStateAction<boolean>>
  setProjects: Dispatch<SetStateAction<ProjectMeta[]>>
  setRuntime: Dispatch<SetStateAction<RuntimeState | null>>
  setRuntimeError: Dispatch<SetStateAction<string | null>>
  setSessionOwnership: Dispatch<SetStateAction<Pick<SessionMeta, 'scope' | 'projectId'>>>
  setSessions: Dispatch<SetStateAction<SessionMeta[]>>
  setSidebarPanel: Dispatch<SetStateAction<SidebarPanel>>
  setWorkspaceExpandedPaths: Dispatch<SetStateAction<string[]>>
  setWorkspaceFileDrafts: Dispatch<SetStateAction<Record<string, WorkspaceFileDraftState>>>
  setWorkspaceOpenRequest: Dispatch<SetStateAction<WorkspaceOpenRequest | null>>
  setWorkspacePanelOpenTabs: Dispatch<SetStateAction<WorkspacePanelTabId[]>>
  setWorkspacePanelTab: Dispatch<SetStateAction<WorkspacePanelTabId>>
  workspaceFileDrafts: Record<string, WorkspaceFileDraftState>
  workspaceOpenRequest: WorkspaceOpenRequest | null
  workspacePanelOpenTabs: WorkspacePanelTabId[]
  workspacePanelTab: WorkspacePanelTabId
}

export function createProjectActions(context: ProjectActionContext) {
  const { abortRef, alignWorkspacePanelToWorkspaceRoot, appHistoryRef, appMountedRef, applyRuntimePatch, beginDraftApprovalScope, currentSession, navigationRestoreTargetRef, pushRoute, refreshProjects, refreshSessions, runtime, sessionLoadRequestRef, sessionOwnership, sessions, sessionsForProject, setAppHistory, setContextUsageSnapshot, setControlTip, setConversationCollapsed, setCurrentSession, setMessages, setPendingDirtyCloseTab, setPinnedSessionIds, setProjectCreatorOpen, setProjects, setRuntime, setRuntimeError, setSessionOwnership, setSessions, setSidebarPanel, setWorkspaceExpandedPaths, setWorkspaceFileDrafts, setWorkspaceOpenRequest, setWorkspacePanelOpenTabs, setWorkspacePanelTab, workspaceFileDrafts, workspaceOpenRequest, workspacePanelOpenTabs, workspacePanelTab } = context


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
  return { openProjectCreator, activateProjectWorkspace, chooseProjectFolder, createProjectInFolder, relocateProject, resetWorkspace, resetWorkspaceAfterProjectRemoval, archiveProject, deleteProjectPermanently }
}
