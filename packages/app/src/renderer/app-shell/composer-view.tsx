// Stable composer surface shared by every conversation.
// Conversation switching updates the message viewport, not this component's DOM.
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent } from 'react'
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
import { createImeCompositionState, resolveEnterAction } from '../ui/enter-confirm'
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
import { useRuntimeReadiness } from '../runtime-readiness/use-runtime-readiness'
import { ComposerReadinessHint } from '../runtime-readiness/composer-readiness-hint'
import type { ComposerViewController } from './app-controller-projections'

export function ComposerView({ controller }: { controller: ComposerViewController }) {
  // Execution availability comes from the Runtime, not from local state: the
  // composer renders before the Runner exists, and only the readiness fact may
  // decide whether sending is possible yet.
  const { readiness, reason: readinessReason } = useRuntimeReadiness()
  const executionUnavailable = readinessReason
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
    openSettingsPage,
    refreshRuntime,
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
  // Enter sends and Shift+Enter keeps the line break; an input method that
  // confirms candidates with Enter keeps its own key. See ui/enter-confirm.
  const imeComposition = useRef(createImeCompositionState()).current
  // A requested stop stays labelled until the run itself settles: the run's
  // end is the runtime confirmation, and `run-actions` already refuses a
  // second interrupt for the same run.
  const [stopping, setStopping] = useState(false)
  useEffect(() => {
    if (!loading) setStopping(false)
  }, [loading])
  const hasPendingInput = input.trim().length > 0 || attachments.length > 0
  // Running keeps a stop entry that never depends on the draft, plus a
  // supplementary send once there is something new to hand to the run.
  const stopActionTip = stopping ? '正在停止当前任务' : stopTip

  function runActionTipHandlers(tip: string) {
    return {
      onMouseEnter: (event: ReactMouseEvent<HTMLButtonElement>) => setControlTip(buildFloatingHelpTip(tip, event.clientX, event.clientY)),
      onMouseMove: (event: ReactMouseEvent<HTMLButtonElement>) => setControlTip(buildFloatingHelpTip(tip, event.clientX, event.clientY)),
      onMouseLeave: () => setControlTip(null),
      onFocus: (event: ReactFocusEvent<HTMLButtonElement>) => setControlTip(buildFloatingHelpTipFromElement(tip, event.currentTarget)),
      onBlur: () => setControlTip(null),
    }
  }

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
          onCompositionStart={() => imeComposition.start()}
          onCompositionEnd={() => imeComposition.end()}
          onKeyDown={(event) => {
            if (resolveEnterAction(event.nativeEvent, imeComposition.composing) !== 'confirm') return
            event.preventDefault()
            void send()
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
            <ComposerReadinessHint readiness={readiness} reason={readinessReason} />
            <ContextUsageIndicator usage={contextUsage} />
            <RuntimePicker
              runtime={runtime}
              runtimeError={runtimeError}
              providers={selectableProviders}
              selected={selectedModel}
              onModelChange={(model) => {
                applyModelPatch({
                  model,
                  reasoning: coerceReasoningForModelRef(runtime?.reasoning ?? 'auto', model),
                })
              }}
              onReasoningChange={(reasoning) => void applyRuntimePatch({ reasoning })}
              onConfigureModel={() => openSettingsPage('api')}
              onRetryModelConfig={refreshRuntime}
            />
            <div className="composer-run-actions">
              {loading && (
                <button
                  className="send-round stop"
                  onClick={() => {
                    setControlTip(null)
                    setStopping(true)
                    stop()
                  }}
                  disabled={stopping}
                  aria-label={stopActionTip}
                  {...runActionTipHandlers(stopActionTip)}
                >
                  <StopRunIcon />
                </button>
              )}
              {(!loading || hasPendingInput) && (
                // The window is usable before the Runtime is ready, so a send in
                // that window is limited on purpose. The draft and the focus stay
                // untouched, and the reason comes from the Runtime rather than a
                // generic "please wait".
                <button
                  className="send-round"
                  onClick={() => {
                    setControlTip(null)
                    void send()
                  }}
                  disabled={executionUnavailable !== null || (!loading && !hasPendingInput)}
                  aria-label={executionUnavailable ? executionUnavailable : sendTip}
                  {...runActionTipHandlers(executionUnavailable ?? sendTip)}
                >
                  <SendRunIcon />
                </button>
              )}
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
