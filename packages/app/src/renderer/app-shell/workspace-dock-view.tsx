// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import {
MAX_NAVIGATION_EXPANDED_PATHS,
boundStringList
} from '../navigation-history'
import { WorkspacePanelIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import {
WORKSPACE_PANEL_WIDTH_MIN
} from '../workspace-layout'
import { WorkspacePanel } from '../workspace/panel'
import type { AppController } from './use-app-controller'




export function WorkspaceDockView({ controller }: { controller: AppController }) {
  const { sessions, projects, currentSession, sessionOwnership, messages, setMessages, input, setInput, loading, permissionMode, setPermissionMode, runtime, attachments, setAttachments, dragActive, runtimeError, sidebarCollapsed, workspacePanelCollapsed, workspacePanelReopenActive, setWorkspacePanelReopenActive, workspacePanelFullscreen, workspacePanelTab, workspacePanelOpenTabs, workspaceOpenRequest, setWorkspaceOpenRequest, workspaceFileDrafts, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed, workspaceExpandedPaths, setWorkspaceExpandedPaths, pendingDirtyCloseTab, setPendingDirtyCloseTab, conversationCollapsed, setConversationCollapsed, now, pinnedSessionIds, sidebarPanel, sidebarSearch, setSidebarSearch, projectCreatorOpen, setProjectCreatorOpen, scrollRef, inputRef, shellRef, activityNow, workspaceArtifactVersion, setWorkspaceArtifactVersion, controlTip, setControlTip, pendingApproval, settingsEntryRippling, sidebarWidth, setSidebarWidth, setWorkspacePanelWidth, workspacePanelLayout, layoutStyle, settingsOpen, directModulePage, settingsPage, canNavigateBack, canNavigateForward, openSettingsFromEntry, openSettingsPage, openDirectModulePage, navigateBack, navigateForward, closeSettingsFromEntry, selectableProviders, selectedModel, displayedSessions, visibleSessions, visibleSessionMotionRef, workspaceIsWorkplace, workspaceTip, projectPath, contextUsage, latestTaskActivity, sidebarToggleTip, moreConversationTip, newConversationTip, uploadTip, sendTip, requestWorkspaceSaveApproval, requestWorkspaceCommandApproval, settleApprovalPrompt, refreshSessions, refreshProjects, applyRuntimePatch, addAttachments, chooseWorkspace, openProjectCreator, activateProjectWorkspace, chooseProjectFolder, createProjectInFolder, relocateProject, resetWorkspace, openFileInWorkspace, handleComposerDragEnter, handleComposerDragOver, handleComposerDragLeave, handleComposerDrop, handleComposerPaste, send, stop, createConversationFromSidebar, openSidebarPanel, closeSidebarPanel, switchSession, archiveSession, deleteSessionPermanently, archiveProject, deleteProjectPermanently, archiveAllSessions, togglePinnedSession, beginSidebarResize, nudgeSidebar, toggleSidebar, beginWorkspacePanelResize, toggleWorkspacePanel, updateWorkspacePanelReopenPresence, toggleWorkspacePanelFullscreen, nudgeWorkspacePanel, openWorkspacePanelTab, updateWorkspaceFileDraft, closeWorkspacePanelTab, defaultWorkspacePath, workspacePanelRoot, workspacePanelUsingTemporaryRoot } = controller
  return (
<>
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
  )
}
