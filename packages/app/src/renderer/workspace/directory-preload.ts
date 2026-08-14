// Starts only the persisted, visible file navigator's root request before React mounts.
import {
  WORKSPACE_FILE_NAVIGATOR_COLLAPSED_KEY,
  WORKSPACE_PANEL_COLLAPSED_KEY,
  WORKSPACE_PANEL_OPEN_ROOT_KEY,
  WORKSPACE_PANEL_OPEN_TABS_KEY,
  WORKSPACE_PANEL_TAB_KEY,
} from '../app-shell/preferences'
import {
  hydrateWorkspacePanelTabs,
  normalizeWorkspacePanelTabId,
  parseWorkspaceFileTabId,
} from '../workspace-persistence'
import { preloadWorkspaceDirectory } from './directory-cache'

export function preloadPersistedWorkspaceDirectory(): Promise<void> | undefined {
  try {
    if (window.localStorage.getItem(WORKSPACE_PANEL_COLLAPSED_KEY) !== 'false') return
    if (window.localStorage.getItem(WORKSPACE_FILE_NAVIGATOR_COLLAPSED_KEY) === 'true') return

    const activeTab = normalizeWorkspacePanelTabId(
      window.localStorage.getItem(WORKSPACE_PANEL_TAB_KEY),
    )
    if (!activeTab || activeTab === 'review') return

    const openTabs = readPersistedOpenTabs()
    if (!openTabs.includes(activeTab)) return

    const fileTab = parseWorkspaceFileTabId(activeTab)
    const root = fileTab?.root
      ?? window.localStorage.getItem(WORKSPACE_PANEL_OPEN_ROOT_KEY)?.trim()
      ?? ''
    if (!root) return

    return preloadWorkspaceDirectory(root).then(() => undefined, () => undefined)
  } catch {
    // Persistence and preloading are best-effort; the mounted navigator retries normally.
    return
  }
}

function readPersistedOpenTabs() {
  const raw = window.localStorage.getItem(WORKSPACE_PANEL_OPEN_TABS_KEY)
  if (!raw) return hydrateWorkspacePanelTabs(undefined)
  try {
    return hydrateWorkspacePanelTabs(JSON.parse(raw) as unknown)
  } catch {
    return hydrateWorkspacePanelTabs(undefined)
  }
}
