// Structured, bounded Git review records shared by Main and the renderer.

export type WorkspaceReviewAvailability = 'ready' | 'not-repository' | 'git-unavailable'

export type WorkspaceReviewFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'type-changed'

export interface WorkspaceReviewFile {
  /** Path relative to the selected workspace, using Git's forward-slash form. */
  path: string
  /** Native absolute path used by the workspace file viewer. */
  absolutePath: string
  oldPath?: string
  status: WorkspaceReviewFileStatus
  additions: number
  deletions: number
  /** False when a bounded scan cannot determine exact line counts. */
  countAvailable: boolean
  staged: boolean
  unstaged: boolean
  binary: boolean
}

export interface WorkspaceReviewSnapshot {
  /** Opaque identity for the Main-process snapshot used by detail requests. */
  revision: string
  availability: WorkspaceReviewAvailability
  workspacePath: string
  repositoryRoot?: string
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  additions: number
  deletions: number
  countsComplete: boolean
  totalFiles: number
  filesTruncated: boolean
  files: WorkspaceReviewFile[]
  generatedAt: string
  message?: string
}

export type WorkspaceReviewDiffLineKind = 'context' | 'addition' | 'deletion' | 'meta'

export interface WorkspaceReviewDiffLine {
  kind: WorkspaceReviewDiffLineKind
  content: string
  oldLine: number | null
  newLine: number | null
}

export interface WorkspaceReviewDiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: WorkspaceReviewDiffLine[]
}

export type WorkspaceReviewDiffLayerKind = 'staged' | 'unstaged' | 'untracked'

export interface WorkspaceReviewDiffLayer {
  kind: WorkspaceReviewDiffLayerKind
  hunks: WorkspaceReviewDiffHunk[]
  binary: boolean
  truncated: boolean
  notice?: string
}

export interface WorkspaceReviewFileDiff {
  /** Snapshot identity that produced this file selection and layer request. */
  revision: string
  workspacePath: string
  repositoryRoot: string
  file: WorkspaceReviewFile
  layers: WorkspaceReviewDiffLayer[]
  /** Aggregate compatibility view. New consumers should render layers. */
  hunks: WorkspaceReviewDiffHunk[]
  binary: boolean
  truncated: boolean
  notice?: string
}
