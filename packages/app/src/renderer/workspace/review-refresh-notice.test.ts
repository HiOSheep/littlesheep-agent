import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { boundedDetail, isFailureFeedback } from '../ui/feedback'
import { reviewDiffNotice, reviewNotices, reviewSnapshotNotice } from './review-refresh-notice'

const GENERATED_AT = '2026-09-25T09:30:00.000Z'
const GENERATED_AT_TEXT = new Date(GENERATED_AT).toLocaleString('zh-CN')

describe('workspace review refresh notices', () => {
  it('marks a snapshot that raced with a change instead of passing it off as settled', () => {
    // UX-27 item 2: Main re-reads while the repository changes; if even the bounded
    // retries race, the data still shows but is labelled.
    const racing = reviewSnapshotNotice({ error: '', refreshing: false, hasResult: true, unstable: true })
    expect(racing?.tone).toBe('warning')
    expect(racing?.message).toContain('仓库在读取期间仍在变化')
    // A settled read stays silent.
    expect(reviewSnapshotNotice({ error: '', refreshing: false, hasResult: true })).toBeNull()
    expect(reviewSnapshotNotice({ error: '', refreshing: false, hasResult: true, unstable: false })).toBeNull()
  })
  it('labels a cached snapshot failure as stale instead of a refresh success', () => {
    const notice = reviewSnapshotNotice({
      error: 'Local app API error: 500',
      refreshing: false,
      hasResult: true,
      generatedAt: GENERATED_AT,
    })

    expect(notice?.tone).toBe('error')
    expect(isFailureFeedback(notice)).toBe(true)
    expect(notice?.message).toContain('Git 更改更新失败，显示上次结果')
    expect(notice?.message).toContain(GENERATED_AT_TEXT)
    expect(notice?.detail).toBe('Local app API error: 500')
  })

  it('stays silent when a first snapshot read fails, because the surface says it', () => {
    expect(reviewSnapshotNotice({
      error: 'Local app API error: 500',
      refreshing: false,
      hasResult: false,
      generatedAt: GENERATED_AT,
    })).toBeNull()
  })

  it('reports an in-flight snapshot refresh over the previous result', () => {
    const notice = reviewSnapshotNotice({
      error: '',
      refreshing: true,
      hasResult: true,
      generatedAt: GENERATED_AT,
    })

    expect(notice?.tone).toBe('info')
    expect(isFailureFeedback(notice)).toBe(false)
    expect(notice?.message).toBe('正在刷新 Git 更改，当前显示上次结果。')
    expect(reviewSnapshotNotice({ error: '', refreshing: true, hasResult: false })).toBeNull()
    expect(reviewSnapshotNotice({ error: '', refreshing: false, hasResult: true })).toBeNull()
  })

  it('separates a stale diff from a first diff failure', () => {
    const stale = reviewDiffNotice({ error: 'Local app API error: 500', outdated: false, loading: false, hasResult: true })
    const first = reviewDiffNotice({ error: 'Local app API error: 500', outdated: false, loading: false, hasResult: false })

    expect(stale?.tone).toBe('error')
    expect(stale?.message).toBe('差异更新失败，显示上次结果。')
    expect(stale?.detail).toBe('Local app API error: 500')
    expect(first?.tone).toBe('error')
    expect(first?.message).toBe('差异读取失败。')
    expect(first?.message).not.toContain('显示上次结果')
  })

  it('marks a diff that belongs to the previous revision while it reloads', () => {
    const notice = reviewDiffNotice({ error: '', outdated: true, loading: false, hasResult: true })

    expect(notice?.tone).toBe('info')
    expect(isFailureFeedback(notice)).toBe(false)
    expect(notice?.message).toContain('正在重新读取')
    // A quiet first read is the placeholder's job, not the notice's.
    expect(reviewDiffNotice({ error: '', outdated: false, loading: true, hasResult: false })).toBeNull()
    expect(reviewDiffNotice({ error: '', outdated: false, loading: true, hasResult: true })?.message)
      .toBe('正在刷新文件差异，当前显示上次结果。')
  })

  it('bounds the Runtime text it passes to the shared detail disclosure', () => {
    const long = 'x'.repeat(900)
    const notice = reviewSnapshotNotice({ error: long, refreshing: false, hasResult: true })

    expect(notice?.detail).toBe(boundedDetail(long))
    expect(notice?.detail?.length).toBe(400)
  })

  it('orders both surfaces, attaches each action to its own notice and never to a status', () => {
    const onRetrySnapshot = vi.fn()
    const onRetryDiff = vi.fn()
    const notices = reviewNotices({
      snapshot: { error: 'snapshot down', refreshing: false, hasResult: true, generatedAt: GENERATED_AT },
      diff: { error: '', outdated: true, loading: false, hasResult: true },
      onRetrySnapshot,
      onRetryDiff,
    })

    expect(notices.map((entry) => entry.key)).toEqual(['snapshot', 'diff'])
    expect(notices[0]?.retry).toBe(true)
    expect(notices[0]?.retryLabel).toBe('重试刷新')
    expect(notices[1]?.retry).toBe(false)
    expect(notices[1]?.retryLabel).toBe('重试差异')
    // Each notice reports its own surface's in-flight state, so one retry button
    // is never disabled by the other surface's request.
    expect(notices[0]?.busy).toBe(false)
    expect(notices[1]?.busy).toBe(false)

    notices[0]?.onRetry?.()
    expect(onRetrySnapshot).toHaveBeenCalledTimes(1)
    expect(onRetryDiff).not.toHaveBeenCalled()
    // A status notice ("still reading the previous revision") offers nothing to press.
    expect(notices[1]?.onRetry).toBeUndefined()
    expect(reviewNotices({
      snapshot: { error: '', refreshing: false, hasResult: true },
      diff: { error: '', outdated: false, loading: false, hasResult: true },
      onRetrySnapshot,
      onRetryDiff,
    })).toEqual([])
  })

  it('renders both surfaces through the shared feedback structure', async () => {
    const review = await source('./review.tsx')
    const reviewDiff = await source('./review-diff.tsx')

    // The notices come from the pure policy module; the view only wires actions.
    expect(review).toContain('reviewNotices({')
    expect(review).toContain('onRetrySnapshot: () => requestSnapshotRefresh(true)')
    expect(review).toContain('onRetryDiff: () => setDiffRetryVersion((version) => version + 1)')
    expect(reviewDiff).toContain("import { FeedbackNotice } from '../ui/feedback-notice'")
    expect(reviewDiff).toContain('feedback={notice.feedback}')
    expect(reviewDiff).toContain('className="workspace-review-update-notice"')
    // A previously loaded diff survives a failed refresh instead of being cleared.
    expect(review).not.toContain('setDiff(null)\n          setDiffError')
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
