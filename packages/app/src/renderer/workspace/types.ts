// Extension workspace panels, files, terminal, artifacts, and view helpers.


export interface WorkspaceArtifactRef {
  path: string
  name: string
  action: 'created' | 'modified' | 'attached'
  toolName?: string
}


export type WorkspaceArtifactScopeFilter = 'project' | 'session'

export type WorkspaceArtifactSourceFilter = 'all' | 'agent' | 'user'

export type WorkspaceArtifactActionFilter = 'all' | WorkspaceArtifactRef['action']
