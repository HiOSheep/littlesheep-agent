// Conversation transcript view. Scroll ownership (bottom stickiness, the reader's anchor and
// the way back to the newest message) lives in `../chat/use-chat-scroll-controller`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssistantTurnMessage } from '../chat/assistant-turn'
import { MessageMeta } from '../chat/message-meta'
import { useChatScrollController } from '../chat/use-chat-scroll-controller'
import { TurnRail } from '../chat/turn-rail'
import { RAIL_MIN_ENTRIES, chatJumpShortcut, railEntries } from '../chat/turn-navigation'
import { emptyHintFor } from '../chat/empty-hint'
import { MessageFileStrip, MessageImageStrip } from '../composer/message-files'
import { Markdown } from '../Markdown'
import { RunningPill } from '../sidebar/running-pill'
import { VoidRing } from '../ui/void-ring'
import { modalLayers } from '../ui/modal-layer'
import { TraceCard } from '../TraceCard'
import { attachmentToArtifact, inferAttachmentKind } from '../workspace/path-utils'
import type { ChatViewController } from './app-controller-projections'

/** How long the way back takes to grow out of the composer's edge, and to drop back into it. */
const JUMP_MOTION_MS = 180

/**
 * Points down, into the composer. Drawn here rather than added to `ui/icons.tsx`, which is a
 * frozen hotspot (see `docs/reference/module-split-map.md`); this is its only consumer.
 */
