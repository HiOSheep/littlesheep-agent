// Stable composer surface shared by every conversation.
// Conversation switching updates the message viewport, not this component's DOM.
import { useLayoutEffect, useRef } from 'react'
import {
  coerceReasoningForModelRef,
} from '../../shared/model-capabilities'
import { AddMenu } from '../composer/add-menu'
import { ContextUsageIndicator } from '../composer/context-usage-indicator'
import { shouldFocusComposerInput } from '../composer/focus-routing'
import { AttachmentPreviewCard } from '../composer/message-files'
import { ModePicker } from '../composer/mode-picker'
import { RuntimePicker } from '../composer/runtime-picker'
import { WorkspaceChip } from '../composer/workspace-chip'
import { buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { SendRunIcon, StopRunIcon } from '../ui/icons'
import { TaskProgressPresence } from '../chat/task-progress-indicator'
import { syncComposerInputHeight } from '../composer/input-size'
import type { ComposerViewController } from './app-controller-projections'

export function ComposerView({ controller }: { controller: ComposerViewController }) {
  const {
    input,
    setInput,
    inputRef,
    scrollRef,
    loading,
    permissionMode,
    setPermissionMode,
    runtime,
    attachments,
    setAttachments,
    dragActive,
    runtimeError,
    runtimeEventNotice,
    activityNow,
    selectableProviders,
    selectedModel,
    workspaceIsWorkplace,
    workspaceTip,
    contextUsage,
    latestTaskActivity,
    uploadTip,
    sendTip,
    stopTip,
    setControlTip,
    applyRuntimePatch,
    addAttachments,
    chooseWorkspace,
    resetWorkspace,
    openFileInWorkspace,
    handleComposerDragEnter,
    handleComposerDragOver,
    handleComposerDragLeave,
    handleComposerDrop,
    handleComposerPaste,
    send,
    stop,
  } = controller

  const composerShellRef = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    const shell = composerShellRef.current
    const chat = shell?.parentElement
    if (!shell || !chat?.classList.contains('chat')) return

    let measuredHeight = -1
    const updateOverlayClearance = () => {
      const nextHeight = Math.ceil(shell.getBoundingClientRect().height)
      if (nextHeight <= 0 || nextHeight === measuredHeight) return

      const messagesViewport = scrollRef.current
      const shouldStickToBottom = messagesViewport !== null
        && messagesViewport.scrollHeight - messagesViewport.scrollTop - messagesViewport.clientHeight < 72

      measuredHeight = nextHeight
      chat.style.setProperty('--composer-overlay-height', `${nextHeight}px`)
      if (shouldStickToBottom && messagesViewport) {
        messagesViewport.scrollTop = messagesViewport.scrollHeight
      }
    }

    updateOverlayClearance()
    if (typeof ResizeObserver === 'undefined') {
      return () => chat.style.removeProperty('--composer-overlay-height')
    }

    const observer = new ResizeObserver(updateOverlayClearance)
    observer.observe(shell)
    return () => {
      observer.disconnect()
      chat.style.removeProperty('--composer-overlay-height')
    }
  }, [scrollRef])

  return (
    <section ref={composerShellRef} className="composer-shell">
      <TaskProgressPresence activity={latestTaskActivity} now={activityNow} />
      <div
        className={`composer ${dragActive ? 'drag-active' : ''}`}
        onClick={(event) => {
          if (!shouldFocusComposerInput(event.target)) return
          inputRef.current?.focus({ preventScroll: true })
        }}
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
          onChange={(event) => {
            setInput(event.target.value)
            syncComposerInputHeight(event.currentTarget)
          }}
          onPaste={handleComposerPaste}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
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
            <div className="composer-run-actions">
              {loading && (
                <button
                  className="send-round stop"
                  onClick={() => {
                    setControlTip(null)
                    stop()
                  }}
                  aria-label={stopTip}
                  onMouseEnter={(event) => setControlTip(buildFloatingHelpTip(stopTip, event.clientX, event.clientY))}
                  onMouseMove={(event) => setControlTip(buildFloatingHelpTip(stopTip, event.clientX, event.clientY))}
                  onMouseLeave={() => setControlTip(null)}
                  onFocus={(event) => setControlTip(buildFloatingHelpTipFromElement(stopTip, event.currentTarget))}
                  onBlur={() => setControlTip(null)}
                >
                  <StopRunIcon />
                </button>
              )}
              <button
                className="send-round"
                onClick={() => {
                  setControlTip(null)
                  void send()
                }}
                disabled={!input.trim() && attachments.length === 0}
                aria-label={sendTip}
                onMouseEnter={(event) => setControlTip(buildFloatingHelpTip(sendTip, event.clientX, event.clientY))}
                onMouseMove={(event) => setControlTip(buildFloatingHelpTip(sendTip, event.clientX, event.clientY))}
                onMouseLeave={() => setControlTip(null)}
                onFocus={(event) => setControlTip(buildFloatingHelpTipFromElement(sendTip, event.currentTarget))}
                onBlur={() => setControlTip(null)}
              >
                <SendRunIcon />
              </button>
            </div>
          </div>
        </div>
      </div>
      {runtimeEventNotice && (
        <div
          key={runtimeEventNotice.id}
          className={`runtime-event-notice ${runtimeEventNotice.tone}`}
          role="status"
          aria-live={runtimeEventNotice.tone === 'error' ? 'assertive' : 'polite'}
        >
          {runtimeEventNotice.text}
        </div>
      )}
      {runtimeError && <div className="composer-error">{runtimeError}</div>}
    </section>
  )
}
