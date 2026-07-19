// Persistence boundary for the bounded embedded-browser tab metadata.
// Electron's persistent partition owns page data; this file only restores the
// renderer's tab strip and logical navigation stacks.
import {
  hydrateWorkspaceBrowserTabs,
  serializeWorkspaceBrowserTabs,
  type WorkspaceBrowserTab,
} from './browser-tabs'

export const WORKSPACE_BROWSER_TABS_KEY = 'littlesheep.ui.workspaceBrowserTabs'

export function readWorkspaceBrowserTabsPreference(): WorkspaceBrowserTab[] {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_BROWSER_TABS_KEY)
    if (!raw) return hydrateWorkspaceBrowserTabs(null)
    return hydrateWorkspaceBrowserTabs(JSON.parse(raw) as unknown)
  } catch {
    return hydrateWorkspaceBrowserTabs(null)
  }
}

export function writeWorkspaceBrowserTabsPreference(tabs: WorkspaceBrowserTab[]): void {
  try {
    window.localStorage.setItem(WORKSPACE_BROWSER_TABS_KEY, JSON.stringify(serializeWorkspaceBrowserTabs(tabs)))
  } catch {
    // Tab metadata is recoverable; the persistent Electron session is authoritative.
  }
}
