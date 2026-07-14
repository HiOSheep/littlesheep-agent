// Application-shell state helpers shared by the renderer composition root.
import { ProjectSortMode } from '../sidebar/types'
import {
DEFAULT_WORKSPACE_PANEL_TABS,
WORKSPACE_FILE_DRAFTS_MAX_CHARS,
dedupeWorkspacePanelTabs,
hydrateWorkspaceFileDrafts,
hydrateWorkspacePanelTabs,
normalizeWorkspacePanelTabId,
serializeWorkspaceFileDrafts,
type WorkspaceFileDraftState,
type WorkspaceOpenRequest,
type WorkspacePanelTabId
} from '../workspace-persistence'
import { isSamePath } from '../workspace/path-utils'
import { clampNumber } from './navigation'

export const SIDEBAR_WIDTH_KEY = 'littlesheep.ui.sidebarWidth'

export const SIDEBAR_COLLAPSED_KEY = 'littlesheep.ui.sidebarCollapsed'

export const WORKSPACE_PANEL_WIDTH_KEY = 'littlesheep.ui.workspacePanelWidth'

export const WORKSPACE_PANEL_COLLAPSED_KEY = 'littlesheep.ui.workspacePanelCollapsed'

export const WORKSPACE_PANEL_FULLSCREEN_KEY = 'littlesheep.ui.workspacePanelFullscreen'

export const WORKSPACE_PANEL_TAB_KEY = 'littlesheep.ui.workspacePanelTab'

export const WORKSPACE_PANEL_OPEN_TABS_KEY = 'littlesheep.ui.workspacePanelOpenTabs'

export const WORKSPACE_PANEL_OPEN_ROOT_KEY = 'littlesheep.ui.workspacePanelOpenRoot'

export const WORKSPACE_PANEL_OPEN_PATH_KEY = 'littlesheep.ui.workspacePanelOpenPath'

export const WORKSPACE_FILE_DRAFTS_KEY = 'littlesheep.ui.workspaceFileDrafts'

export const WORKSPACE_FILE_NAVIGATOR_COLLAPSED_KEY = 'littlesheep.ui.workspaceFileNavigatorCollapsed'

export const PINNED_SESSIONS_KEY = 'littlesheep.ui.pinnedSessions'

export const PROJECT_SORT_KEY = 'littlesheep.ui.projectSort'

export const ACTIVE_SESSION_KEY = 'littlesheep.ui.activeSession'

export const SIDEBAR_WIDTH_DEFAULT = 276

export const SIDEBAR_WIDTH_MIN = 220

export const SIDEBAR_WIDTH_MAX = 460

export const SIDEBAR_COLLAPSE_THRESHOLD = SIDEBAR_WIDTH_MIN / 2

export const TWO_STAGE_RESIZE_MOTION_MS = 320

export const SIDEBAR_SETTLE_ANIMATION_MS = TWO_STAGE_RESIZE_MOTION_MS

export const WORKSPACE_PANEL_MOTION_MS = TWO_STAGE_RESIZE_MOTION_MS


export function readNumberPreference(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key)
    const value = raw ? Number(raw) : fallback
    return clampNumber(Number.isFinite(value) ? value : fallback, min, max)
  } catch {
    return fallback
  }
}


export function writeNumberPreference(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(Math.round(value)))
  } catch {
    // Local UI preferences are best-effort only.
  }
}


export function readBooleanPreference(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === 'true') return true
    if (raw === 'false') return false
    return fallback
  } catch {
    return fallback
  }
}


export function writeBooleanPreference(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? 'true' : 'false')
  } catch {
    // Local UI preferences are best-effort only.
  }
}


export function readStringSetPreference(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return new Set()
    const values = JSON.parse(raw)
    if (!Array.isArray(values)) return new Set()
    return new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))
  } catch {
    return new Set()
  }
}


export function writeStringSetPreference(key: string, values: Set<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(values)))
  } catch {
    // Local UI preferences are best-effort only.
  }
}


export function readStringPreference(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}


export function writeStringPreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Local UI preferences are best-effort only.
  }
}


export function removePreference(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Local UI preferences are best-effort only.
  }
}


export function readWorkspaceOpenRequestPreference(): WorkspaceOpenRequest | null {
  try {
    const root = window.localStorage.getItem(WORKSPACE_PANEL_OPEN_ROOT_KEY) ?? ''
    const path = window.localStorage.getItem(WORKSPACE_PANEL_OPEN_PATH_KEY) ?? ''
    if (!root || !path) return null
    return { id: Date.now(), root, path }
  } catch {
    return null
  }
}


