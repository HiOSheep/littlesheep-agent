// Stable memory control-plane payloads shared by Local App API and renderer.

export interface MemoryOverview {
  dailyDates: string[]
  longTerm: string
  experienceCount: number
}

export type MemoryTreeBranchId = 'long-term' | 'project' | 'daily' | 'experience'
export type MemoryResourceKind =
  | 'agent-instructions'
  | 'persona'
  | 'user-profile'
  | 'tool-guidance'
  | 'legacy-memory'
  | 'skill'
  | 'project-guideline'
  | 'ui-guideline'
  | 'taskbook'
  | 'knowledge'
  | 'summary-memory'
  | 'attachment-manifest'
  | 'attachment'
  | 'runtime-event-ledger'
  | 'workspace-index'
  | 'project-memory-projection'
export type MemoryResourceStatus = 'active' | 'missing' | 'disabled' | 'conflict'
export type MemoryResourceManagementAction = 'disable' | 'restore' | 'remove' | 'rebind'
export type MemoryTreeNodeStatus = 'active' | 'archived'
export type MemoryTreeManagementAction = 'archive' | 'restore' | 'delete' | 'promote' | 'demote'

export interface MemoryTreeBranchOverview {
  id: MemoryTreeBranchId
  title: string
  tier: string
  status: 'active' | 'empty'
  count: number
  indexedCount: number
  archivedCount: number
  source: string
  description: string
  whenToUse: string
  searchHints: string[]
}

export interface MemoryTreeWriteAudit {
  id: string
  intentId: string
  sourceRunId: string
  branch: MemoryTreeBranchId
  at: string
  decision: 'created' | 'merged' | 'reinforced' | 'rejected' | 'queued'
  nodeId?: string
  reason: string
}

export interface MemoryTreeManagementAudit {
  id: string
  nodeId: string
  branch: MemoryTreeBranchId
  action: MemoryTreeManagementAction
  at: string
  reason: string
  fromStatus: 'active' | 'archived' | 'deleted'
  toStatus: 'active' | 'archived' | 'deleted'
  fromTier: 0 | 1 | 2 | 3
  toTier: 0 | 1 | 2 | 3
}

export interface MemoryResourceManagementAudit {
  id: string
  resourceId: string
  resourceKind: MemoryResourceKind
  registryGroup: string
  action: 'disable' | 'restore' | 'mark-missing' | 'mark-conflict' | 'remove' | 'rebind'
  actor: 'user' | 'system'
  at: string
  reason: string
  fromStatus: MemoryResourceStatus
  toStatus?: MemoryResourceStatus
  fromSourcePath?: string
  toSourcePath?: string
}

export interface MemoryTreeRecentHit {
  runId: string
  sessionId: string
  at: string
  action: 'expand' | 'deep_search'
  query?: string
  reason?: string
}

export interface MemoryTreeNodeOverview {
  id: string
  branch: MemoryTreeBranchId
  parentNodeId?: string
  childCount: number
  scope: 'global' | 'workspace' | 'project' | 'session'
  scopeKey?: string
  project?: { id: string; name: string; path: string }
  tier: 0 | 1 | 2 | 3
  summary: string
  content: string
  retrievalKeys: string[]
  importance: number
  confidence: number
  reason: string
  sourceRunIds: string[]
  sourceStages: Array<'evolve' | 'capture' | 'tool' | 'migration'>
  sourceRefs: string[]
  status: MemoryTreeNodeStatus
  createdAt: string
  updatedAt: string
  hitCount: number
  recentHits: MemoryTreeRecentHit[]
  writeHistory: MemoryTreeWriteAudit[]
  managementHistory: MemoryTreeManagementAudit[]
}

export interface ProjectMemoryProjectionState {
  projectId: string
  enabled: boolean
  projectionPath: string
  projectionExists: boolean
  safeToRemove: boolean
  status: 'disabled' | 'missing' | 'ready' | 'stale' | 'conflict'
  gitRepository: boolean
  gitIgnored: boolean
  gitIgnorePattern: string
  sourceRevision?: string
  entryCount?: number
  omittedEntryCount?: number
  lastSyncedAt?: string
  conflictReason?: string
}

export interface MemoryTreeProjectOverview {
  id: string
  name: string
  path: string
  lastActiveAt: string
  projection?: ProjectMemoryProjectionState
}

export type ProjectMemoryProjectionAction =
  | { action: 'enable'; overwriteExisting?: boolean }
  | { action: 'sync'; force?: boolean }
  | { action: 'disable'; removeProjection?: boolean }
  | { action: 'export' }

export interface ProjectMemoryProjectionExportResult {
  outputPath: string
  entryCount: number
  omittedEntryCount: number
  contentHash: string
  generatedAt: string
}

export interface MemoryTreeResourceOverview {
  id: string
  kind: MemoryResourceKind
  title: string
  description: string
  tier: 0 | 1 | 2 | 3
  branch?: MemoryTreeBranchId
  scope: 'global' | 'workspace' | 'project' | 'session' | 'run'
  scopeKey?: string
  authority: 'authoritative' | 'derived' | 'compatibility' | 'external'
  privacy: 'private' | 'project-private' | 'shareable' | 'public'
  sourceKind: 'file' | 'memory-node' | 'session-summary' | 'attachment' | 'runtime-event' | 'workspace-index'
  sourcePath?: string
  indexKeys: string[]
  status: MemoryResourceStatus
  registryGroup: string
  owner?: {
    kind: 'builtin' | 'user' | 'external' | 'plugin'
    id: string
    controller: 'skill-loader' | 'plugin-host'
  }
  updatedAt: string
  managementHistory: MemoryResourceManagementAudit[]
}

export interface MemoryTreeOverview {
  generatedAt: string
  totals: {
    branches: number
    projects: number
    dailyMemories: number
    experiences: number
    longTermChars: number
    indexedMemories: number
    archivedMemories: number
    deletedMemories: number
    recoveryQueue: number
    registeredResources: number
    activeResources: number
  }
  branches: MemoryTreeBranchOverview[]
  nodes: MemoryTreeNodeOverview[]
  projects: MemoryTreeProjectOverview[]
  resources: MemoryTreeResourceOverview[]
  dailyDates: string[]
  longTermExcerpt: string
  recentAccesses: Array<MemoryTreeRecentHit & {
    nodeId: string
    summary: string
    branch: MemoryTreeBranchId
  }>
  migration: null | {
    id: string
    completedAt: string
    sourceCount: number
    created: number
    merged: number
    reinforced: number
    rejected: number
  }
  learningPolicy: {
    experienceWriteThreshold: number
  }
}

export interface MemoryTreeNodeManagementResponse {
  node: {
    id: string
    status: 'active' | 'archived' | 'deleted'
    tier: 0 | 1 | 2 | 3
  }
  audit: MemoryTreeManagementAudit
}

export interface MemoryTreeResourceManagementResponse {
  cancelled: boolean
  resource?: { id: string; status: MemoryResourceStatus }
  audit?: MemoryResourceManagementAudit
  changed?: boolean
  removed?: boolean
}
