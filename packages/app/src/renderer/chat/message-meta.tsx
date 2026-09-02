import { memo, useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon } from '../ui/icons'

interface MessageMetaProps {
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
}

export const MessageMeta = memo(function MessageMeta({ role, text, timestamp }: MessageMetaProps) {
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

  return (
    <div className={`message-meta message-meta-${role}`}>
      <time dateTime={timestamp}>{formatMessageTime(timestamp)}</time>
      <button
        type="button"
        className="message-meta-copy"
        aria-label={copied ? '消息已复制' : '复制消息'}
        data-copied={copied ? 'true' : 'false'}
        onClick={() => void copyMessage()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  )
})

export function formatMessageTime(timestamp?: string): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
