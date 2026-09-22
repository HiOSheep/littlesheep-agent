import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  boundedDetail,
  failureFeedback,
  feedbackRole,
  FEEDBACK_DETAIL_LIMIT,
  isFailureFeedback,
  successFeedback,
  warningFeedback,
} from './feedback'

function readRendererFile(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

describe('feedback structure', () => {
  it('keeps the tone as a field instead of reading it out of the message', () => {
    const success = successFeedback('外部渠道已重新加载')
    const failure = failureFeedback('重新加载外部渠道失败', new Error('bridge closed'))

    expect(success.tone).toBe('success')
    expect(failure.tone).toBe('error')
    // The same wording would be indistinguishable by string matching.
    expect(successFeedback('操作已完成').tone).toBe('success')
    expect(failureFeedback('操作已完成', new Error('rejected')).tone).toBe('error')
  })

  it('maps the tone to the ARIA role and to the failure question', () => {
    expect(feedbackRole('error')).toBe('alert')
    expect(feedbackRole('warning')).toBe('status')
    expect(feedbackRole('success')).toBe('status')
    expect(feedbackRole('info')).toBe('status')

    expect(isFailureFeedback(failureFeedback('x', null))).toBe(true)
    expect(isFailureFeedback(warningFeedback('x'))).toBe(false)
    expect(isFailureFeedback(null)).toBe(false)
  })

  it('bounds long technical text and normalizes whitespace', () => {
    expect(boundedDetail('  line one\n\nline two  ')).toBe('line one line two')
    expect(boundedDetail(null)).toBeNull()
    expect(boundedDetail('')).toBeNull()
    expect(boundedDetail(new Error(''))).toBeNull()

    const long = boundedDetail('x'.repeat(2_000))
    expect(long).not.toBeNull()
    expect(long).toHaveLength(FEEDBACK_DETAIL_LIMIT)
    expect(long?.endsWith('…')).toBe(true)
  })

  it('keeps the user-readable fact separate from the Runtime text', () => {
    const entry = failureFeedback('压缩阈值未保存，仍在使用原来的比例', new Error('Runtime rejected the patch'))

    expect(entry.message).toBe('压缩阈值未保存，仍在使用原来的比例')
    expect(entry.detail).toBe('Runtime rejected the patch')
  })

  it('has no detail when there is nothing to disclose', () => {
    expect(successFeedback('已保存').detail).toBeNull()
    expect(warningFeedback('部分完成').detail).toBeNull()
  })
})

describe('feedback wiring', () => {
  it('never decides tone by parsing the message', async () => {
    const channels = await readRendererFile('../ChannelConnections.tsx')

    expect(channels).not.toContain("includes('失败')")
    expect(channels).toContain('failureFeedback(')
    expect(channels).toContain('successFeedback(')
    expect(channels).toContain('FeedbackNotice')
  })

  it('keeps a failed reload from leaving the older success line in place', async () => {
    const [channels, models] = await Promise.all([
      readRendererFile('../ChannelConnections.tsx'),
      readRendererFile('../settings/models.tsx'),
    ])

    // Channels: a successful reload replaces a failure, and a failed read
    // replaces whatever was shown before.
    expect(channels).toContain("setFeedback((current) => (current?.tone === 'error' ? null : current))")
    expect(channels).toContain("failureFeedback('读取渠道状态失败，当前列表可能不是最新的', e)")
    // Models: a failed reload clears an older success notice.
    expect(models).toContain('setNotice(null)\n      setError((e as Error).message)')
  })

  it('shows the threshold failure where the change was made', async () => {
    const [profile, workspace, overlays, runtimeActions] = await Promise.all([
      readRendererFile('../settings/agent-profile.tsx'),
      readRendererFile('../settings/workspace.tsx'),
      readRendererFile('../app-shell/overlays-view.tsx'),
      readRendererFile('../app-shell/runtime-actions.ts'),
    ])

    // The failure text travels back to the page instead of only reaching the
    // composer-level error line.
    expect(runtimeActions).toContain('async function applyRuntimePatchReporting(patch: RuntimePatch): Promise<string | null>')
    expect(runtimeActions).toContain('return message')
    expect(overlays).toContain('applyRuntimePatchReporting({ contextCompressionThresholdRatio: ratio })')
    expect(workspace).toContain('onContextCompressionThresholdChange: (ratio: number) => Promise<string | null>')
    expect(profile).toContain("failureFeedback('压缩阈值未保存，仍在使用原来的比例', failure)")
    expect(profile).toContain("successFeedback(`压缩阈值已保存为 ")
    expect(profile).toContain('retryLabel="重试保存"')
  })

  it('reports plugin operations through the shared notice with a retry', async () => {
    const plugins = await readRendererFile('../settings/plugins.tsx')

    expect(plugins).toContain('FeedbackNotice')
    expect(plugins).toContain("tone: 'error', message: '插件操作未完成'")
    expect(plugins).toContain('onRetry={error ? () => void loadStatus() : undefined}')
    expect(plugins).not.toContain('role="alert">{error}')
  })

  it('keeps the provider save failure in the editor with its detail collapsed', async () => {
    const editor = await readRendererFile('../settings/model-provider-editor.tsx')

    expect(editor).toContain("tone: 'error', message: '保存失败，内容仍保留在编辑器里'")
    expect(editor).toContain('detail: saveError')
    expect(editor).not.toContain('role="alert">保存失败：{saveError}')
  })

  it('renders the role and detail disclosure from the structure', async () => {
    const notice = await readRendererFile('./feedback-notice.tsx')

    expect(notice).toContain('role={feedbackRole(feedback.tone)}')
    expect(notice).toContain('data-tone={feedback.tone}')
    expect(notice).toContain('<summary>技术详情</summary>')
    expect(notice).toContain('disabled={busy}')
  })
})
