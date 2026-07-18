// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
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
import {
  createDisplaySettleState,
  observeDisplaySettleFrame,
  shouldContinueDisplaySettle,
  type DisplaySettleState,
} from '../ui/display-synced-settle'
import { attachmentToArtifact } from '../workspace/path-utils'
import type { AppController } from './use-app-controller'




type ScrollRepair =
  | { kind: 'anchor'; key: string; offset: number }
  | { kind: 'height'; height: number; top: number }

export function ChatView({ controller }: { controller: AppController }) {
  const { currentSession, messages, setMessages, historyWindow, loadOlderMessages, input, setInput, loading, permissionMode, setPermissionMode, runtime, attachments, setAttachments, dragActive, runtimeError, workspacePanelCollapsed, workspacePanelReopenActive, setWorkspacePanelReopenActive, workspacePanelFullscreen, workspacePanelTab, workspacePanelOpenTabs, workspaceOpenRequest, setWorkspaceOpenRequest, workspaceFileDrafts, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed, workspaceExpandedPaths, setWorkspaceExpandedPaths, pendingDirtyCloseTab, setPendingDirtyCloseTab, conversationCollapsed, setConversationCollapsed, scrollRef, inputRef, shellRef, activityNow, workspaceArtifactVersion, controlTip, setControlTip, selectableProviders, selectedModel, workspaceIsWorkplace, workspaceTip, contextUsage, latestTaskActivity, uploadTip, sendTip, requestWorkspaceSaveApproval, requestWorkspaceCommandApproval, applyRuntimePatch, addAttachments, chooseWorkspace, resetWorkspace, openFileInWorkspace, handleComposerDragEnter, handleComposerDragOver, handleComposerDragLeave, handleComposerDrop, handleComposerPaste, send, stop, updateWorkspaceFileDraft, closeWorkspacePanelTab, defaultWorkspacePath, workspacePanelRoot, workspacePanelUsingTemporaryRoot } = controller

  const stickToBottomRef = useRef(true)
  const scrollRepairRef = useRef<ScrollRepair | null>(null)
  const repairFrameRef = useRef<number | null>(null)
  const [disclosureInteractionVersion, setDisclosureInteractionVersion] = useState(0)

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return
    if (repairFrameRef.current !== null) window.cancelAnimationFrame(repairFrameRef.current)
    const repair = scrollRepairRef.current
    scrollRepairRef.current = null
    if (repair) {
      let settleState: DisplaySettleState | null = null
      const readLayoutSignature = () => {
        const dimensions = `${container.scrollHeight}:${container.clientHeight}`
        if (repair.kind === 'height') return dimensions
        const anchor = Array.from(container.querySelectorAll<HTMLElement>('[data-message-key]'))
          .find((element) => element.dataset.messageKey === repair.key)
        return anchor ? `${dimensions}:${anchor.offsetHeight}:${anchor.scrollHeight}` : dimensions
      }
      const apply = (timestamp: number) => {
        settleState ??= createDisplaySettleState(timestamp, readLayoutSignature())
        if (repair.kind === 'height') {
          container.scrollTop = repair.top + (container.scrollHeight - repair.height)
        } else {
          const anchor = Array.from(container.querySelectorAll<HTMLElement>('[data-message-key]'))
            .find((element) => element.dataset.messageKey === repair.key)
          if (anchor) {
            const containerTop = container.getBoundingClientRect().top
            container.scrollTop += anchor.getBoundingClientRect().top - containerTop - repair.offset
          }
        }
        settleState = observeDisplaySettleFrame(settleState, timestamp, readLayoutSignature())
        if (shouldContinueDisplaySettle(settleState, timestamp)) {
          // The callback timestamp is tied to Chromium's active display VSync.
          // Never replace this with a fixed frame count: that changes the
          // duration on 60/120/144/240 Hz displays.
          repairFrameRef.current = window.requestAnimationFrame(apply)
        } else {
          repairFrameRef.current = null
        }
      }
      apply(window.performance.now())
      return
    }
    if (stickToBottomRef.current) container.scrollTop = container.scrollHeight
  }, [messages, scrollRef, disclosureInteractionVersion])

  useLayoutEffect(() => () => {
    if (repairFrameRef.current !== null) window.cancelAnimationFrame(repairFrameRef.current)
  }, [])

  useLayoutEffect(() => {
    stickToBottomRef.current = true
    scrollRepairRef.current = null
    const container = scrollRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [currentSession, scrollRef])

  function captureDisclosureAnchor(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (!target.closest('.assistant-turn-header, .activity-disclosure-header, .activity-command-header')) return
    const message = target.closest<HTMLElement>('[data-message-key]')
    const container = scrollRef.current
    if (!message || !container || !message.dataset.messageKey) return
    scrollRepairRef.current = {
      kind: 'anchor',
      key: message.dataset.messageKey,
      offset: message.getBoundingClientRect().top - container.getBoundingClientRect().top,
    }
    // Expanding a nested disclosure is a reading action, not new-message
    // arrival. Never let the composer-follow rule move the reader to the end.
    stickToBottomRef.current = false
    setDisclosureInteractionVersion((value) => value + 1)
  }

  function prepareOlderHistoryLoad() {
    const container = scrollRef.current
    if (container) scrollRepairRef.current = { kind: 'height', height: container.scrollHeight, top: container.scrollTop }
    void loadOlderMessages().then((loaded) => {
      if (!loaded) scrollRepairRef.current = null
    })
  }

  return (
      <main className="chat">
        <div
          className={`messages ${messages.length === 0 ? 'is-empty' : ''}`}
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget
            stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72
          }}
          onClickCapture={captureDisclosureAnchor}
        >
          {historyWindow.hasMore && (
            <button
              type="button"
              className="history-load-older"
              disabled={historyWindow.loading}
              onClick={prepareOlderHistoryLoad}
            >
              {historyWindow.loading ? '加载更早内容...' : '加载更早内容'}
            </button>
          )}
          {messages.length === 0 && (
            <div className="empty-hint">
              <div className="empty-title">今天要推进什么？</div>
              <div className="empty-copy">选择模型、推理强度和工作目录后，直接交给 LittleSheep。</div>
            </div>
          )}
          {messages.map((m, i) => (
            m.role === 'assistant' && m.activity ? (
              <AssistantTurnMessage
                key={m.id ?? i}
                message={m}
                messageKey={m.id ?? `message-${i}`}
                now={activityNow}
                onOpenFile={openFileInWorkspace}
                onToggleActivity={() => {
                  setMessages((items) => items.map((item, index) =>
                    (m.id ? item.id === m.id : index === i) ? { ...item, activityCollapsed: !item.activityCollapsed } : item,
                  ))
                }}
              />
            ) : (
              <div key={m.id ?? i} data-message-key={m.id ?? `message-${i}`} className={`message ${m.role}`}>
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
