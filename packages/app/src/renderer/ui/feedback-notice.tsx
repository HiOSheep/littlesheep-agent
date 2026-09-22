// One place that renders the shared feedback structure.
//
// The tone field decides the ARIA role and the surface color; callers never
// encode state in prose. A pending operation disables the retry action so the
// same transaction cannot be submitted twice, and the technical detail stays
// collapsed until the user asks for it.
import { feedbackRole, type Feedback } from './feedback'

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
    >
      <span className="feedback-message">{feedback.message}</span>
      {onRetry && (
        <button className="feedback-action" type="button" disabled={busy} onClick={onRetry}>
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
