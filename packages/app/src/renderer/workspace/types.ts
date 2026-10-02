// Extension workspace panels, files, terminal, artifacts, and view helpers.


export interface WorkspaceArtifactRef {
  path: string
  name: string
  action: 'created' | 'modified' | 'attached'
  toolName?: string
}

