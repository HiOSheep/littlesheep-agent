// One place that renders the shared feedback structure.
//
// The tone field decides the ARIA role, the surface color and the mark; callers
// never encode state in prose. Every tone carries its own glyph as well as its
// own words, so a failure stays readable without relying on the red tint. A
// pending operation disables the retry action - and says why through its own
// accessible name - so the same transaction cannot be submitted twice, and the
// technical detail stays collapsed until the user asks for it.
import { feedbackRole, type Feedback, type FeedbackTone } from './feedback'
import { FailureIcon, InfoIcon, SuccessIcon, WarningIcon } from './state-icons'

export function FeedbackNotice({
  feedback,
  className = 'dialog-hint',
  busy = false,
  retryLabel = '重试',
  onRetry,
}: {
  feedback: Feedback | null
  className?: string
  busy?: boolean
  retryLabel?: string
  onRetry?: () => void
}) {
  if (!feedback) return null
  return (
    <div
      className={`feedback-notice ${className}`.trim()}
      data-tone={feedback.tone}
      role={feedbackRole(feedback.tone)}
      aria-busy={busy ? true : undefined}
    >
      <span className="feedback-icon" aria-hidden="true">{toneIcon(feedback.tone)}</span>
      <span className="feedback-message">{feedback.message}</span>
      {onRetry && (
        <button
          className="feedback-action"
          type="button"
          disabled={busy}
          title={busy ? '上一次操作还在进行，完成或失败后可以重试' : undefined}
          onClick={onRetry}
        >
          {retryLabel}
        </button>
      )}
      {feedback.detail && (
        <details className="feedback-detail">
          <summary>技术详情</summary>
          <pre>{feedback.detail}</pre>
        </details>
      )}
    </div>
  )
}

/** The mark is the tone's own shape: crossed circle, triangle, tick, or "i". */
function toneIcon(tone: FeedbackTone) {
  if (tone === 'error') return <FailureIcon />
  if (tone === 'warning') return <WarningIcon />
  if (tone === 'success') return <SuccessIcon />
  return <InfoIcon />
}
