// The HTML toolbar's 重新加载 reaches the browser tab that is showing the run page
// without a prop path across the tree; only the tab whose URL matches reacts.
import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { WORKSPACE_BROWSER_RELOAD_EVENT, requestWorkspaceBrowserReload } from './browser-reload'

/** The renderer's window, reduced to what the request needs. */
function installWindowStub() {
  const listeners = new Set<(event: Event) => void>()
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = {
    addEventListener: (type: string, handler: (event: Event) => void) => {
      if (type === WORKSPACE_BROWSER_RELOAD_EVENT) listeners.add(handler)
    },
    removeEventListener: (type: string, handler: (event: Event) => void) => {
      if (type === WORKSPACE_BROWSER_RELOAD_EVENT) listeners.delete(handler)
    },
    dispatchEvent: (event: Event) => {
      for (const handler of [...listeners]) handler(event)
      return true
    },
  }
  globals.CustomEvent = class<T> {
    readonly detail: T
    constructor(readonly type: string, init?: { detail?: T }) {
      this.detail = init?.detail as T
    }
  }
  return () => {
    delete globals.window
    delete globals.CustomEvent
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe('workspace browser reload request', () => {
  it('announces the URL it wants reloaded', () => {
    cleanups.push(installWindowStub())
    const seen: string[] = []
    const listener = (event: Event) => seen.push((event as unknown as { detail: { url: string } }).detail.url)
    window.addEventListener(WORKSPACE_BROWSER_RELOAD_EVENT, listener)
    try {
      expect(requestWorkspaceBrowserReload('http://127.0.0.1:1234/token/game.html')).toBe(true)
      expect(requestWorkspaceBrowserReload('   ')).toBe(false)
    } finally {
      window.removeEventListener(WORKSPACE_BROWSER_RELOAD_EVENT, listener)
    }
    expect(seen).toEqual(['http://127.0.0.1:1234/token/game.html'])
  })

  it('is what the run hook and the browser both use', async () => {
    const hook = await source('./use-html-run.ts')
    const browser = await source('./browser.tsx')
    const actions = await source('./preview-actions.tsx')

    // Saving a previewed page asks the tab showing that URL to reload, so the tab does not keep the
    // version from before the save.
    expect(hook).toContain('requestWorkspaceBrowserReload(state.url)')
    expect(hook).toContain("state.status === 'running'")
    // The browser compares its own URL before reloading, so other tabs are untouched.
    expect(browser).toContain('WORKSPACE_BROWSER_RELOAD_EVENT')
    expect(browser).toContain('requested !== url')
    expect(browser).toContain('reload()')
    // The toolbar no longer carries run controls, and it no longer carries the page's two
    // destinations either: both live in the "打开方式" menu (asked for 2026-10-03), so the row itself
    // keeps only the actions that change what the pane shows.
    expect(actions).not.toContain('重新加载')
    expect(actions).not.toContain('disabled={!run.reload}')
    expect(actions).toMatch(/id: HTML_BROWSER_IN_APP_ID,[\s\S]{0,120}label: '应用内浏览器'/u)
    expect(actions).toMatch(/id: HTML_BROWSER_EXTERNAL_ID,[\s\S]{0,120}label: '系统浏览器'/u)
    expect(actions).not.toMatch(/className="workspace-files-text-btn"[\s\S]{0,200}浏览器/u)
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
