// Turns Git review request outcomes into the shared feedback structure.
//
// The review surface deliberately keeps the last successful snapshot and diff on
// screen while a refresh runs or fails. That is only honest when the stale
// content says so, so the wording lives in one place and the tone is a field
// instead of something a view has to read out of the prose. A failure with
// nothing to fall back on stays silent here: the surface placeholder already
// owns that state, and a second copy would only say it twice.
import { feedback, isFailureFeedback, type Feedback } from '../ui/feedback'

export interface WorkspaceReviewNotice {
  key: 'snapshot' | 'diff'
  feedback: Feedback
  retryLabel: string
  /** The failure paths are the only ones that offer a retry action. */
  retry: boolean
  /** True while that surface already has a request in flight. */
  busy: boolean
  /** Filled in by the view that owns the action, so this module stays pure. */
  onRetry?: () => void
}

export interface ReviewSnapshotNoticeInput {
  /** Runtime text from the failed refresh; empty when the last refresh succeeded. */
  error: string
  refreshing: boolean
  /** A previously loaded snapshot is still on screen. */
  hasResult: boolean
  /** `generatedAt` of that snapshot, so stale content can name its own age. */
  generatedAt?: string
  /**
   * The repository changed during every bounded read attempt (UX-27 item 2), so this
   * snapshot may mix two states. It is shown — hiding real data would be worse — but it
   * says what it is instead of passing as a settled read.
   */
  unstable?: boolean
}

export interface ReviewDiffNoticeInput {
  error: string
  outdated: boolean
  loading: boolean
  /** A previously loaded diff is still on screen. */
  hasResult: boolean
}

export function reviewNotices(input: {
  snapshot: ReviewSnapshotNoticeInput
  diff: ReviewDiffNoticeInput
  onRetrySnapshot: () => void
  onRetryDiff: () => void
}): WorkspaceReviewNotice[] {
  const notices: WorkspaceReviewNotice[] = []
  const snapshot = reviewSnapshotNotice(input.snapshot)
  if (snapshot) {
    const retry = isFailureFeedback(snapshot)
    notices.push({
      key: 'snapshot',
      feedback: snapshot,
      retryLabel: '重试刷新',
      retry,
      busy: input.snapshot.refreshing,
      onRetry: retry ? input.onRetrySnapshot : undefined,
    })
  }
  const diff = reviewDiffNotice(input.diff)
  if (diff) {
    const retry = isFailureFeedback(diff)
    notices.push({
      key: 'diff',
      feedback: diff,
      retryLabel: '重试差异',
      retry,
      busy: input.diff.loading,
      onRetry: retry ? input.onRetryDiff : undefined,
    })
  }
  return notices
}

export function reviewSnapshotNotice(input: ReviewSnapshotNoticeInput): Feedback | null {
  if (input.error) {
    if (!input.hasResult) return null
    return feedback(
      'error',
      `Git 更改更新失败，显示上次结果${lastSuccessSuffix(input.generatedAt)}。`,
      input.error,
    )
  }
  if (input.unstable) {
    return feedback(
      'warning',
      '仓库在读取期间仍在变化，这份更改列表可能混合了两个状态；刷新会重新读取。',
    )
  }
  return input.refreshing && input.hasResult
    ? feedback('info', '正在刷新 Git 更改，当前显示上次结果。')
    : null
}

export function reviewDiffNotice(input: ReviewDiffNoticeInput): Feedback | null {
  if (input.error) {
    return feedback(
      'error',
      input.hasResult ? '差异更新失败，显示上次结果。' : '差异读取失败。',
      input.error,
    )
  }
  if (input.outdated) return feedback('info', '快照已变化，当前差异属于上次结果，正在重新读取。')
  return input.loading && input.hasResult
    ? feedback('info', '正在刷新文件差异，当前显示上次结果。')
    : null
}

function lastSuccessSuffix(generatedAt?: string): string {
  if (!generatedAt) return ''
  const time = new Date(generatedAt)
  return Number.isNaN(time.getTime()) ? '' : `（上次成功读取：${time.toLocaleString('zh-CN')}）`
}