function JumpToLatestArrow() {
  return (
    <svg className="chat-jump-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
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
    openReviewInWorkspace,
    branchConversationFromMessage,
    projectPath,
    titlebarTask,
    renameSession,
    stop,
    setControlTip,
    openSettingsPage,
    // A failed turn's own action. The handler is stable and the turn decides whether it offers it,
    // so every turn gets the same prop and only a `failed` one renders the control.
    loading,
    retryFailedTurn,
  } = controller
  // The turn's files are opened from here, so their line counts come from the same workspace.
  const artifactsWorkspaceRoot = projectPath
  const openUsageHistory = useCallback(() => openSettingsPage('usage'), [openSettingsPage])

  // The transcript answers "what can I do here?" The composer answers the
  // separate question "why can't I send this yet?" Keep those surfaces distinct.
  const emptyHint = emptyHintFor(currentSession ?? '')

  const {
    readingAway,
    hasNewContent,
    activeTurnKey,
    railInTheWay,
    scrollToLatest,
    scrollToTop,
    scrollToTurn,
    prepareOlderHistoryLoad,
    onScroll,
    onClickCapture,
  } = useChatScrollController({
    scrollRef,
    messages,
    sessionKey: currentSession,
    loadOlderMessages,
  })

  // The rail is for conversations long enough to lose your place in; below that the two end
  // buttons are the whole of it.
  const railTurns = useMemo(() => railEntries(messages), [messages])

  // The way back drops out of the composer's edge and drops back into it, so it stays mounted for
  // the length of its own exit instead of vanishing on the frame the reader reaches the bottom.
  // Only the newest end has a droplet (asked for 2026-10-03: the way back to the first line is the
  // rail and Ctrl+Home, and a pair of circles in the middle of the transcript was one control too
  // many): it is offered while the reader is away from the bottom.
  const showJumpControls = readingAway
  const [jumpMounted, setJumpMounted] = useState(showJumpControls)
  const [jumpSettled, setJumpSettled] = useState(showJumpControls)
  // What the exit animation carries: the droplet that was on screen when the reader arrived at the
  // bottom, so it shrinks back into the composer instead of blinking out.
  const offeredJumpRef = useRef({ latest: showJumpControls })
  if (showJumpControls) offeredJumpRef.current = { latest: showJumpControls }
  const offeredJump = showJumpControls ? { latest: showJumpControls } : offeredJumpRef.current
  useEffect(() => {
    let timer = 0
    if (showJumpControls) {
      setJumpMounted(true)
      // One frame in the small state before growing: a timeout, not requestAnimationFrame, because
      // a window Chromium is not compositing never delivers frames.
      timer = window.setTimeout(() => setJumpSettled(true), 16)
    } else {
      setJumpSettled(false)
      timer = window.setTimeout(() => setJumpMounted(false), JUMP_MOTION_MS)
    }
    return () => window.clearTimeout(timer)
  }, [showJumpControls])
  const jumpMotion = showJumpControls && jumpSettled ? 'settled' : showJumpControls ? 'entering' : 'exiting'

  // Ctrl/Cmd+Home and Ctrl/Cmd+End reach the two ends from anywhere in the conversation. Two
  // refusals: an open modal owns the keyboard, and a field keeps its own Ctrl+Home (the caret) -
  // unless the field is an empty draft, where moving that caret is invisible and the reader who
  // left the caret in the composer means the transcript.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = chatJumpShortcut(event.key, event)
      if (!action) return
      if (modalLayers.depth() > 0) return
      const target = event.target instanceof HTMLElement ? event.target : null
      const field = target?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') ?? null
      if (field && !(field instanceof HTMLTextAreaElement && field.value === '')) return
      event.preventDefault()
      if (action === 'top') scrollToTop()
      else scrollToLatest()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [scrollToLatest, scrollToTop])

  return (
    <>
        <header className="chat-header" aria-label="当前对话">
          {titlebarTask.hasSession ? <RunningPill
            title={titlebarTask.title} activity={titlebarTask.activity} now={titlebarTask.now}
            offset={{ x: 0, y: 0 }} draggable={false} showTips={false} onOffsetChange={() => undefined}
            onRename={(next) => { if (currentSession) void renameSession(currentSession, next) }}
            onStop={stop} onTipChange={setControlTip}
          /> : <span className="chat-header-title">新对话</span>}
          {railTurns.length >= RAIL_MIN_ENTRIES && (
            <TurnRail key={currentSession ?? 'draft'} entries={railTurns} activeKey={activeTurnKey}
              overlapsText={railInTheWay} onJump={scrollToTurn} onTipChange={setControlTip} />
          )}
        </header>
        <div
          role="region" aria-label="对话消息"
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
              <VoidRing state="loading" />
              加载历史消息...
            </div>
          )}
          {messages.length === 0 && !historyWindow.loading && (
            <div className="empty-hint">
              <VoidRing state="idle" size={64} interactive />
              <div className="empty-title">{emptyHint.title}</div>
              <div className="empty-copy">{emptyHint.copy}</div>
            </div>
          )}
          {messages.map((m, i) => (
            m.role === 'assistant' && m.activity ? (
              <AssistantTurnMessage
                key={m.id ?? i}
                message={m}
                messageKey={m.id ?? `message-${i}`}
                now={activityNow}
                workspaceRoot={artifactsWorkspaceRoot}
                onOpenFile={openFileInWorkspace}
                onOpenReview={openReviewInWorkspace}
                onBranch={branchConversationFromMessage}
                onRetryTurn={retryFailedTurn}
                onOpenUsageHistory={openUsageHistory}
                retryPending={loading}
              />
            ) : (
              <div key={m.id ?? i} data-message-key={m.id ?? `message-${i}`} className={`message-with-meta ${m.role}`}>
                {m.role === 'user' && m.attachments && <MessageImageStrip files={m.attachments} />}
                <div className={`message ${m.role}`}>
                  {m.text ? <Markdown text={m.text} /> : m.role === 'assistant' ? <span className="loading" role="status">正在处理…</span> : null}
                  {m.role === 'user' && m.attachments && m.attachments.length > 0 && (
                    <MessageFileStrip
                      files={m.attachments.filter((file) => (file.kind ?? inferAttachmentKind(file.name ?? file.path)) !== 'image').map(attachmentToArtifact)}
                      label="附件"
                      onOpenFile={openFileInWorkspace}
                    />
                  )}
                  {m.role === 'assistant' && (m.trace || m.toolCalls) && (
                    <TraceCard trace={m.trace} toolCalls={m.toolCalls} durationMs={m.durationMs} onOpenFile={openFileInWorkspace} />
                  )}
                  {m.role === 'assistant' && m.artifacts && m.artifacts.length > 0 && (
                    <MessageFileStrip files={m.artifacts} label="产出成果" workspaceRoot={artifactsWorkspaceRoot} toolCalls={m.activity?.tools} onOpenFile={openFileInWorkspace} onOpenReview={openReviewInWorkspace} />
                  )}
                </div>
                <MessageMeta
                  role={m.role}
                  text={m.text}
                  timestamp={m.timestamp}
                  onBranch={m.id
                    ? () => void branchConversationFromMessage(m.id as string)
                    : undefined}
                />
              </div>
            )
          ))}
          </div>
        </div>
        {jumpMounted && (
          <div
            className="chat-jump-controls"
            data-motion={jumpMotion}
            {...(!showJumpControls ? { inert: '' } : {})}
          >
            {offeredJump.latest && (
              <button
                type="button"
                className="chat-jump-button chat-jump-to-latest"
                data-new-content={hasNewContent ? 'true' : 'false'}
                aria-label={hasNewContent ? '有新内容，回到最新' : '回到最新'}
                onClick={scrollToLatest}
              >
                <JumpToLatestArrow />
              </button>
            )}
          </div>
        )}
    </>
  )
}
