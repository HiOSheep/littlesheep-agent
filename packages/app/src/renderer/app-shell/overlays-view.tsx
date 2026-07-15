// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import {
  selectWorkspace
} from '../api'
import { ApprovalPrompt, DirtyFileClosePrompt } from '../approval/prompt'
import { SettingsWorkspace } from '../settings/workspace'
import { SettingsEntryBridge } from '../sidebar/global-titlebar'
import { ProjectCreatorDialog } from '../sidebar/project-creator'
import { FloatingHelpTooltip } from '../ui/floating-help'
import { FadePresence } from '../ui/presence'
import {
  parseWorkspaceFileTabId
} from '../workspace-persistence'
import type { AppController } from './use-app-controller'



export function OverlaysView({ controller }: { controller: AppController }) {
  const { sessions, projects, currentSession, sessionOwnership, messages, setMessages, input, setInput, loading, permissionMode, setPermissionMode, runtime, attachments, setAttachments, dragActive, runtimeError, sidebarCollapsed, workspacePanelCollapsed, workspacePanelReopenActive, setWorkspacePanelReopenActive, workspacePanelFullscreen, workspacePanelTab, workspacePanelOpenTabs, workspaceOpenRequest, setWorkspaceOpenRequest, workspaceFileDrafts, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed, workspaceExpandedPaths, setWorkspaceExpandedPaths, pendingDirtyCloseTab, setPendingDirtyCloseTab, conversationCollapsed, setConversationCollapsed, now, pinnedSessionIds, sidebarPanel, sidebarSearch, setSidebarSearch, projectCreatorOpen, setProjectCreatorOpen, scrollRef, inputRef, shellRef, activityNow, workspaceArtifactVersion, setWorkspaceArtifactVersion, controlTip, setControlTip, pendingApproval, settingsEntryRippling, sidebarWidth, setSidebarWidth, setWorkspacePanelWidth, workspacePanelLayout, layoutStyle, settingsOpen, directModulePage, settingsPage, canNavigateBack, canNavigateForward, openSettingsFromEntry, openSettingsPage, openDirectModulePage, navigateBack, navigateForward, closeSettingsFromEntry, selectableProviders, selectedModel, displayedSessions, visibleSessions, visibleSessionMotionRef, workspaceIsWorkplace, workspaceTip, projectPath, contextUsage, latestTaskActivity, sidebarToggleTip, moreConversationTip, newConversationTip, uploadTip, sendTip, requestWorkspaceSaveApproval, requestWorkspaceCommandApproval, settleApprovalPrompt, refreshSessions, refreshProjects, applyRuntimePatch, addAttachments, chooseWorkspace, openProjectCreator, activateProjectWorkspace, chooseProjectFolder, createProjectInFolder, relocateProject, resetWorkspace, openFileInWorkspace, handleComposerDragEnter, handleComposerDragOver, handleComposerDragLeave, handleComposerDrop, handleComposerPaste, send, stop, createConversationFromSidebar, openSidebarPanel, closeSidebarPanel, switchSession, archiveSession, deleteSessionPermanently, archiveProject, deleteProjectPermanently, archiveAllSessions, togglePinnedSession, beginSidebarResize, nudgeSidebar, toggleSidebar, beginWorkspacePanelResize, toggleWorkspacePanel, updateWorkspacePanelReopenPresence, toggleWorkspacePanelFullscreen, nudgeWorkspacePanel, openWorkspacePanelTab, updateWorkspaceFileDraft, closeWorkspacePanelTab, defaultWorkspacePath, workspacePanelRoot, workspacePanelUsingTemporaryRoot } = controller
  return (
<>
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

      </>
  )
}
