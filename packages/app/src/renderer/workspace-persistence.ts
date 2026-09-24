// @littlesheep/app — workspace-persistence.ts
// Pure recovery helpers for the extension workspace UI.
import {
  isWorkspaceBrowserTabId,
  LEGACY_WORKSPACE_BROWSER_TAB_ID,
  hydrateWorkspaceBrowserTabs,
  serializeWorkspaceBrowserTabs,
  type WorkspaceBrowserTab,
  type WorkspaceBrowserTabId,
} from './workspace/browser-tabs'
import {
  WORKSPACE_FILE_NAVIGATOR_WIDTH_DEFAULT,
  WORKSPACE_FILE_NAVIGATOR_WIDTH_MAX,
  WORKSPACE_FILE_NAVIGATOR_WIDTH_MIN,
} from './workspace-layout'

export interface WorkspaceOpenRequest {
  id: number
  root: string
  path: string
}

export interface WorkspaceFileDraftState {
  path: string
  modifiedAt?: number
  editorText: string
  savedText: string
  editing: boolean
}

export type WorkspacePanelTab = 'review' | 'artifacts' | 'terminal' | 'browser' | 'sideChat'
export type WorkspaceFileTabId = `file:${string}`
export type WorkspacePanelTabId = WorkspacePanelTab | WorkspaceFileTabId | WorkspaceBrowserTabId

export const DEFAULT_WORKSPACE_PANEL_TABS: WorkspacePanelTabId[] = ['review']
export const WORKSPACE_PANEL_OPEN_TABS_MAX = 64
export const WORKSPACE_FILE_DRAFT_MAX_CHARS = 256 * 1024
export const WORKSPACE_FILE_DRAFTS_MAX_CHARS = 1024 * 1024

/** Key used for the one unsaved conversation that can be shown in the composer. */
export const WORKSPACE_DRAFT_SESSION_KEY = '__draft__'

export const WORKSPACE_SESSION_LAYOUTS_MAX = 96

export const WORKSPACE_EXPANDED_PATHS_MAX = 256

export const WORKSPACE_EXPANDED_PATH_MAX_LENGTH = 4096

/**
 * Workspace UI state that belongs to one conversation. Outer window geometry
 * (sidebar/panel width) lives elsewhere; nested navigator geometry stays here.
 */
export interface WorkspaceSessionLayout {
  collapsed: boolean
  fullscreen: boolean
  activeTab: WorkspacePanelTabId
  openTabs: WorkspacePanelTabId[]
  openRequest: WorkspaceOpenRequest | null
  fileNavigatorCollapsed: boolean
  fileNavigatorWidth: number
  expandedPaths: string[]
  drafts: Record<string, WorkspaceFileDraftState>
  browserTabs: WorkspaceBrowserTab[]
}

export type WorkspaceSessionLayouts = Record<string, WorkspaceSessionLayout>

export function workspaceSessionKey(sessionId?: string): string {
  return typeof sessionId === 'string' && sessionId.trim()
    ? `session:${encodeURIComponent(sessionId.trim())}`
    : WORKSPACE_DRAFT_SESSION_KEY
}

export function createDefaultWorkspaceSessionLayout(): WorkspaceSessionLayout {
  return {
    collapsed: true,
    fullscreen: false,
    activeTab: DEFAULT_WORKSPACE_PANEL_TABS[0] ?? 'review',
    openTabs: [...DEFAULT_WORKSPACE_PANEL_TABS],
    openRequest: null,
    fileNavigatorCollapsed: false,
    fileNavigatorWidth: WORKSPACE_FILE_NAVIGATOR_WIDTH_DEFAULT,
    expandedPaths: [],
    drafts: {},
    browserTabs: [],
  }
}

export interface WorkspacePanelRecoveryState {
  openRequest: WorkspaceOpenRequest | null
  openTabs: WorkspacePanelTabId[]
  activeTab: WorkspacePanelTabId
  drafts: Record<string, WorkspaceFileDraftState>
}

export interface WorkspaceOpenFileTab {
  tab: WorkspaceFileTabId
  root: string
  path: string
}

