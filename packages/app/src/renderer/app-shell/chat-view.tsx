// Conversation transcript view. Scroll ownership (bottom stickiness, the reader's anchor and
// the way back to the newest message) lives in `../chat/use-chat-scroll-controller`.
import { useEffect, useState } from 'react'
import { AssistantTurnMessage } from '../chat/assistant-turn'
import { MessageMeta } from '../chat/message-meta'
import { useChatScrollController } from '../chat/use-chat-scroll-controller'
import { MessageFileStrip } from '../composer/message-files'
import { Markdown } from '../Markdown'
import { TraceCard } from '../TraceCard'
import { attachmentToArtifact } from '../workspace/path-utils'
import type { ChatViewController } from './app-controller-projections'

/** How long the way back takes to grow out of the composer's edge, and to drop back into it. */
const JUMP_MOTION_MS = 180

/**
 * Points down, into the composer. Drawn here rather than added to `ui/icons.tsx`, which is a
 * frozen hotspot (see `docs/reference/module-split-map.md`); this is its only consumer.
 */
function JumpToLatestArrow() {
  return (
    <svg className="chat-jump-to-latest-arrow" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 3.4v8.2M4.4 8.1 8 11.7l3.6-3.6" />
    </svg>
  )
}

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

  const {
    readingAway,
    hasNewContent,
    scrollToLatest,
    prepareOlderHistoryLoad,
    onScroll,
    onClickCapture,
  } = useChatScrollController({
    scrollRef,
    messages,
    sessionKey: currentSession,
    loadOlderMessages,
  })

  // The way back drops out of the composer's edge and drops back into it, so it stays mounted for
  // the length of its own exit instead of vanishing on the frame the reader reaches the bottom.
  const [jumpMounted, setJumpMounted] = useState(readingAway)
  const [jumpSettled, setJumpSettled] = useState(readingAway)
  useEffect(() => {
    let timer = 0
    if (readingAway) {
      setJumpMounted(true)
      // One frame in the small state before growing: a timeout, not requestAnimationFrame, because
      // a window Chromium is not compositing never delivers frames.
      timer = window.setTimeout(() => setJumpSettled(true), 16)
    } else {
      setJumpSettled(false)
      timer = window.setTimeout(() => setJumpMounted(false), JUMP_MOTION_MS)
    }
    return () => window.clearTimeout(timer)
  }, [readingAway])
  const jumpMotion = readingAway && jumpSettled ? 'settled' : readingAway ? 'entering' : 'exiting'

  return (
    <>
        <div
          className={`messages ${messages.length === 0 ? 'is-empty' : ''}`}
           ref={scrollRef}
           onScroll={onScroll}
           onClickCapture={onClickCapture}
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
        {jumpMounted && (
          <button
            type="button"
            className="chat-jump-to-latest"
            data-new-content={hasNewContent ? 'true' : 'false'}
            data-motion={jumpMotion}
            // An icon-only control still has to say what it does, and the two states differ: with
            // new content below this is how the reader learns there was something to come back to.
            aria-label={hasNewContent ? '有新内容，回到最新' : '回到最新'}
            tabIndex={readingAway ? 0 : -1}
            aria-hidden={readingAway ? undefined : true}
            onClick={scrollToLatest}
          >
            <JumpToLatestArrow />
          </button>
        )}
    </>
  )
}
