// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import { LinkNavigationProvider } from '../link-navigation'
import { GlobalTitlebar } from '../sidebar/global-titlebar'
import { CoreWorkspaceView } from './core-workspace-view'
import { OverlaysView } from './overlays-view'
import { SidebarView } from './sidebar-view'
import type { AppController } from './use-app-controller'

export function AppView({ controller }: { controller: AppController }) {
  const { sessions, projects, currentSession, sessionOwnership, messages, setMessages, input, setInput, loading, permissionMode, setPermissionMode, runtime, attachments, setAttachments, dragActive, runtimeError, sidebarCollapsed, workspacePanelCollapsed, workspacePanelReopenActive, setWorkspacePanelReopenActive, workspacePanelFullscreen, workspacePanelTab, workspacePanelOpenTabs, workspaceOpenRequest, setWorkspaceOpenRequest, workspaceFileDrafts, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed, workspaceExpandedPaths, setWorkspaceExpandedPaths, pendingDirtyCloseTab, setPendingDirtyCloseTab, conversationCollapsed, setConversationCollapsed, now, pinnedSessionIds, sidebarPanel, sidebarSearch, setSidebarSearch, projectCreatorOpen, setProjectCreatorOpen, scrollRef, inputRef, shellRef, activityNow, workspaceArtifactVersion, setWorkspaceArtifactVersion, controlTip, setControlTip, pendingApproval, settingsEntryRippling, sidebarWidth, setSidebarWidth, setWorkspacePanelWidth, workspacePanelLayout, layoutStyle, settingsOpen, directModulePage, settingsPage, canNavigateBack, canNavigateForward, openSettingsFromEntry, openSettingsPage, openDirectModulePage, navigateBack, navigateForward, closeSettingsFromEntry, selectableProviders, selectedModel, displayedSessions, visibleSessions, visibleSessionMotionRef, workspaceIsWorkplace, workspaceTip, projectPath, contextUsage, latestTaskActivity, sidebarToggleTip, moreConversationTip, newConversationTip, uploadTip, sendTip, requestWorkspaceSaveApproval, requestWorkspaceCommandApproval, settleApprovalPrompt, refreshSessions, refreshProjects, applyRuntimePatch, addAttachments, chooseWorkspace, openProjectCreator, activateProjectWorkspace, chooseProjectFolder, createProjectInFolder, relocateProject, resetWorkspace, openFileInWorkspace, handleComposerDragEnter, handleComposerDragOver, handleComposerDragLeave, handleComposerDrop, handleComposerPaste, send, stop, createConversationFromSidebar, openSidebarPanel, closeSidebarPanel, switchSession, archiveSession, deleteSessionPermanently, archiveProject, deleteProjectPermanently, archiveAllSessions, togglePinnedSession, beginSidebarResize, nudgeSidebar, toggleSidebar, beginWorkspacePanelResize, toggleWorkspacePanel, updateWorkspacePanelReopenPresence, toggleWorkspacePanelFullscreen, nudgeWorkspacePanel, openWorkspacePanelTab, updateWorkspaceFileDraft, closeWorkspacePanelTab, defaultWorkspacePath, workspacePanelRoot, workspacePanelUsingTemporaryRoot } = controller
  return (
    <LinkNavigationProvider value={{
      openInside: controller.openHyperlinkInside,
      openWithSystem: controller.openHyperlinkWithSystem,
    }}>
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
            <SidebarView controller={controller} />
            <CoreWorkspaceView controller={controller} />
          </div>
        </div>
        <OverlaysView controller={controller} />
      </div>
    </LinkNavigationProvider>
  )
}
