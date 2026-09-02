// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import { SidebarProjectSection } from '../sidebar/project-section'
import { SidebarQuickNav } from '../sidebar/quick-nav'
import { ConversationSectionView } from './conversation-section-view'
import { SidebarResizerView } from './sidebar-resizer-view'
import type { SidebarViewController } from './app-controller-projections'



export function SidebarView({ controller }: { controller: SidebarViewController }) {
  const {
    sidebarCollapsed,
    sidebarPanel,
    directModulePage,
    createConversationFromSidebar,
    createProjectConversationFromSidebar,
    openSidebarPanel,
    openDirectModulePage,
    setControlTip,
    projects,
    displayedSessions,
    currentSession,
    pinnedSessionIds,
    now,
    sessionOwnership,
    projectPath,
    activateProjectWorkspace,
    openProjectCreator,
    switchSession,
    togglePinnedSession,
    reorderSidebarSessions,
    renameSession,
    archiveSession,
    deleteSessionPermanently,
    archiveProject,
    relocateProject,
    deleteProjectPermanently,
    conversation,
    resizer,
  } = controller
  return (
    <>
      <aside className="sidebar" aria-hidden={sidebarCollapsed} {...(sidebarCollapsed ? { inert: '' } : {})}>
        <div className="sidebar-surface">
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
          onCreateProjectConversation={(project) => {
            if (sessionOwnership.scope === 'project' && sessionOwnership.projectId === project.id) {
              createProjectConversationFromSidebar(project.id)
            } else {
              void activateProjectWorkspace(project)
            }
          }}
          onOpenWorkspace={openProjectCreator}
          onOpenSession={(session) => void switchSession(session)}
          onTogglePin={togglePinnedSession}
          onReorderSessions={reorderSidebarSessions}
          onRenameSession={renameSession}
          onArchiveSession={archiveSession}
          onDeleteSession={deleteSessionPermanently}
          onArchiveProject={(project) => void archiveProject(project)}
          onRebindProject={(project) => void relocateProject(project)}
          onDeleteProject={(project) => void deleteProjectPermanently(project)}
          onTipChange={setControlTip}
        />
      <ConversationSectionView controller={conversation} />
          </div>
        </div>
      </aside>
      <SidebarResizerView controller={resizer} />
    </>
  )
}
