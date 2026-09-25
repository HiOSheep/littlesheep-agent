import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { BrowserDiagnostics } from '../api/browser'
import { summarizeBrowserDiagnostics } from './run-diagnostics'

const empty: BrowserDiagnostics = {
  entries: [],
  counts: { script: 0, resource: 0, navigation: 0, console: 0 },
  revision: 0,
}

describe('workspace run diagnostics', () => {
  it('summarizes only what the user has to react to', () => {
    expect(summarizeBrowserDiagnostics(null)).toBe('')
    expect(summarizeBrowserDiagnostics(empty)).toBe('')
    expect(summarizeBrowserDiagnostics({
      ...empty,
      counts: { script: 2, resource: 1, navigation: 0, console: 5 },
    })).toBe('脚本报错 2 · 资源失败 1')
    expect(summarizeBrowserDiagnostics({
      ...empty,
      counts: { script: 0, resource: 0, navigation: 1, console: 0 },
    })).toBe('页面加载失败 1')
  })

  it('is wired to Main\'s record instead of re-parsing the page', async () => {
    const component = await source('./run-diagnostics.tsx')
    const client = await source('../api/browser.ts')
    const notice = await source('./html-run-notice.tsx')
    const routes = await source('../../shared/local-app-api-routes.ts')

    expect(routes).toContain("browserDiagnostics: '/browser/diagnostics'")
    expect(client).toContain('LOCAL_APP_API_ROUTES.browserDiagnostics')
    expect(component).toContain('getBrowserDiagnostics(url)')
    expect(component).toContain('POLL_INTERVAL_MS')
    // The readout belongs to a run: while nothing runs there is nothing to report.
    expect(notice).toContain("run.status === 'running' && run.url")
    expect(notice).toContain('<WorkspaceRunDiagnostics url={run.url} />')
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
