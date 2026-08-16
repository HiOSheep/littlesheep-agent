import { useCallback, useLayoutEffect, useRef, type MouseEvent } from 'react'
import { AssistantTurnMessage } from '../chat/assistant-turn'
import {
  didChatViewportResize,
  readChatScrollGeometry,
  resolveBottomAnchoredScrollTop,
  type ChatScrollGeometry,
} from '../chat/chat-scroll-anchor'
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
import type { AppController } from './use-app-controller'




export function ChatView({ controller }: { controller: AppController }) {
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

  const rememberScrollGeometry = useCallback((container: HTMLElement) => {
    scrollGeometryRef.current = readChatScrollGeometry(container)
  }, [])

  const rememberScrollEventGeometry = useCallback((container: HTMLElement) => {
    const previous = scrollGeometryRef.current
    const current = readChatScrollGeometry(container)
    // A resize can queue a scroll event before ResizeObserver repairs the
    // viewport. Keep the pre-resize geometry until that repair runs.
    if (!previous || !didChatViewportResize(previous, current)) {
      scrollGeometryRef.current = current
    }
  }, [])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return
    if (repairFrameRef.current !== null) window.cancelAnimationFrame(repairFrameRef.current)
    const repair = scrollRepairRef.current
    scrollRepairRef.current = null
    if (repair) {
      let settleState: DisplaySettleState | null = null
      const readLayoutSignature = () => `${container.scrollHeight}:${container.clientHeight}`
      const apply = (timestamp: number) => {
        settleState ??= createDisplaySettleState(timestamp, readLayoutSignature())
        container.scrollTop = resolveBottomAnchoredScrollTop(repair, readChatScrollGeometry(container))
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
    if (stickToBottomRef.current) container.scrollTop = container.scrollHeight
    rememberScrollGeometry(container)
  }, [messages, rememberScrollGeometry, scrollRef])

  useLayoutEffect(() => () => {
    if (repairFrameRef.current !== null) window.cancelAnimationFrame(repairFrameRef.current)
  }, [])

  useLayoutEffect(() => {
    stickToBottomRef.current = true
    scrollRepairRef.current = null
    const container = scrollRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
      rememberScrollGeometry(container)
    }
  }, [currentSession, rememberScrollGeometry, scrollRef])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return
    rememberScrollGeometry(container)
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      const previous = scrollGeometryRef.current
      const current = readChatScrollGeometry(container)
      if (previous && didChatViewportResize(previous, current)) {
        container.scrollTop = resolveBottomAnchoredScrollTop(previous, current)
      }
      rememberScrollGeometry(container)
    })
    observer.observe(container)
    return () => observer.disconnect()
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
            stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72
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
        </div>
  )
}
