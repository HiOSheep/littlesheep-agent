// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import { SidebarActionMenu } from '../sidebar/action-menu'
import { SessionRow } from '../sidebar/session-row'
import { buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { ArchiveIcon, ComposeIcon, MoreIcon } from '../ui/icons'
import type { AppController } from './use-app-controller'




export function ConversationSectionView({ controller }: { controller: AppController }) {
  const { sessions, projects, currentSession, sessionOwnership, messages, setMessages, input, setInput, loading, permissionMode, setPermissionMode, runtime, attachments, setAttachments, dragActive, runtimeError, sidebarCollapsed, workspacePanelCollapsed, workspacePanelReopenActive, setWorkspacePanelReopenActive, workspacePanelFullscreen, workspacePanelTab, workspacePanelOpenTabs, workspaceOpenRequest, setWorkspaceOpenRequest, workspaceFileDrafts, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed, workspaceExpandedPaths, setWorkspaceExpandedPaths, pendingDirtyCloseTab, setPendingDirtyCloseTab, conversationCollapsed, setConversationCollapsed, now, pinnedSessionIds, sidebarPanel, sidebarSearch, setSidebarSearch, projectCreatorOpen, setProjectCreatorOpen, scrollRef, inputRef, shellRef, activityNow, workspaceArtifactVersion, setWorkspaceArtifactVersion, controlTip, setControlTip, pendingApproval, settingsEntryRippling, sidebarWidth, setSidebarWidth, setWorkspacePanelWidth, workspacePanelLayout, layoutStyle, settingsOpen, directModulePage, settingsPage, canNavigateBack, canNavigateForward, openSettingsFromEntry, openSettingsPage, openDirectModulePage, navigateBack, navigateForward, closeSettingsFromEntry, selectableProviders, selectedModel, displayedSessions, visibleSessions, visibleSessionMotionRef, workspaceIsWorkplace, workspaceTip, projectPath, contextUsage, latestTaskActivity, sidebarToggleTip, moreConversationTip, newConversationTip, uploadTip, sendTip, requestWorkspaceSaveApproval, requestWorkspaceCommandApproval, settleApprovalPrompt, refreshSessions, refreshProjects, applyRuntimePatch, addAttachments, chooseWorkspace, openProjectCreator, activateProjectWorkspace, chooseProjectFolder, createProjectInFolder, relocateProject, resetWorkspace, openFileInWorkspace, handleComposerDragEnter, handleComposerDragOver, handleComposerDragLeave, handleComposerDrop, handleComposerPaste, send, stop, createConversationFromSidebar, openSidebarPanel, closeSidebarPanel, switchSession, renameSession, archiveSession, deleteSessionPermanently, archiveProject, deleteProjectPermanently, archiveAllSessions, togglePinnedSession, beginSidebarResize, nudgeSidebar, toggleSidebar, beginWorkspacePanelResize, toggleWorkspacePanel, updateWorkspacePanelReopenPresence, toggleWorkspacePanelFullscreen, nudgeWorkspacePanel, openWorkspacePanelTab, updateWorkspaceFileDraft, closeWorkspacePanelTab, defaultWorkspacePath, workspacePanelRoot, workspacePanelUsingTemporaryRoot } = controller
  return (
        <section
          className={`sidebar-section conversation-section ${conversationCollapsed ? 'collapsed' : ''}`}
          aria-label="对话"
        >
          <div className="sidebar-section-header">
            <button
              className="sidebar-section-toggle"
              type="button"
              aria-expanded={!conversationCollapsed}
              onClick={() => setConversationCollapsed((value) => !value)}
            >
              <span>对话</span>
              <span className="sidebar-section-arrow" aria-hidden="true" />
            </button>
            <div className="sidebar-section-actions" aria-hidden={conversationCollapsed ? undefined : false}>
              <SidebarActionMenu
                label={moreConversationTip}
                onTipChange={setControlTip}
                items={[
                  {
                    label: '归档所有对话',
                    icon: <ArchiveIcon />,
                    onSelect: archiveAllSessions,
                  },
                ]}
              >
                <MoreIcon />
              </SidebarActionMenu>
              <button
                className="sidebar-section-action sidebar-new-action"
                type="button"
                aria-label={newConversationTip}
                onClick={createConversationFromSidebar}
                onMouseEnter={(event) => setControlTip(buildFloatingHelpTip(newConversationTip, event.clientX, event.clientY))}
                onMouseMove={(event) => setControlTip(buildFloatingHelpTip(newConversationTip, event.clientX, event.clientY))}
                onMouseLeave={() => setControlTip(null)}
                onFocus={(event) => setControlTip(buildFloatingHelpTipFromElement(newConversationTip, event.currentTarget))}
                onBlur={() => setControlTip(null)}
              >
                <ComposeIcon />
              </button>
            </div>
          </div>
          <div
            className="session-list"
            aria-hidden={conversationCollapsed}
            {...(conversationCollapsed ? { inert: '' } : {})}
          >
            {visibleSessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === currentSession}
                pinned={pinnedSessionIds.has(s.id)}
                now={now}
                itemRef={visibleSessionMotionRef(s.id)}
                onOpen={() => void switchSession(s)}
                onTogglePin={() => togglePinnedSession(s.id)}
                onRename={(title) => renameSession(s.id, title)}
                onArchive={() => archiveSession(s.id)}
                onDelete={() => deleteSessionPermanently(s.id)}
                onTipChange={setControlTip}
              />
            ))}
          </div>
        </section>

  )
}
