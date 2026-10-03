import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { IDLE_HTML_RUN, htmlRunBusy, htmlRunFeedback, type HtmlRunState } from './html-run'

const running: HtmlRunState = { status: 'running', url: 'http://127.0.0.1:1/token/game.html', message: '' }

describe('workspace html run state', () => {
  it('says nothing while a run is healthy and reports only a failure', () => {
    // A healthy run is silent: the served page is the answer, and a success banner (or a standing
    // "no errors" line) over every preview is exactly the extra label ordinary use should not
    // carry (reported 2026-10-02).
    expect(htmlRunFeedback(IDLE_HTML_RUN)).toBeNull()
    expect(htmlRunFeedback(running)).toBeNull()
    expect(htmlRunFeedback({ status: 'starting', url: '', message: '' })).toBeNull()
    expect(htmlRunFeedback({ status: 'stopped', url: '', message: '' })).toBeNull()
    const failed = htmlRunFeedback({ status: 'failed', url: '', message: 'port busy' })
    expect(failed?.tone).toBe('error')
    expect(failed?.detail).toBe('port busy')
    expect(htmlRunBusy({ status: 'starting', url: '', message: '' })).toBe(true)
    expect(htmlRunBusy(running)).toBe(false)
  })

  it('keeps the run notice a bar, so the served page keeps the body', async () => {
    const styles = await source('../styles/04-workspace.css')
    const start = styles.indexOf('\n.workspace-preview-run {')
    expect(start, '.workspace-preview-run must exist').toBeGreaterThan(-1)
    const rule = styles.slice(start, styles.indexOf('}', start))

    // It used to grow (`flex: 1 1 100%`) because the running page lived in a browser tab and the
    // notice was the only thing in the body; with the page rendered in that body, the growing bar
    // centred itself and pushed the frame to the bottom (reported 2026-10-02 on 2048.html).
    expect(rule).toContain('flex: 0 0 auto;')
    expect(rule).not.toContain('1 1 100%')
  })

  it('starts with the preview, never navigates on its own, and only offers where to open it', async () => {
    const actions = await source('./preview-actions.tsx')
    const pane = await source('./preview-pane.tsx')
    const hook = await source('./use-html-run.ts')
    const notice = await source('./html-run-notice.tsx')
    const surface = await source('./html-preview-surface.tsx')

    // The service is a consequence of previewing an HTML file, not a button: the hook starts it when
    // the file becomes the preview and releases it when the preview moves on. A save keeps the same
    // URL (a browser tab may be pointing at it) and reloads the surfaces instead.
    expect(hook).toContain('void startHtmlRun(workspacePath, filePath)')
    expect(hook).toContain('void stopHtmlRun(workspacePath)')
    expect(hook).toContain('}, [filePath, isHtml, workspacePath])')
    expect(hook).toContain('requestWorkspaceBrowserReload(state.url)')
    // Nothing jumps to a browser tab by itself any more, and no draft is asked about first.
    expect(hook).not.toContain('onOpenBrowserTab')
    expect(hook).not.toContain('dirty')

    // The HTML surface runs the served page in place, isolated to the loopback origin it is served
    // from; the pane only hands it the URL and the timestamp that re-keys it on save.
    expect(pane).toContain("liveUrl={htmlRun.state.status === 'running' ? htmlRun.state.url : ''}")
    expect(surface).toContain('className="workspace-preview-html-live"')
    expect(surface).toContain('sandbox="allow-scripts allow-same-origin allow-forms allow-modals"')
    expect(pane).toContain('void openExternalHref(htmlRun.state.url)')
    expect(pane).toContain('onOpenBrowserTab(htmlRun.state.url)')

    // The toolbar only decides where the already-running page opens next, and it does that from the
    // "打开方式" menu (asked for 2026-10-03) instead of two labelled buttons of its own.
    expect(actions).toMatch(/id: HTML_BROWSER_IN_APP_ID,[\s\S]{0,120}label: '应用内浏览器'/u)
    expect(actions).toMatch(/id: HTML_BROWSER_EXTERNAL_ID,[\s\S]{0,120}label: '系统浏览器'/u)
    expect(actions).not.toContain('重新加载')
    expect(actions).not.toContain('停止')
    // It still owns no save affordance; that note lives in the notice the pane renders.
    expect(actions).not.toContain('保存')
    expect(notice).toContain('页面运行的是磁盘上的已保存版本；保存后会自动重新加载。')
    expect(pane).toContain('<HtmlRunNotice')
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