export interface WorkspaceRecoverySnapshotInput {
  activeTab: WorkspacePanelTabId
  openTabs: WorkspacePanelTabId[]
  openRequest: WorkspaceOpenRequest | null
  drafts: Record<string, WorkspaceFileDraftState>
}

export interface WorkspaceRecoverySnapshot {
  activeFileTab: WorkspaceOpenFileTab | null
  openFileTabs: WorkspaceOpenFileTab[]
  dirtyDraftCount: number
  recentFilePath: string
}

export interface WorkspaceLayoutFallbackMarkers {
  width: unknown
  activeTab: unknown
  openTabs: unknown
  openRoot: unknown
  openPath: unknown
  drafts: unknown
}

export interface WorkspaceLayoutFallbackSnapshot {
  workspacePath: string
  sessionId?: string
  width?: number
  collapsed: boolean
  fullscreen: boolean
  activeTab: WorkspacePanelTabId
  openTabs: WorkspacePanelTabId[]
  openRequest: WorkspaceOpenRequest | null
  fileNavigatorCollapsed: boolean
  fileNavigatorWidth?: number
  expandedPaths?: string[]
  drafts: Record<string, WorkspaceFileDraftState>
  browserTabs?: WorkspaceBrowserTab[]
}

export function workspaceFileTabId(root: string, path: string): WorkspaceFileTabId {
  return `file:${encodeURIComponent(root)}|${encodeURIComponent(path)}` as WorkspaceFileTabId
}

export function parseWorkspaceFileTabId(value: unknown): { root: string; path: string } | null {
  if (typeof value !== 'string' || !value.startsWith('file:')) return null
  const body = value.slice('file:'.length)
  const splitAt = body.indexOf('|')
  if (splitAt <= 0) return null
  try {
    const root = decodeURIComponent(body.slice(0, splitAt))
    const path = decodeURIComponent(body.slice(splitAt + 1))
    if (!root || !path) return null
    return { root, path }
  } catch {
    return null
  }
}

export function isWorkspacePanelTab(value: unknown): value is WorkspacePanelTab {
  return value === 'review' ||
    value === 'artifacts' ||
    value === 'terminal' ||
    value === 'browser' ||
    value === 'sideChat'
}

export function isWorkspacePanelTabId(value: unknown): value is WorkspacePanelTabId {
  return isWorkspacePanelTab(value) || parseWorkspaceFileTabId(value) !== null
    || isWorkspaceBrowserTabId(value)
}

export function normalizeWorkspacePanelTabId(value: unknown): WorkspacePanelTabId | null {
  // `browser` is now a launcher action. Persisted values from older builds
  // refer to the former fixed browser page and migrate to a normal tab.
  const normalized = value === 'browser'
    ? LEGACY_WORKSPACE_BROWSER_TAB_ID
    : value === 'overview' || value === 'files'
      ? 'review'
      : value
  return isWorkspacePanelTabId(normalized) ? normalized : null
}

export function dedupeWorkspacePanelTabs(tabs: WorkspacePanelTabId[]): WorkspacePanelTabId[] {
  const next: WorkspacePanelTabId[] = []
  for (const tab of tabs) {
    if (!next.includes(tab)) next.push(tab)
    if (next.length >= WORKSPACE_PANEL_OPEN_TABS_MAX) break
  }
  return next
}

export function hydrateWorkspacePanelTabs(value: unknown): WorkspacePanelTabId[] {
  if (!Array.isArray(value)) return DEFAULT_WORKSPACE_PANEL_TABS
  const tabs = value
    .map(normalizeWorkspacePanelTabId)
    .filter((tab): tab is WorkspacePanelTabId => Boolean(tab))
  // An explicit empty list means the user closed every extension tab. Invalid
  // non-empty data still falls back to the stable first entry.
  if (value.length === 0) return []
  const deduped = dedupeWorkspacePanelTabs(tabs)
  return deduped.length > 0 ? deduped : DEFAULT_WORKSPACE_PANEL_TABS
}

