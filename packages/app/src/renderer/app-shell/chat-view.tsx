import { useCallback, useLayoutEffect, useRef, type MouseEvent } from 'react'
import { AssistantTurnMessage } from '../chat/assistant-turn'
import { MessageMeta } from '../chat/message-meta'
import {
  CHAT_COMPOSER_OVERLAY_RESIZE_EVENT,
  CHAT_STICKY_BOTTOM_THRESHOLD,
  didChatViewportResize,
  isChatNearBottom,
  readChatScrollGeometry,
  resolveChatResizeScrollTop,
  resolveBottomAnchoredScrollTop,
  type ChatScrollGeometry,
} from '../chat/chat-scroll-anchor'
import {
  WINDOW_RESIZE_END_EVENT,
  WINDOW_RESIZE_START_EVENT,
  WORKSPACE_NAVIGATOR_MOTION_END_EVENT,
  WORKSPACE_NAVIGATOR_MOTION_START_EVENT,
} from '../ui/resize'
import { MessageFileStrip } from '../composer/message-files'
import { Markdown } from '../Markdown'
import { TraceCard } from '../TraceCard'
import {
  createDisplaySettleState,
  observeDisplaySettleFrame,
  shouldContinueDisplaySettle,
  type DisplaySettleState,
} from '../ui/display-synced-settle'
import { attachmentToArtifact } from '../workspace/path-utils'
import type { ChatViewController } from './app-controller-projections'




