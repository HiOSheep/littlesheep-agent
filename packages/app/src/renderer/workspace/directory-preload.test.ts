import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceFileTabId } from '../workspace-persistence'

vi.mock('./directory-cache', () => ({
  preloadWorkspaceDirectory: vi.fn(async () => ({ path: '' })),
}))

import {
  WORKSPACE_FILE_NAVIGATOR_COLLAPSED_KEY,
  WORKSPACE_PANEL_COLLAPSED_KEY,
  WORKSPACE_PANEL_OPEN_ROOT_KEY,
  WORKSPACE_PANEL_OPEN_TABS_KEY,
  WORKSPACE_PANEL_TAB_KEY,
} from '../app-shell/preferences'
import { preloadPersistedWorkspaceDirectory } from './directory-preload'
import { preloadWorkspaceDirectory } from './directory-cache'

describe('persisted workspace directory preload', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: createStorage() })
    vi.mocked(preloadWorkspaceDirectory).mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts the visible navigator root before React mounts', async () => {
    seedVisibleNavigator('artifacts', 'D:\\work')

    await preloadPersistedWorkspaceDirectory()

    expect(preloadWorkspaceDirectory).toHaveBeenCalledOnce()
    expect(preloadWorkspaceDirectory).toHaveBeenCalledWith('D:\\work')
  })

  it('uses an active file tab root without relying on the recent path', async () => {
    const tab = workspaceFileTabId('E:\\external', 'E:\\external\\src\\sample.ts')
    seedVisibleNavigator(tab, 'D:\\old-root')

    await preloadPersistedWorkspaceDirectory()

    expect(preloadWorkspaceDirectory).toHaveBeenCalledWith('E:\\external')
  })

  it.each([
    ['review tab', { tab: 'review' }],
    ['collapsed panel', { panelCollapsed: 'true' }],
    ['collapsed navigator', { navigatorCollapsed: 'true' }],
    ['closed active tab', { openTabs: JSON.stringify(['review']) }],
  ])('does not scan directories for a %s', async (_label, override) => {
    seedVisibleNavigator('artifacts', 'D:\\work')
    applyPreferenceOverride(override)

    await preloadPersistedWorkspaceDirectory()

    expect(preloadWorkspaceDirectory).not.toHaveBeenCalled()
  })
})

function seedVisibleNavigator(tab: string, root: string): void {
  window.localStorage.setItem(WORKSPACE_PANEL_COLLAPSED_KEY, 'false')
  window.localStorage.setItem(WORKSPACE_FILE_NAVIGATOR_COLLAPSED_KEY, 'false')
  window.localStorage.setItem(WORKSPACE_PANEL_TAB_KEY, tab)
  window.localStorage.setItem(WORKSPACE_PANEL_OPEN_TABS_KEY, JSON.stringify([tab]))
  window.localStorage.setItem(WORKSPACE_PANEL_OPEN_ROOT_KEY, root)
}

function applyPreferenceOverride(override: {
  tab?: string
  panelCollapsed?: string
  navigatorCollapsed?: string
  openTabs?: string
}): void {
  if (override.tab) window.localStorage.setItem(WORKSPACE_PANEL_TAB_KEY, override.tab)
  if (override.panelCollapsed) {
    window.localStorage.setItem(WORKSPACE_PANEL_COLLAPSED_KEY, override.panelCollapsed)
  }
  if (override.navigatorCollapsed) {
    window.localStorage.setItem(WORKSPACE_FILE_NAVIGATOR_COLLAPSED_KEY, override.navigatorCollapsed)
  }
  if (override.openTabs) window.localStorage.setItem(WORKSPACE_PANEL_OPEN_TABS_KEY, override.openTabs)
}

function createStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  }
}
