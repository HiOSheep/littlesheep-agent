// Extension workspace panels, files, terminal, artifacts, and view helpers.


export interface WorkspaceArtifactRef {
  path: string
  name: string
  action: 'created' | 'modified' | 'attached'
  toolName?: string
}


export type WorkspaceActivityKind = 'agent' | 'artifact' | 'terminal'

export type WorkspaceActivityKindFilter = 'all' | WorkspaceActivityKind


export interface WorkspaceActivityFeedItem {
  id: string
  kind: WorkspaceActivityKind
  title: string
  detail: string
  timestamp: number
  status?: string
  artifact?: WorkspaceArtifactRef
}


export const WORKSPACE_ACTIVITY_FILTERS: Array<{ id: WorkspaceActivityKindFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'agent', label: 'Agent' },
  { id: 'artifact', label: '产物' },
  { id: 'terminal', label: '终端' },
]

export type WorkspaceArtifactScopeFilter = 'project' | 'session'

export type WorkspaceArtifactSourceFilter = 'all' | 'agent' | 'user'

export type WorkspaceArtifactActionFilter = 'all' | WorkspaceArtifactRef['action']
