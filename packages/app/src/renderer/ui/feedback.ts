// Small feedback structure shared by settings-style operations.
//
// Tone is a field, never parsed out of the message: a caller that knows an
// operation failed says so, and no view has to guess from wording. Long
// technical text is bounded here and only expanded on demand by the view, so a
// 4 KiB Runtime error cannot push the next step off the page.

export type FeedbackTone = 'info' | 'success' | 'warning' | 'error'

export interface Feedback {
  tone: FeedbackTone
  /** What happened, in the user's words, without inventing a cause. */
  message: string
  /** Bounded technical text, shown behind a disclosure. */
  detail: string | null
}

export const FEEDBACK_DETAIL_LIMIT = 400

export function feedback(tone: FeedbackTone, message: string, detail?: unknown): Feedback {
  return { tone, message, detail: boundedDetail(detail) }
}

export function successFeedback(message: string, detail?: unknown): Feedback {
  return feedback('success', message, detail)
}

export function warningFeedback(message: string, detail?: unknown): Feedback {
  return feedback('warning', message, detail)
}

/** A failure keeps the user-readable fact and the Runtime text as detail. */
export function failureFeedback(message: string, cause: unknown): Feedback {
  return feedback('error', message, cause)
}

export function feedbackRole(tone: FeedbackTone): 'alert' | 'status' {
  return tone === 'error' ? 'alert' : 'status'
}

export function isFailureFeedback(entry: Feedback | null): boolean {
  return entry?.tone === 'error'
}

/** Bounded, whitespace-normalized technical text; null when there is none. */
export function boundedDetail(value: unknown, limit = FEEDBACK_DETAIL_LIMIT): string | null {
  if (value === null || value === undefined) return null
  const raw = value instanceof Error ? value.message : String(value)
  const normalized = raw.replace(/\s+/gu, ' ').trim()
  if (!normalized) return null
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}
