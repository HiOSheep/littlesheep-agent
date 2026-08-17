// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import { DirectModuleWorkspace } from '../settings/direct-module'
import { SidebarFeaturePanel } from '../sidebar/feature-panel'
import { ChatView } from './chat-view'
import { ComposerView } from './composer-view'
import type { CoreWorkspaceViewController } from './app-controller-projections'
import { WorkspaceDockView } from './workspace-dock-view'



export function CoreWorkspaceView({ controller }: { controller: CoreWorkspaceViewController }) {
  const {
    updateWorkspacePanelReopenPresence,
    setWorkspacePanelReopenActive,
    directModulePage,
    sidebarPanel,
    sidebarSearch,
    visibleSessions,
    currentSession,
    now,
    setSidebarSearch,
    closeSidebarPanel,
    switchSession,
    chat,
    composer,
    workspaceDock,
  } = controller
  return (
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
        <ChatView controller={chat} />
        <ComposerView controller={composer} />
      </main>

      <WorkspaceDockView controller={workspaceDock} />
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

  )
}
