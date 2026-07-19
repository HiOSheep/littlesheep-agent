import { describe, expect, it } from 'vitest'
import {
  MAX_WORKSPACE_BROWSER_TABS,
  createNewWorkspaceBrowserTab,
  createWorkspaceBrowserTab,
  hydrateWorkspaceBrowserTabs,
  isWorkspaceBrowserTabId,
  serializeWorkspaceBrowserTabs,
} from './browser-tabs'

describe('embedded browser tabs', () => {
  it('keeps a stable default tab and bounded persisted metadata', () => {
    const tabs = hydrateWorkspaceBrowserTabs(Array.from({ length: MAX_WORKSPACE_BROWSER_TABS + 4 }, (_, index) => ({
      id: `browser:tab-${index}`,
      title: `tab-${index}`,
      url: `https://example.test/${index}`,
      history: { entries: [`https://example.test/${index}`], index: 0 },
    })))

    expect(tabs).toHaveLength(MAX_WORKSPACE_BROWSER_TABS)
    expect(tabs[0]?.id).toBe('browser')
    expect(isWorkspaceBrowserTabId(tabs[1]?.id)).toBe(true)
  })

  it('normalizes the active URL and retains a bounded history', () => {
    const tab = createWorkspaceBrowserTab('https://example.test/start')
    const [restored] = hydrateWorkspaceBrowserTabs([{
      ...tab,
      history: {
        entries: ['https://example.test/one', 'javascript:alert(1)', 'https://example.test/two'],
        index: 1,
      },
    }])

    expect(restored?.history.entries).toEqual([
      'https://example.test/one',
      'https://example.test/two',
      'https://example.test/start',
    ])
    expect(restored?.url).toBe('https://example.test/two')
  })

  it('creates unique child tabs without sharing navigation state', () => {
    const first = createNewWorkspaceBrowserTab('https://example.test/a')
    const second = createNewWorkspaceBrowserTab('https://example.test/b')
    expect(first.id).not.toBe(second.id)
    expect(first.history).not.toBe(second.history)
    expect(serializeWorkspaceBrowserTabs([first, second])).toHaveLength(3)
  })

  it('removes adjacent fine-grained page states while hydrating persisted tabs', () => {
    const tab = createWorkspaceBrowserTab('https://www.bilibili.com/video/BV1PXNZ6DEx4')
    const [restored] = hydrateWorkspaceBrowserTabs([{
      ...tab,
      history: {
        entries: [
          'https://www.bilibili.com/video/BV1PXNZ6DEx4',
          'https://www.bilibili.com/video/BV1PXNZ6DEx4#reply-1',
          'https://www.bilibili.com/video/BV1xx411c7mD',
        ],
        index: 1,
      },
    }])

    expect(restored?.history.entries).toEqual([
      'https://www.bilibili.com/video/BV1PXNZ6DEx4#reply-1',
      'https://www.bilibili.com/video/BV1xx411c7mD',
    ])
    expect(restored?.history.index).toBe(0)
  })
})
