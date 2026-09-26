import { memo, useEffect, useRef, useState } from 'react'
import { BranchIcon, CheckIcon, CopyIcon } from '../ui/icons'

interface MessageMetaProps {
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
  /** Forks the conversation at this message; absent for messages that cannot branch yet. */
  onBranch?: () => void
  branching?: boolean
}

export const MessageMeta = memo(function MessageMeta({
  role,
  text,
  timestamp,
  onBranch,
  branching = false,
}: MessageMetaProps) {
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number>()

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), [])

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return
    }
    setCopied(true)
    window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1200)
  }

  // The assistant's own reply leads with its controls, the reader's message ends with them, so the
  // row always reads away from the bubble it belongs to: [copy][branch][time] on the left for the
  // agent, [time][branch][copy] on the right for the user.
  return (
    <div className={`message-meta message-meta-${role}`}>
      <button
        type="button"
        className="message-meta-copy"
        aria-label={copied ? '消息已复制' : '复制消息'}
        data-copied={copied ? 'true' : 'false'}
        onClick={() => void copyMessage()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      {onBranch && (
        <button
          type="button"
          className="message-meta-branch"
          aria-label="从这里分叉对话"
          title="从这里分叉：复制这段对话到新分支后继续"
          disabled={branching}
          onClick={() => onBranch()}
        >
          <BranchIcon />
        </button>
      )}
      <time dateTime={timestamp}>{formatMessageTime(timestamp)}</time>
    </div>
  )
})

export function formatMessageTime(timestamp?: string): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
