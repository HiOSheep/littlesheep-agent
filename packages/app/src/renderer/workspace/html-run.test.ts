import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  IDLE_HTML_RUN,
  htmlRunActions,
  htmlRunBusy,
  htmlRunFeedback,
  type HtmlRunState,
} from './html-run'

const running: HtmlRunState = { status: 'running', url: 'http://127.0.0.1:1/token/game.html', message: '' }

describe('workspace html run state', () => {
  it('offers run, reload, stop and a busy label per state', () => {
    expect(htmlRunActions(IDLE_HTML_RUN)).toEqual({ run: true, reload: false, stop: false, label: '运行' })
    expect(htmlRunActions({ status: 'starting', url: '', message: '' })).toEqual({ run: false, reload: false, stop: false, label: '正在启动…' })
    // Running: the served files may have changed on disk, so reload is the useful
    // action, and a second run is not offered (it would only pile up browser tabs).
    expect(htmlRunActions(running)).toEqual({ run: false, reload: true, stop: true, label: '运行' })
    expect(htmlRunActions({ status: 'stopped', url: '', message: '' })).toEqual({ run: true, reload: false, stop: false, label: '运行' })
    expect(htmlRunActions({ status: 'failed', url: '', message: 'boom' })).toEqual({ run: true, reload: false, stop: false, label: '重试运行' })
  })

  it('reports the run fact, the stopped fact and the failure with its reason', () => {
    expect(htmlRunFeedback(IDLE_HTML_RUN)).toBeNull()
    expect(htmlRunFeedback(running)?.tone).toBe('success')
    expect(htmlRunFeedback(running)?.message).toContain('隔离的本地地址')
    expect(htmlRunFeedback({ status: 'stopped', url: '', message: '' })?.tone).toBe('warning')
    expect(htmlRunFeedback({ status: 'stopped', url: '', message: '' })?.message).toContain('已停止')
    const failed = htmlRunFeedback({ status: 'failed', url: '', message: 'port busy' })
    expect(failed?.tone).toBe('error')
    expect(failed?.detail).toBe('port busy')
    expect(htmlRunBusy({ status: 'starting', url: '', message: '' })).toBe(true)
    expect(htmlRunBusy(running)).toBe(false)
  })

  it('drives the toolbar from this state instead of ad-hoc flags', async () => {
    const actions = await source('./preview-actions.tsx')
    const pane = await source('./preview-pane.tsx')
    const hook = await source('./use-html-run.ts')
    const notice = await source('./html-run-notice.tsx')

    expect(actions).toContain('htmlRunActions(htmlRun)')
    expect(actions).toContain('onRunHtml')
    // The toolbar itself never grows a save affordance; the question lives in the
    // notice the pane renders (markdown-preview.test.ts guards the same rule).
    expect(actions).not.toContain('保存')
    expect(notice).toContain('有未保存的修改。运行使用磁盘上的已保存版本。')
    expect(notice).toContain('保存并运行')
    expect(pane).toContain('<HtmlRunNotice')
    // Running uses the saved file: a dirty draft asks first, a failed save never runs.
    expect(hook).toContain('if (dirty) {')
    expect(hook).toContain('const saved = await saveDraft()')
    expect(hook).toContain('if (!saved) return')
    expect(hook).toContain('onOpenBrowserTab(next.url)')
    expect(hook).toContain('startHtmlRun(workspacePath, filePath)')
    expect(hook).toContain('stopHtmlRun(workspacePath)')
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
