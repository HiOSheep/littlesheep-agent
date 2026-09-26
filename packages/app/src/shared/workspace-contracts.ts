// Stable workspace records shared by persistence adapters and renderer clients.

export const WORKSPACE_FILE_NAVIGATOR_WIDTH_DEFAULT = 214
export const WORKSPACE_FILE_NAVIGATOR_WIDTH_MIN = 160
export const WORKSPACE_FILE_NAVIGATOR_WIDTH_MAX = 520

export type WorkspaceArtifactAction = 'created' | 'modified' | 'attached'
export type WorkspaceArtifactSource = 'agent' | 'user'

export interface WorkspaceArtifactRecord {
  id: string
  path: string
  name: string
  action: WorkspaceArtifactAction
  source: WorkspaceArtifactSource
  workspacePath: string
  sessionId?: string
  projectId?: string
  runId?: string
  toolName?: string
  createdAt: string
}

export type WorkspaceLayoutTabId = string

export interface WorkspaceLayoutOpenRequest {
  root: string
  path: string
}

export interface WorkspaceLayoutFileDraft {
  path: string
  modifiedAt?: number
  editorText: string
  savedText: string
  editing: boolean
}

export interface WorkspaceLayoutBrowserTab {
  id: string
  title: string
  url: string
  history: {
    entries: string[]
    index: number
  }
}

export interface WorkspaceLayoutSnapshot {
  version: 1
  updatedAt: string
  workspacePath: string
  sessionId?: string
  width: number
  collapsed: boolean
  fullscreen: boolean
  activeTab: WorkspaceLayoutTabId
  openTabs: WorkspaceLayoutTabId[]
  openRequest: WorkspaceLayoutOpenRequest | null
  fileNavigatorCollapsed: boolean
  fileNavigatorWidth?: number
  /** Review's own leading-column width (UX-18); optional for snapshots written before the split. */
  reviewNavigatorWidth?: number
  expandedPaths?: string[]
  drafts: Record<string, WorkspaceLayoutFileDraft>
  browserTabs?: WorkspaceLayoutBrowserTab[]
}

export interface TerminalActivityRecord {
  id: string
  command: string
  cwd: string
  workspacePath: string
  sessionId?: string
  /**
   * The Shell label Main resolved for the session this command ran in (UX-30 item 5). Older
   * records and Agent-run commands have no session profile, so this stays optional and the
   * list omits it instead of guessing.
   */
  shell?: string
  startedAt: string
  endedAt: string
  durationMs: number
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  truncated: boolean
  stdoutPreview: string
  stderrPreview: string
}
