// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import { SidebarProjectSection } from '../sidebar/project-section'
import { SidebarQuickNav } from '../sidebar/quick-nav'
import { SettingsGearIcon } from '../ui/icons'
import { ConversationSectionView } from './conversation-section-view'
import { SidebarResizerView } from './sidebar-resizer-view'
import type { AppController } from './use-app-controller'



export function SidebarView({ controller }: { controller: AppController }) {
  const { sessions, projects, currentSession, sessionOwnership, messages, setMessages, input, setInput, loading, permissionMode, setPermissionMode, runtime, attachments, setAttachments, dragActive, runtimeError, sidebarCollapsed, workspacePanelCollapsed, workspacePanelReopenActive, setWorkspacePanelReopenActive, workspacePanelFullscreen, workspacePanelTab, workspacePanelOpenTabs, workspaceOpenRequest, setWorkspaceOpenRequest, workspaceFileDrafts, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed, workspaceExpandedPaths, setWorkspaceExpandedPaths, pendingDirtyCloseTab, setPendingDirtyCloseTab, conversationCollapsed, setConversationCollapsed, now, pinnedSessionIds, sidebarPanel, sidebarSearch, setSidebarSearch, projectCreatorOpen, setProjectCreatorOpen, scrollRef, inputRef, shellRef, activityNow, workspaceArtifactVersion, setWorkspaceArtifactVersion, controlTip, setControlTip, pendingApproval, settingsEntryRippling, sidebarWidth, setSidebarWidth, setWorkspacePanelWidth, workspacePanelLayout, layoutStyle, settingsOpen, directModulePage, settingsPage, canNavigateBack, canNavigateForward, openSettingsFromEntry, openSettingsPage, openDirectModulePage, navigateBack, navigateForward, closeSettingsFromEntry, selectableProviders, selectedModel, displayedSessions, visibleSessions, visibleSessionMotionRef, workspaceIsWorkplace, workspaceTip, projectPath, contextUsage, latestTaskActivity, sidebarToggleTip, moreConversationTip, newConversationTip, uploadTip, sendTip, requestWorkspaceSaveApproval, requestWorkspaceCommandApproval, settleApprovalPrompt, refreshSessions, refreshProjects, applyRuntimePatch, addAttachments, chooseWorkspace, openProjectCreator, activateProjectWorkspace, chooseProjectFolder, createProjectInFolder, relocateProject, resetWorkspace, openFileInWorkspace, handleComposerDragEnter, handleComposerDragOver, handleComposerDragLeave, handleComposerDrop, handleComposerPaste, send, stop, createConversationFromSidebar, openSidebarPanel, closeSidebarPanel, switchSession, renameSession, archiveSession, deleteSessionPermanently, archiveProject, deleteProjectPermanently, archiveAllSessions, togglePinnedSession, beginSidebarResize, nudgeSidebar, toggleSidebar, beginWorkspacePanelResize, toggleWorkspacePanel, updateWorkspacePanelReopenPresence, toggleWorkspacePanelFullscreen, nudgeWorkspacePanel, openWorkspacePanelTab, updateWorkspaceFileDraft, closeWorkspacePanelTab, defaultWorkspacePath, workspacePanelRoot, workspacePanelUsingTemporaryRoot } = controller
  return (
    <>
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
          onRenameSession={renameSession}
          onArchiveSession={archiveSession}
          onDeleteSession={deleteSessionPermanently}
          onArchiveProject={(project) => void archiveProject(project)}
          onRebindProject={(project) => void relocateProject(project)}
          onDeleteProject={(project) => void deleteProjectPermanently(project)}
          onTipChange={setControlTip}
        />
      <ConversationSectionView controller={controller} />
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
      <SidebarResizerView controller={controller} />
    </>
  )
}
