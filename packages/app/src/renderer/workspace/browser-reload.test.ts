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
    // The toolbar no longer carries run controls: the service starts with the preview, and the only
    // page actions left are where to open it.
    expect(actions).not.toContain('重新加载')
    expect(actions).not.toContain('disabled={!run.reload}')
    expect(actions).toContain('应用内浏览器')
    expect(actions).toContain('系统浏览器')
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