export function writeWorkspaceOpenRequestPreference(request: WorkspaceOpenRequest | null): void {
  try {
    if (!request) {
      window.localStorage.removeItem(WORKSPACE_PANEL_OPEN_ROOT_KEY)
      window.localStorage.removeItem(WORKSPACE_PANEL_OPEN_PATH_KEY)
      return
    }
    window.localStorage.setItem(WORKSPACE_PANEL_OPEN_ROOT_KEY, request.root)
    window.localStorage.setItem(WORKSPACE_PANEL_OPEN_PATH_KEY, request.path)
  } catch {
    // Local UI preferences are best-effort only.
  }
}


export function readWorkspaceFileDraftsPreference(): Record<string, WorkspaceFileDraftState> {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_FILE_DRAFTS_KEY)
    if (!raw || raw.length > WORKSPACE_FILE_DRAFTS_MAX_CHARS * 2) return {}
    return hydrateWorkspaceFileDrafts(JSON.parse(raw) as unknown)
  } catch {
    return {}
  }
}


export function writeWorkspaceFileDraftsPreference(
  drafts: Record<string, WorkspaceFileDraftState>,
  openTabs: WorkspacePanelTabId[],
): void {
  try {
    const payload = serializeWorkspaceFileDrafts(drafts, openTabs)
    if (Object.keys(payload).length === 0) {
      window.localStorage.removeItem(WORKSPACE_FILE_DRAFTS_KEY)
      return
    }
    window.localStorage.setItem(WORKSPACE_FILE_DRAFTS_KEY, JSON.stringify(payload))
  } catch {
    // Draft recovery is best-effort; the source files remain authoritative.
  }
}


export function readWorkspaceLayoutFallbackMarkers() {
  try {
    return {
      width: window.localStorage.getItem(WORKSPACE_PANEL_WIDTH_KEY),
      activeTab: window.localStorage.getItem(WORKSPACE_PANEL_TAB_KEY),
      openTabs: window.localStorage.getItem(WORKSPACE_PANEL_OPEN_TABS_KEY),
      openRoot: window.localStorage.getItem(WORKSPACE_PANEL_OPEN_ROOT_KEY),
      openPath: window.localStorage.getItem(WORKSPACE_PANEL_OPEN_PATH_KEY),
      drafts: window.localStorage.getItem(WORKSPACE_FILE_DRAFTS_KEY),
    }
  } catch {
    return {
      width: null,
      activeTab: null,
      openTabs: null,
      openRoot: null,
      openPath: null,
      drafts: null,
    }
  }
}


export function shouldApplyWorkspaceLayoutFallback(
  snapshotWorkspacePath: string,
  defaultWorkspacePath: string,
  openRequest: WorkspaceOpenRequest | null,
): boolean {
  if (isSamePath(snapshotWorkspacePath, defaultWorkspacePath)) return true
  return Boolean(openRequest && isSamePath(openRequest.root, snapshotWorkspacePath))
}


export function readProjectSortPreference(key: string): ProjectSortMode {
  try {
    const value = window.localStorage.getItem(key)
    if (value === 'fixed' || value === 'recent' || value === 'name') return value
  } catch {
    // Local UI preferences are best-effort only.
  }
  return 'fixed'
}


export function readWorkspacePanelTabPreference(key: string): WorkspacePanelTabId {
  try {
    const value = normalizeWorkspacePanelTabId(window.localStorage.getItem(key))
    if (value) return value
  } catch {
    // Local UI preferences are best-effort only.
  }
  return 'review'
}


export function readWorkspacePanelOpenTabsPreference(): WorkspacePanelTabId[] {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_PANEL_OPEN_TABS_KEY)
    if (!raw) return DEFAULT_WORKSPACE_PANEL_TABS
    const values = JSON.parse(raw)
    return hydrateWorkspacePanelTabs(values)
  } catch {
    return DEFAULT_WORKSPACE_PANEL_TABS
  }
}


export function writeWorkspacePanelOpenTabsPreference(tabs: WorkspacePanelTabId[]): void {
  try {
    window.localStorage.setItem(WORKSPACE_PANEL_OPEN_TABS_KEY, JSON.stringify(dedupeWorkspacePanelTabs(tabs)))
  } catch {
    // Local UI preferences are best-effort only.
  }
}
