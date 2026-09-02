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
import {
  CHAT_COMPOSER_OVERLAY_RESIZE_EVENT,
  isChatNearBottom,
  readChatScrollGeometry,
} from '../chat/chat-scroll-anchor'
import { syncComposerInputHeight } from '../composer/input-size'
import { WINDOW_RESIZE_END_EVENT } from '../ui/resize'
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
    removeAttachment,
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
    applyModelPatch,
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
  const showStop = loading && !input.trim()
  const runActionTip = showStop ? stopTip : sendTip

  useLayoutEffect(() => {
    const shell = composerShellRef.current
    const chat = shell?.parentElement
    if (!shell || !chat?.classList.contains('chat')) return

    let measuredHeight = -1
    let measuredWidth = -1

    const updateOverlayClearance = (immediate = false) => {
      const nextWidth = Math.ceil(shell.getBoundingClientRect().width)
      if (nextWidth > 0 && nextWidth !== measuredWidth) {
        measuredWidth = nextWidth
        // A fixed textarea height becomes stale when column changes wrap an
        // existing draft. Recalculate before measuring the composer shell.
        if (
          !document.body.classList.contains('is-resizing-column')
          && !document.body.classList.contains('is-window-resizing')
        ) {
          syncComposerInputHeight(inputRef.current)
        }
      }

      const nextHeight = Math.ceil(shell.getBoundingClientRect().height)
      if (nextHeight <= 0 || nextHeight === measuredHeight) return

      const messagesViewport = scrollRef.current
      const previousGeometry = messagesViewport ? readChatScrollGeometry(messagesViewport) : null
      const shouldStickToBottom = previousGeometry !== null && isChatNearBottom(previousGeometry)

      measuredHeight = nextHeight
      chat.style.setProperty('--composer-overlay-height', `${nextHeight}px`)
      if (
        !immediate
        && !document.body.classList.contains('is-window-resizing')
        && shouldStickToBottom
        && previousGeometry
      ) {
        // ChatView owns the one resize-repair queue. Sending the pre-change
        // geometry here merges overlay-height and viewport-width changes into
        // one bottom-gap correction after the layout transition settles.
        chat.dispatchEvent(new CustomEvent(CHAT_COMPOSER_OVERLAY_RESIZE_EVENT, {
          detail: previousGeometry,
        }))
      }
    }

    updateOverlayClearance(true)
    if (typeof ResizeObserver === 'undefined') {
      return () => chat.style.removeProperty('--composer-overlay-height')
    }

    const observer = new ResizeObserver(() => updateOverlayClearance())
    observer.observe(shell)
    const handleWindowResizeEnd = () => updateOverlayClearance(true)
    window.addEventListener(WINDOW_RESIZE_END_EVENT, handleWindowResizeEnd)
    return () => {
      observer.disconnect()
      window.removeEventListener(WINDOW_RESIZE_END_EVENT, handleWindowResizeEnd)
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
                  removeAttachment(file)
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
                applyModelPatch({
                  model,
                  reasoning: coerceReasoningForModelRef(runtime?.reasoning ?? 'auto', model),
                })
              }}
              onReasoningChange={(reasoning) => void applyRuntimePatch({ reasoning })}
            />
            <div className="composer-run-actions">
              <button
                className={`send-round${showStop ? ' stop' : ''}`}
                onClick={() => {
                  setControlTip(null)
                  if (showStop) stop()
                  else void send()
                }}
                disabled={!loading && !input.trim() && attachments.length === 0}
                aria-label={runActionTip}
                onMouseEnter={(event) => setControlTip(buildFloatingHelpTip(runActionTip, event.clientX, event.clientY))}
                onMouseMove={(event) => setControlTip(buildFloatingHelpTip(runActionTip, event.clientX, event.clientY))}
                onMouseLeave={() => setControlTip(null)}
                onFocus={(event) => setControlTip(buildFloatingHelpTipFromElement(runActionTip, event.currentTarget))}
                onBlur={() => setControlTip(null)}
              >
                {showStop ? <StopRunIcon /> : <SendRunIcon />}
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
