// Stable workspace records shared by persistence adapters and renderer clients.

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
  drafts: Record<string, WorkspaceLayoutFileDraft>
}

export interface TerminalActivityRecord {
  id: string
  command: string
  cwd: string
  workspacePath: string
  sessionId?: string
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