export function normalizeWorkspaceFileDraft(tab: string, value: unknown): WorkspaceFileDraftState | null {
  const fileTab = parseWorkspaceFileTabId(tab)
  if (!fileTab || !value || typeof value !== 'object' || Array.isArray(value)) return null
  const draft = value as Partial<WorkspaceFileDraftState>
  if (draft.path !== fileTab.path) return null
  if (typeof draft.editorText !== 'string' || typeof draft.savedText !== 'string') return null
  if (draft.editorText === draft.savedText) return null
  const modifiedAt = typeof draft.modifiedAt === 'number' && Number.isFinite(draft.modifiedAt)
    ? draft.modifiedAt
    : undefined
  return {
    path: draft.path,
    modifiedAt,
    editorText: draft.editorText,
    savedText: draft.savedText,
    editing: draft.editing === true,
  }
}

export function hydrateWorkspaceFileDrafts(value: unknown): Record<string, WorkspaceFileDraftState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const drafts: Record<string, WorkspaceFileDraftState> = {}
  let totalChars = 0
  for (const [tab, rawDraft] of Object.entries(value as Record<string, unknown>)) {
    const draft = normalizeWorkspaceFileDraft(tab, rawDraft)
    if (!draft) continue
    const draftChars = draft.editorText.length + draft.savedText.length
    if (draftChars > WORKSPACE_FILE_DRAFT_MAX_CHARS || totalChars + draftChars > WORKSPACE_FILE_DRAFTS_MAX_CHARS) continue
    drafts[tab] = draft
    totalChars += draftChars
  }
  return drafts
}

export function serializeWorkspaceFileDrafts(
  drafts: Record<string, WorkspaceFileDraftState>,
  openTabs: WorkspacePanelTabId[],
): Record<string, WorkspaceFileDraftState> {
  const openFileTabs = new Set(openTabs.filter((tab): tab is WorkspaceFileTabId => parseWorkspaceFileTabId(tab) !== null))
  const payload: Record<string, WorkspaceFileDraftState> = {}
  let totalChars = 0

  for (const tab of openFileTabs) {
    const draft = normalizeWorkspaceFileDraft(tab, drafts[tab])
    if (!draft) continue
    const draftChars = draft.editorText.length + draft.savedText.length
    if (draftChars > WORKSPACE_FILE_DRAFT_MAX_CHARS || totalChars + draftChars > WORKSPACE_FILE_DRAFTS_MAX_CHARS) continue
    payload[tab] = draft
    totalChars += draftChars
  }

  return payload
}

/** Normalize one session bucket before it enters React state or storage. */
export function normalizeWorkspaceSessionLayout(value: unknown): WorkspaceSessionLayout {
  const fallback = createDefaultWorkspaceSessionLayout()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback

  const item = value as Record<string, unknown>
  const activeTab = normalizeWorkspacePanelTabId(item.activeTab) ?? fallback.activeTab
  const hydratedTabs = hydrateWorkspacePanelTabs(item.openTabs)
  const openTabs = hydratedTabs.length === 0
    ? []
    : hydratedTabs.includes(activeTab)
      ? hydratedTabs
      : dedupeWorkspacePanelTabs([...hydratedTabs, activeTab])
  const openRequest = normalizeWorkspaceOpenRequest(item.openRequest)
  const expandedPaths = normalizeWorkspaceExpandedPaths(item.expandedPaths)
  const drafts = hydrateWorkspaceFileDrafts(item.drafts)
  const browserTabs = hydrateWorkspaceBrowserTabs(item.browserTabs)

  return {
    collapsed: typeof item.collapsed === 'boolean' ? item.collapsed : fallback.collapsed,
    fullscreen: item.fullscreen === true,
    activeTab,
    openTabs,
    openRequest,
    fileNavigatorCollapsed: item.fileNavigatorCollapsed === true,
    fileNavigatorWidth: normalizeWorkspaceFileNavigatorWidth(item.fileNavigatorWidth),
    expandedPaths,
    drafts,
    browserTabs,
  }
}

export function normalizeWorkspaceFileNavigatorWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return WORKSPACE_FILE_NAVIGATOR_WIDTH_DEFAULT
  }
  return Math.max(
    WORKSPACE_FILE_NAVIGATOR_WIDTH_MIN,
    Math.min(WORKSPACE_FILE_NAVIGATOR_WIDTH_MAX, Math.round(value)),
  )
}

export function hydrateWorkspaceSessionLayouts(value: unknown): WorkspaceSessionLayouts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const result: WorkspaceSessionLayouts = {}
  for (const [rawKey, rawState] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim()
    if (!key || key.length > 256 || result[key]) continue
    result[key] = normalizeWorkspaceSessionLayout(rawState)
    if (Object.keys(result).length >= WORKSPACE_SESSION_LAYOUTS_MAX) break
  }
  return result
}

export function serializeWorkspaceSessionLayouts(value: WorkspaceSessionLayouts): WorkspaceSessionLayouts {
  const result: WorkspaceSessionLayouts = {}
  const entries = Object.entries(value).slice(-WORKSPACE_SESSION_LAYOUTS_MAX)
  for (const [rawKey, state] of entries) {
    const key = rawKey.trim()
    if (!key || key.length > 256) continue
    const normalized = normalizeWorkspaceSessionLayout(state)
    result[key] = {
      ...normalized,
      // Keep only drafts for tabs that are still open in this session bucket.
      drafts: serializeWorkspaceFileDrafts(normalized.drafts, normalized.openTabs),
      browserTabs: serializeWorkspaceBrowserTabs(normalized.browserTabs),
    }
  }
  return result
}

export function normalizeWorkspaceExpandedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const paths: string[] = []
  for (const rawPath of value) {
    if (typeof rawPath !== 'string') continue
    const path = rawPath.trim().slice(0, WORKSPACE_EXPANDED_PATH_MAX_LENGTH)
    if (!path || paths.includes(path)) continue
    paths.push(path)
    if (paths.length >= WORKSPACE_EXPANDED_PATHS_MAX) break
  }
  return paths
}

export function workspaceSessionLayoutFromSnapshot(
  snapshot: Pick<WorkspaceLayoutFallbackSnapshot, 'collapsed' | 'fullscreen' | 'activeTab' | 'openTabs' | 'openRequest' | 'fileNavigatorCollapsed' | 'fileNavigatorWidth' | 'drafts'> & {
    expandedPaths?: unknown
    browserTabs?: unknown
  },
): WorkspaceSessionLayout {
  return normalizeWorkspaceSessionLayout({
    collapsed: snapshot.collapsed,
    fullscreen: snapshot.fullscreen,
    activeTab: snapshot.activeTab,
    openTabs: snapshot.openTabs,
    openRequest: snapshot.openRequest,
    fileNavigatorCollapsed: snapshot.fileNavigatorCollapsed,
    fileNavigatorWidth: snapshot.fileNavigatorWidth,
    expandedPaths: snapshot.expandedPaths,
    drafts: snapshot.drafts,
    browserTabs: snapshot.browserTabs,
  })
}

export function buildWorkspaceRecoverySnapshot(input: WorkspaceRecoverySnapshotInput): WorkspaceRecoverySnapshot {
  const openFileTabs = input.openTabs
    .map((tab) => {
      const file = parseWorkspaceFileTabId(tab)
      return file ? { tab: tab as WorkspaceFileTabId, ...file } : null
    })
    .filter((item): item is WorkspaceOpenFileTab => Boolean(item))

  const activeFile = parseWorkspaceFileTabId(input.activeTab)
  const activeFileTab = activeFile
    ? { tab: input.activeTab as WorkspaceFileTabId, ...activeFile }
    : null
  const dirtyDraftCount = Object.values(input.drafts)
    .filter((draft) => draft.editorText !== draft.savedText)
    .length
  const recentFilePath = input.openRequest?.path ?? openFileTabs[0]?.path ?? ''

  return {
    activeFileTab,
    openFileTabs,
    dirtyDraftCount,
    recentFilePath,
  }
}

