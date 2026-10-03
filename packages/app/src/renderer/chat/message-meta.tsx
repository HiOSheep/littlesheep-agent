import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { BranchIcon, CheckIcon, CopyIcon } from '../ui/icons'

interface MessageMetaProps {
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
  /** Forks the conversation at this message; absent for messages that cannot branch yet. */
  onBranch?: () => void
  branching?: boolean
  usageAction?: ReactNode
}

/** How long the copy control reports a success before it goes back to its idle mark. */
const COPY_CONFIRMATION_MS = 1200

export const MessageMeta = memo(function MessageMeta({
  role,
  text,
  timestamp,
  onBranch,
  branching = false,
  usageAction,
}: MessageMetaProps) {
  // `failed` is a state of its own, not "not yet copied": a clipboard write that was refused has to
  // say so and stay said, because the reader's next action is to retry (or to copy by hand).
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copiedTimerRef = useRef<number>()

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), [])

  async function copyMessage() {
    window.clearTimeout(copiedTimerRef.current)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // The write is the only thing that proves the text reached the clipboard, so a refusal is
      // reported where the action was taken instead of returning silently.
      setCopyState('failed')
      return
    }
    setCopyState('copied')
    copiedTimerRef.current = window.setTimeout(() => setCopyState('idle'), COPY_CONFIRMATION_MS)
  }

  // The assistant's own reply leads with its controls, the reader's message ends with them, so the
  // row always reads away from the bubble it belongs to: [copy][branch][usage][time] on the left for the
  // agent, [time][branch][copy] on the right for the user.
  //
  // A refused copy is reported *beside* the row rather than inside it: the row is a hover surface
  // (`opacity: 0` until the pointer or focus is on it, see the stylesheet's contract), and a failure
  // that vanishes when the pointer leaves is not feedback. The note and its retry therefore keep
  // their own line until the next attempt succeeds.
  return (
    <>
      <div className={`message-meta message-meta-${role}`}>
        <button
          type="button"
          className="message-meta-copy"
          aria-label={copyState === 'copied' ? '消息已复制' : copyState === 'failed' ? '复制失败，重试复制' : '复制消息'}
          data-copied={copyState === 'copied' ? 'true' : 'false'}
          data-copy-state={copyState}
          disabled={!text.trim()}
          onClick={() => void copyMessage()}
        >
          {copyState === 'copied' ? <CheckIcon /> : <CopyIcon />}
        </button>
        {onBranch && (
          <button
            type="button"
            className="message-meta-branch"
            aria-label="从这里分叉对话"
            disabled={branching}
            onClick={() => onBranch()}
          >
            <BranchIcon />
          </button>
        )}
        {role === 'assistant' && usageAction}
        <time dateTime={timestamp}>{formatMessageTime(timestamp)}</time>
      </div>
      {copyState === 'failed' && (
        <div className="message-copy-failed-row">
          <span className="message-copy-failed" role="status">复制失败</span>
          <button
            type="button"
            className="message-copy-retry"
            onClick={() => void copyMessage()}
          >
            重试
          </button>
        </div>
      )}
    </>
  )
})

export function formatMessageTime(timestamp?: string): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
