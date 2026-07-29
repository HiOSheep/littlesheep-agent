// Stable composer surface shared by every conversation.
// Conversation switching updates the message viewport, not this component's DOM.
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
import { attachmentToArtifact } from '../workspace/path-utils'
import { TaskProgressPresence } from '../chat/task-progress-indicator'
import type { AppController } from './use-app-controller'

export function ComposerView({ controller }: { controller: AppController }) {
  const {
    input,
    setInput,
    inputRef,
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

  return (
    <section className="composer-shell">
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
          onChange={(event) => setInput(event.target.value)}
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