export function shouldUseWorkspaceLayoutFallback(markers: WorkspaceLayoutFallbackMarkers): boolean {
  if (typeof markers.width === 'string' && Number.isFinite(Number(markers.width))) return false
  if (normalizeWorkspacePanelTabId(markers.activeTab)) return false
  if (hasValidSerializedOpenTabs(markers.openTabs)) return false
  if (typeof markers.openRoot === 'string' && markers.openRoot.trim() && typeof markers.openPath === 'string' && markers.openPath.trim()) return false
  if (hasValidSerializedDrafts(markers.drafts)) return false
  return true
}

export function hydrateWorkspaceLayoutFallbackSnapshot(value: unknown): WorkspaceLayoutFallbackSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const workspacePath = typeof item.workspacePath === 'string' ? item.workspacePath.trim() : ''
  if (!workspacePath) return null
  const activeTab = normalizeWorkspacePanelTabId(item.activeTab) ?? 'review'
  const openTabs = hydrateWorkspacePanelTabs(item.openTabs)
  const openRequest = normalizeWorkspaceOpenRequest(item.openRequest)
  const drafts = hydrateWorkspaceFileDrafts(item.drafts)
  const state = alignWorkspacePanelStateToRoot({
    openRequest,
    openTabs: openTabs.length === 0 || openTabs.includes(activeTab) ? openTabs : [...openTabs, activeTab],
    activeTab,
    drafts,
  }, workspacePath)
  const width = typeof item.width === 'number' && Number.isFinite(item.width)
    ? Math.round(item.width)
    : undefined

  return {
    workspacePath,
    sessionId: typeof item.sessionId === 'string' && item.sessionId.trim() ? item.sessionId.trim() : undefined,
    width,
    collapsed: item.collapsed === true,
    fullscreen: item.fullscreen === true,
    activeTab: state.activeTab,
    openTabs: state.openTabs,
    openRequest: state.openRequest,
    fileNavigatorCollapsed: item.fileNavigatorCollapsed === true,
    fileNavigatorWidth: normalizeWorkspaceFileNavigatorWidth(item.fileNavigatorWidth),
    expandedPaths: normalizeWorkspaceExpandedPaths(item.expandedPaths),
    drafts: state.drafts,
    browserTabs: hydrateWorkspaceBrowserTabs(item.browserTabs),
  }
}

export function alignWorkspacePanelStateToRoot(
  state: WorkspacePanelRecoveryState,
  root: string,
): WorkspacePanelRecoveryState {
  const normalizedRoot = root.trim()
  if (!normalizedRoot) return state

  const openRequest = state.openRequest && isWorkspaceTargetInsideRoot(state.openRequest, normalizedRoot)
    ? state.openRequest
    : null
  const filteredTabs = state.openTabs.filter((tab) => {
    const fileTab = parseWorkspaceFileTabId(tab)
    return !fileTab || isWorkspaceFileInsideRoot(fileTab, normalizedRoot)
  })
  const openTabs = state.openTabs.length === 0
    ? []
    : filteredTabs.length > 0
      ? dedupeWorkspacePanelTabs(filteredTabs)
      : DEFAULT_WORKSPACE_PANEL_TABS
  const activeFileTab = parseWorkspaceFileTabId(state.activeTab)
  const activeTab = !activeFileTab || isWorkspaceFileInsideRoot(activeFileTab, normalizedRoot)
    ? state.activeTab
    : 'review'
  const drafts: Record<string, WorkspaceFileDraftState> = {}

  for (const [tab, draft] of Object.entries(state.drafts)) {
    const fileTab = parseWorkspaceFileTabId(tab)
    if (!fileTab || !isWorkspaceFileInsideRoot(fileTab, normalizedRoot)) continue
    drafts[tab] = draft
  }

  return { openRequest, openTabs, activeTab, drafts }
}

