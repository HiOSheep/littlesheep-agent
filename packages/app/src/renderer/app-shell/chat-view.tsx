// Conversation transcript view. Scroll ownership (bottom stickiness, the reader's anchor and
// the way back to the newest message) lives in `../chat/use-chat-scroll-controller`.
import { AssistantTurnMessage } from '../chat/assistant-turn'
import { MessageMeta } from '../chat/message-meta'
import { useChatScrollController } from '../chat/use-chat-scroll-controller'
import { MessageFileStrip } from '../composer/message-files'
import { Markdown } from '../Markdown'
import { TraceCard } from '../TraceCard'
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
        {readingAway && (
          <button
            type="button"
            className="chat-jump-to-latest"
            data-new-content={hasNewContent ? 'true' : 'false'}
            onClick={scrollToLatest}
          >
            {hasNewContent ? '有新内容 · 回到最新' : '回到最新'}
          </button>
        )}
    </>
  )
}
