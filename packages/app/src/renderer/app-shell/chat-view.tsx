// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import {
  coerceReasoningForModelRef
} from '../../shared/model-capabilities'
import { AssistantTurnMessage } from '../chat/assistant-turn'
import { TaskProgressPresence } from '../chat/task-progress-indicator'
import { AddMenu } from '../composer/add-menu'
import { ContextUsageIndicator } from '../composer/context-usage-indicator'
import { AttachmentPreviewCard, MessageFileStrip } from '../composer/message-files'
import { ModePicker } from '../composer/mode-picker'
import { RuntimePicker } from '../composer/runtime-picker'
import { WorkspaceChip } from '../composer/workspace-chip'
import { Markdown } from '../Markdown'
import { TraceCard } from '../TraceCard'
import { buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { SendRunIcon, StopRunIcon } from '../ui/icons'
import { attachmentToArtifact } from '../workspace/path-utils'
import type { AppController } from './use-app-controller'




export function ChatView({ controller }: { controller: AppController }) {
  const { sessions, projects, currentSession, sessionOwnership, messages, setMessages, input, setInput, loading, permissionMode, setPermissionMode, runtime, attachments, setAttachments, dragActive, runtimeError, sidebarCollapsed, workspacePanelCollapsed, workspacePanelReopenActive, setWorkspacePanelReopenActive, workspacePanelFullscreen, workspacePanelTab, workspacePanelOpenTabs, workspaceOpenRequest, setWorkspaceOpenRequest, workspaceFileDrafts, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed, workspaceExpandedPaths, setWorkspaceExpandedPaths, pendingDirtyCloseTab, setPendingDirtyCloseTab, conversationCollapsed, setConversationCollapsed, now, pinnedSessionIds, sidebarPanel, sidebarSearch, setSidebarSearch, projectCreatorOpen, setProjectCreatorOpen, scrollRef, inputRef, shellRef, activityNow, workspaceArtifactVersion, setWorkspaceArtifactVersion, controlTip, setControlTip, pendingApproval, settingsEntryRippling, sidebarWidth, setSidebarWidth, setWorkspacePanelWidth, workspacePanelLayout, layoutStyle, settingsOpen, directModulePage, settingsPage, canNavigateBack, canNavigateForward, openSettingsFromEntry, openSettingsPage, openDirectModulePage, navigateBack, navigateForward, closeSettingsFromEntry, selectableProviders, selectedModel, displayedSessions, visibleSessions, visibleSessionMotionRef, workspaceIsWorkplace, workspaceTip, projectPath, contextUsage, latestTaskActivity, sidebarToggleTip, moreConversationTip, newConversationTip, uploadTip, sendTip, requestWorkspaceSaveApproval, requestWorkspaceCommandApproval, settleApprovalPrompt, refreshSessions, refreshProjects, applyRuntimePatch, addAttachments, chooseWorkspace, openProjectCreator, activateProjectWorkspace, chooseProjectFolder, createProjectInFolder, relocateProject, resetWorkspace, openFileInWorkspace, handleComposerDragEnter, handleComposerDragOver, handleComposerDragLeave, handleComposerDrop, handleComposerPaste, send, stop, createConversationFromSidebar, openSidebarPanel, closeSidebarPanel, switchSession, archiveSession, deleteSessionPermanently, archiveProject, deleteProjectPermanently, archiveAllSessions, togglePinnedSession, beginSidebarResize, nudgeSidebar, toggleSidebar, beginWorkspacePanelResize, toggleWorkspacePanel, updateWorkspacePanelReopenPresence, toggleWorkspacePanelFullscreen, nudgeWorkspacePanel, openWorkspacePanelTab, updateWorkspaceFileDraft, closeWorkspacePanelTab, defaultWorkspacePath, workspacePanelRoot, workspacePanelUsingTemporaryRoot } = controller
  return (
      <main className="chat">
        <div className={`messages ${messages.length === 0 ? 'is-empty' : ''}`} ref={scrollRef}>
          {messages.length === 0 && (
            <div className="empty-hint">
              <div className="empty-title">今天要推进什么？</div>
              <div className="empty-copy">选择模型、推理强度和工作目录后，直接交给 LittleSheep。</div>
            </div>
          )}
          {messages.map((m, i) => (
            m.role === 'assistant' && m.activity ? (
              <AssistantTurnMessage
                key={i}
                message={m}
                now={activityNow}
                onOpenFile={openFileInWorkspace}
                onToggleActivity={() => {
                  setMessages((items) => items.map((item, index) =>
                    index === i ? { ...item, activityCollapsed: !item.activityCollapsed } : item,
                  ))
                }}
              />
            ) : (
              <div key={i} className={`message ${m.role}`}>
                {m.text ? <Markdown text={m.text} /> : <span className="loading">思考中...</span>}
                {m.role === 'user' && m.attachments && m.attachments.length > 0 && (
                  <MessageFileStrip
                    files={m.attachments.map(attachmentToArtifact)}
                    label="附件"
                    onOpenFile={openFileInWorkspace}
                  />
                )}
                {m.role === 'assistant' && (m.trace || m.toolCalls) && (
                  <TraceCard trace={m.trace} toolCalls={m.toolCalls} durationMs={m.durationMs} onOpenFile={openFileInWorkspace} />
                )}
                {m.role === 'assistant' && m.artifacts && m.artifacts.length > 0 && (
                  <MessageFileStrip files={m.artifacts} label="产出成果" onOpenFile={openFileInWorkspace} />
                )}
              </div>
            )
          ))}
        </div>

        <section className="composer-shell">
          <TaskProgressPresence activity={latestTaskActivity} now={activityNow} />
          <div
            className={`composer ${dragActive ? 'drag-active' : ''}`}
            onDragEnter={handleComposerDragEnter}
            onDragOver={handleComposerDragOver}
            onDragLeave={handleComposerDragLeave}
            onDrop={handleComposerDrop}
          >
            {attachments.length > 0 && (
              <div className="attachment-preview-grid">
                {attachments.map((file) => (
                  <AttachmentPreviewCard
                    key={file.path}
                    file={file}
                    onOpen={() => openFileInWorkspace(file.path)}
                    onRemove={() => {
                      setControlTip(null)
                      setAttachments((prev) => prev.filter((item) => item.path !== file.path))
                    }}
                    onTipChange={setControlTip}
                  />
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={handleComposerPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder="给 LittleSheep 一个任务，或上传文件后直接发送"
              rows={1}
            />
            <div className="composer-controls">
              <div className="composer-left">
                <AddMenu
                  label={uploadTip}
                  onAddFiles={addAttachments}
                  onChooseWorkspace={chooseWorkspace}
                  onTipChange={setControlTip}
                />
                <ModePicker value={permissionMode} onChange={setPermissionMode} />
                {runtime && !workspaceIsWorkplace && (
                  <WorkspaceChip
                    path={runtime.workspace}
                    tip={workspaceTip}
                    onReset={resetWorkspace}
                    onTipChange={setControlTip}
                  />
                )}
              </div>
              <div className="composer-right">
                <ContextUsageIndicator usage={contextUsage} />
                <RuntimePicker
                  runtime={runtime}
                  providers={selectableProviders}
                  selected={selectedModel}
                  onModelChange={(model) => {
                    void applyRuntimePatch({
                      model,
                      reasoning: coerceReasoningForModelRef(runtime?.reasoning ?? 'auto', model),
                    })
                  }}
                  onReasoningChange={(reasoning) => void applyRuntimePatch({ reasoning })}
                />
                <button
                  className={`send-round ${loading ? 'stop' : ''}`}
                  onClick={() => {
                    setControlTip(null)
                    if (loading) {
                      stop()
                    } else {
                      void send()
                    }
                  }}
                  disabled={!loading && !input.trim() && attachments.length === 0}
                  aria-label={sendTip}
                  onMouseEnter={(event) => setControlTip(buildFloatingHelpTip(sendTip, event.clientX, event.clientY))}
                  onMouseMove={(event) => setControlTip(buildFloatingHelpTip(sendTip, event.clientX, event.clientY))}
                  onMouseLeave={() => setControlTip(null)}
                  onFocus={(event) => setControlTip(buildFloatingHelpTipFromElement(sendTip, event.currentTarget))}
                  onBlur={() => setControlTip(null)}
                >
                  {loading ? <StopRunIcon /> : <SendRunIcon />}
                </button>
              </div>
            </div>
          </div>
          {runtimeError && <div className="composer-error">{runtimeError}</div>}
        </section>
      </main>
  )
}