export function rebindWorkspacePanelState(
  state: WorkspacePanelRecoveryState,
  fromRoot: string,
  toRoot: string,
): WorkspacePanelRecoveryState {
  const openRequest = state.openRequest
    ? {
        ...state.openRequest,
        root: rebindWorkspacePath(state.openRequest.root, fromRoot, toRoot),
        path: rebindWorkspacePath(state.openRequest.path, fromRoot, toRoot),
      }
    : null
  const reboundTabs = state.openTabs.map((tab) => {
    const file = parseWorkspaceFileTabId(tab)
    return file
      ? workspaceFileTabId(
          rebindWorkspacePath(file.root, fromRoot, toRoot),
          rebindWorkspacePath(file.path, fromRoot, toRoot),
      )
      : tab
  })
  const openTabs = state.openTabs.length === 0 ? [] : dedupeWorkspacePanelTabs(reboundTabs)
  const activeFile = parseWorkspaceFileTabId(state.activeTab)
  const activeTab = activeFile
    ? workspaceFileTabId(
        rebindWorkspacePath(activeFile.root, fromRoot, toRoot),
        rebindWorkspacePath(activeFile.path, fromRoot, toRoot),
      )
    : state.activeTab
  const drafts: Record<string, WorkspaceFileDraftState> = {}
  for (const [tab, draft] of Object.entries(state.drafts)) {
    const file = parseWorkspaceFileTabId(tab)
    const nextTab = file
      ? workspaceFileTabId(
          rebindWorkspacePath(file.root, fromRoot, toRoot),
          rebindWorkspacePath(file.path, fromRoot, toRoot),
        )
      : tab
    drafts[nextTab] = { ...draft, path: rebindWorkspacePath(draft.path, fromRoot, toRoot) }
  }
  return { openRequest, openTabs, activeTab, drafts }
}

export function rebindWorkspacePath(path: string, fromRoot: string, toRoot: string): string {
  const normalizedPath = trimWorkspacePath(path)
  const normalizedFrom = trimWorkspacePath(fromRoot)
  const normalizedTo = trimWorkspacePath(toRoot)
  const comparablePath = normalizeWorkspacePathForCompare(normalizedPath)
  const comparableFrom = normalizeWorkspacePathForCompare(normalizedFrom)
  if (comparablePath !== comparableFrom && !comparablePath.startsWith(`${comparableFrom}\\`)) return path
  const suffix = normalizedPath.slice(normalizedFrom.length)
  const separator = normalizedTo.includes('\\') ? '\\' : '/'
  return `${normalizedTo}${suffix.replace(/[\\/]/g, separator)}`
}

function normalizeWorkspaceOpenRequest(value: unknown): WorkspaceOpenRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const root = typeof item.root === 'string' ? item.root.trim() : ''
  const path = typeof item.path === 'string' ? item.path.trim() : ''
  return root && path ? { id: Date.now(), root, path } : null
}

function hasValidSerializedOpenTabs(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) && (parsed.length === 0 || parsed.some((item) => normalizeWorkspacePanelTabId(item)))
  } catch {
    return false
  }
}

function hasValidSerializedDrafts(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim() || value.length > WORKSPACE_FILE_DRAFTS_MAX_CHARS * 2) return false
  try {
    return Object.keys(hydrateWorkspaceFileDrafts(JSON.parse(value) as unknown)).length > 0
  } catch {
    return false
  }
}

function isWorkspaceTargetInsideRoot(request: WorkspaceOpenRequest, root: string): boolean {
  return isPathInsideOrSameWorkspace(request.root, root) && isPathInsideOrSameWorkspace(request.path, root)
}

function isWorkspaceFileInsideRoot(fileTab: { root: string; path: string }, root: string): boolean {
  return isPathInsideOrSameWorkspace(fileTab.root, root) && isPathInsideOrSameWorkspace(fileTab.path, root)
}

function isPathInsideOrSameWorkspace(path: string, root: string): boolean {
  const normalizedPath = normalizeWorkspacePathForCompare(path)
  const normalizedRoot = normalizeWorkspacePathForCompare(root)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`)
}

function normalizeWorkspacePathForCompare(value: string): string {
  return trimWorkspacePath(value).replace(/\//g, '\\').toLowerCase()
}

function trimWorkspacePath(value: string): string {
  return value.replace(/[\\/]+$/, '')
}
