// @littlesheep/app — workspace-persistence.ts
// Pure recovery helpers for the extension workspace UI.

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

export type WorkspacePanelTab = 'review' | 'artifacts' | 'terminal' | 'browser' | 'files' | 'sideChat'
export type WorkspaceFileTabId = `file:${string}`
export type WorkspacePanelTabId = WorkspacePanelTab | WorkspaceFileTabId

export const DEFAULT_WORKSPACE_PANEL_TABS: WorkspacePanelTabId[] = ['review']
export const WORKSPACE_PANEL_OPEN_TABS_MAX = 64
export const WORKSPACE_FILE_DRAFT_MAX_CHARS = 256 * 1024
export const WORKSPACE_FILE_DRAFTS_MAX_CHARS = 1024 * 1024

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
  drafts: Record<string, WorkspaceFileDraftState>
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
    value === 'files' ||
    value === 'terminal' ||
    value === 'browser' ||
    value === 'sideChat'
}

export function isWorkspacePanelTabId(value: unknown): value is WorkspacePanelTabId {
  return isWorkspacePanelTab(value) || parseWorkspaceFileTabId(value) !== null
}

export function normalizeWorkspacePanelTabId(value: unknown): WorkspacePanelTabId | null {
  const normalized = value === 'overview' || value === 'files' ? 'review' : value
  return isWorkspacePanelTabId(normalized) ? normalized : null
}

export function dedupeWorkspacePanelTabs(tabs: WorkspacePanelTabId[]): WorkspacePanelTabId[] {
  const next: WorkspacePanelTabId[] = []
  for (const tab of tabs) {
    if (!next.includes(tab)) next.push(tab)
    if (next.length >= WORKSPACE_PANEL_OPEN_TABS_MAX) break
  }
  return next.length > 0 ? next : DEFAULT_WORKSPACE_PANEL_TABS
}

export function hydrateWorkspacePanelTabs(value: unknown): WorkspacePanelTabId[] {
  if (!Array.isArray(value)) return DEFAULT_WORKSPACE_PANEL_TABS
  return dedupeWorkspacePanelTabs(value
    .map(normalizeWorkspacePanelTabId)
    .filter((tab): tab is WorkspacePanelTabId => Boolean(tab)))
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
    openTabs: openTabs.includes(activeTab) ? openTabs : [...openTabs, activeTab],
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
    drafts: state.drafts,
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
  const openTabs = dedupeWorkspacePanelTabs(state.openTabs.filter((tab) => {
    const fileTab = parseWorkspaceFileTabId(tab)
    return !fileTab || isWorkspaceFileInsideRoot(fileTab, normalizedRoot)
  }))
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
  const openTabs = dedupeWorkspacePanelTabs(state.openTabs.map((tab) => {
    const file = parseWorkspaceFileTabId(tab)
    return file
      ? workspaceFileTabId(
          rebindWorkspacePath(file.root, fromRoot, toRoot),
          rebindWorkspacePath(file.path, fromRoot, toRoot),
        )
      : tab
  }))
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
    return Array.isArray(parsed) && parsed.some((item) => normalizeWorkspacePanelTabId(item))
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