export function ChatView({ controller }: { controller: ChatViewController }) {
  const {
    currentSession,
    messages,
    historyWindow,
    loadOlderMessages,
    scrollRef,
    activityNow,
    openFileInWorkspace,
  } = controller

  const stickToBottomRef = useRef(true)
  const scrollRepairRef = useRef<ChatScrollGeometry | null>(null)
  const scrollGeometryRef = useRef<ChatScrollGeometry | null>(null)
  const repairFrameRef = useRef<number | null>(null)
  const resizeRepairRef = useRef<{ geometry: ChatScrollGeometry; stickToBottom: boolean } | null>(null)

  const rememberScrollGeometry = useCallback((container: HTMLElement) => {
    scrollGeometryRef.current = readChatScrollGeometry(container)
  }, [])

  const rememberScrollEventGeometry = useCallback((container: HTMLElement) => {
    scrollGeometryRef.current = readChatScrollGeometry(container)
  }, [])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return
    if (repairFrameRef.current !== null) window.cancelAnimationFrame(repairFrameRef.current)
    const previousGeometry = scrollGeometryRef.current
    resizeRepairRef.current = null
    const repair = scrollRepairRef.current
    scrollRepairRef.current = null
    if (repair) {
      let settleState: DisplaySettleState | null = null
      const readLayoutSignature = () => `${container.scrollHeight}:${container.clientHeight}`
      const apply = (timestamp: number) => {
        settleState ??= createDisplaySettleState(timestamp, readLayoutSignature())
        const nextTop = resolveBottomAnchoredScrollTop(repair, readChatScrollGeometry(container))
        if (Math.abs(container.scrollTop - nextTop) > 0.5) container.scrollTop = nextTop
        rememberScrollGeometry(container)
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
    const shouldStickToBottom = previousGeometry
      ? isChatNearBottom(previousGeometry, CHAT_STICKY_BOTTOM_THRESHOLD)
      : stickToBottomRef.current
    if (shouldStickToBottom) {
      container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    }
    rememberScrollGeometry(container)
  }, [messages, rememberScrollGeometry, scrollRef])

  useLayoutEffect(() => () => {
    if (repairFrameRef.current !== null) window.cancelAnimationFrame(repairFrameRef.current)
  }, [])

  useLayoutEffect(() => {
    stickToBottomRef.current = true
    scrollRepairRef.current = null
    resizeRepairRef.current = null
    const container = scrollRef.current
    if (container) {
      container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      rememberScrollGeometry(container)
    }
  }, [currentSession, rememberScrollGeometry, scrollRef])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return
    rememberScrollGeometry(container)
    if (typeof ResizeObserver === 'undefined') return

    const applyResizeRepair = (repair: { geometry: ChatScrollGeometry; stickToBottom: boolean }) => {
      const current = readChatScrollGeometry(container)
      const nextTop = resolveChatResizeScrollTop(
        repair.geometry,
        current,
        repair.stickToBottom,
      )
      if (nextTop !== null && Math.abs(container.scrollTop - nextTop) > 0.5) {
        // ResizeObserver runs before the next paint. Applying the anchor here
        // keeps a bottom-pinned chat at the bottom from the first compressed
        // layout instead of visibly correcting it on a later timer.
        container.scrollTop = nextTop
      }
      rememberScrollGeometry(container)
    }

    const scheduleResizeRepair = (previous: ChatScrollGeometry) => {
      // Preserve the geometry from the first notification in this burst, but
      // apply the correction immediately. Delaying this until the transition
      // settles makes a bottom-pinned chat visibly jump after compression.
      resizeRepairRef.current ??= {
        geometry: previous,
        // The geometry captured immediately before the resize is the only
        // reliable indication of where the reader was. A stale sticky flag
        // must not turn an intentional reading gap into bottom pinning.
        stickToBottom: isChatNearBottom(previous),
      }
      const repair = resizeRepairRef.current
      if (repair) applyResizeRepair(repair)
      resizeRepairRef.current = null
    }

    let navigatorMotionGeometry: ChatScrollGeometry | null = null
    let windowResizeGeometry: ChatScrollGeometry | null = null
    const handleNavigatorMotionStart = () => {
      navigatorMotionGeometry ??= readChatScrollGeometry(container)
    }
    const handleNavigatorMotionEnd = () => {
      const previous = navigatorMotionGeometry
      navigatorMotionGeometry = null
      if (previous) scheduleResizeRepair(previous)
    }

    const handleWindowResizeStart = () => {
      windowResizeGeometry ??= readChatScrollGeometry(container)
      resizeRepairRef.current = null
    }
    const handleWindowResizeEnd = () => {
      const previous = windowResizeGeometry
      windowResizeGeometry = null
      if (previous) scheduleResizeRepair(previous)
    }

    const handleComposerOverlayResize = (event: Event) => {
      const previous = (event as CustomEvent<ChatScrollGeometry>).detail
      if (!previous) return
      scheduleResizeRepair(previous)
    }

    const observer = new ResizeObserver(() => {
      // Motion events provide the pre-transition geometry. Keep observing
      // while the panels animate so a pinned chat follows every compressed
      // layout before it can be painted at an intermediate position.
      const previous = navigatorMotionGeometry
        ?? windowResizeGeometry
        ?? scrollGeometryRef.current
      const current = readChatScrollGeometry(container)
      if (previous && didChatViewportResize(previous, current)) {
        scheduleResizeRepair(previous)
      }
      rememberScrollGeometry(container)
    })
    observer.observe(container)
    container.parentElement?.addEventListener(
      CHAT_COMPOSER_OVERLAY_RESIZE_EVENT,
      handleComposerOverlayResize,
    )
    window.addEventListener(WORKSPACE_NAVIGATOR_MOTION_START_EVENT, handleNavigatorMotionStart)
    window.addEventListener(WORKSPACE_NAVIGATOR_MOTION_END_EVENT, handleNavigatorMotionEnd)
    window.addEventListener(WINDOW_RESIZE_START_EVENT, handleWindowResizeStart)
    window.addEventListener(WINDOW_RESIZE_END_EVENT, handleWindowResizeEnd)
    return () => {
      observer.disconnect()
      container.parentElement?.removeEventListener(
        CHAT_COMPOSER_OVERLAY_RESIZE_EVENT,
        handleComposerOverlayResize,
      )
      window.removeEventListener(WORKSPACE_NAVIGATOR_MOTION_START_EVENT, handleNavigatorMotionStart)
      window.removeEventListener(WORKSPACE_NAVIGATOR_MOTION_END_EVENT, handleNavigatorMotionEnd)
      window.removeEventListener(WINDOW_RESIZE_START_EVENT, handleWindowResizeStart)
      window.removeEventListener(WINDOW_RESIZE_END_EVENT, handleWindowResizeEnd)
      resizeRepairRef.current = null
    }
  }, [rememberScrollGeometry, scrollRef])

  function captureDisclosureInteraction(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (!target.closest('.agent-tool-row, .trace-toggle')) return
    // Expanding a nested disclosure is a reading action, not new-message
    // arrival. Leave scrollTop untouched while CSS animates the content height.
    stickToBottomRef.current = false
  }

  function prepareOlderHistoryLoad() {
    const container = scrollRef.current
    if (container) scrollRepairRef.current = readChatScrollGeometry(container)
    void loadOlderMessages().then((loaded) => {
      if (!loaded) scrollRepairRef.current = null
    })
  }

  return (
        <div
          className={`messages ${messages.length === 0 ? 'is-empty' : ''}`}
           ref={scrollRef}
           onScroll={(event) => {
             const element = event.currentTarget
             resizeRepairRef.current = null
             const geometry = readChatScrollGeometry(element)
             stickToBottomRef.current = isChatNearBottom(geometry, CHAT_STICKY_BOTTOM_THRESHOLD)
            rememberScrollEventGeometry(element)
          }}
          onClickCapture={captureDisclosureInteraction}
        >
          <div className="messages-content">
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
          {historyWindow.loading && messages.length === 0 && (
            <div className="history-loading loading" role="status" aria-live="polite">
              加载历史消息...
            </div>
          )}
          {messages.length === 0 && !historyWindow.loading && (
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
              />
            ) : (
              <div key={m.id ?? i} data-message-key={m.id ?? `message-${i}`} className={`message-with-meta ${m.role}`}>
                <div className={`message ${m.role}`}>
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
                <MessageMeta role={m.role} text={m.text} timestamp={m.timestamp} />
              </div>
            )
          ))}
          </div>
        </div>
  )
}
