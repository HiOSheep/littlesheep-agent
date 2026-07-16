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
  | 'philosophy'
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
export type MemoryTreeDisclosureLevel = 'D2' | 'D3'
export type MemoryAtomManagementAction = 'move' | 'merge' | 'invalidate' | 'reactivate'

export interface MemoryRepositoryOverview {
  backendKind: 'v2' | 'v3'
  storageKind: 'legacy-index' | 'atom-catalog'
  retrievalSupported: boolean
  catalog?: {
    integrity: string
    atomCount: number
    embedding: {
      disabled: number
      pending: number
      ready: number
      stale: number
      failed: number
    }
  }
}

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
  retrievalKeys: string[]
  importance: number
  confidence: number
  reason: string
  status: MemoryTreeNodeStatus
  createdAt: string
  updatedAt: string
  hitCount: number
  atomRevision?: number
  invalidatedAt?: string
  mergedIntoId?: string
}

export interface MemoryTreeNodeDetail {
  nodeId: string
  backendKind: 'v2' | 'v3'
  disclosureLevel: MemoryTreeDisclosureLevel
  content: string
  retrievalKeys: string[]
  reason: string
  sourceRunIds: string[]
  sourceStages: Array<'evolve' | 'capture' | 'tool' | 'migration'>
  sourceRefs: string[]
  recentHits: MemoryTreeRecentHit[]
  writeHistory: MemoryTreeWriteAudit[]
  managementHistory: MemoryTreeManagementAudit[]
  v3?: {
    revision: number
    domain: 'user' | 'agent-self' | 'task' | 'project' | 'session' | 'experience' | 'knowledge'
    statementKind: string
    epistemicStatus: string
    resolutionStatus: string
    authorityScope: {
      kind: string
      scope: 'global' | 'workspace' | 'project' | 'session' | 'run'
      scopeKey?: string
      topics: string[]
    }
    assertedBy: { kind: string; id?: string; label?: string }
    evidenceRefs: string[]
    effectiveAt?: string
    expiresAt?: string
    revalidateAt?: string
    lastVerifiedAt?: string
    lastUsefulAt?: string
    verifiedUsefulness: {
      useful: number
      notUseful: number
      conflicts: number
      stale: number
      lastOutcome?: string
    }
    embedding: {
      status: 'disabled' | 'pending' | 'ready' | 'stale' | 'failed'
      engineId?: string
      modelId?: string
      dimensions?: number
    }
    conflict: boolean
    expired: boolean
    neighborhood?: {
      entities: Array<{
        id: string
        type: string
        label: string
        status: string
      }>
      relations: Array<{
        id: string
        fromEntityId: string
        toEntityId: string
        type: string
        status: string
        confidence: number
        relevance: number
      }>
      truncated: boolean
    }
    history?: {
      revision: number
      entries: Array<{ kind: 'access' | 'feedback' | 'event' | 'audit'; id: string; at: string; summary: string }>
      truncated: boolean
    }
    rawRecords?: Array<{
      id: string
      kind: string
      capturedAt: string
      occurredAt: string
      sourceKind: string
      evidenceRefs: string[]
      atomIds: string[]
    }>
  }
}

export type MemoryAtomManagementRequest =
  | { action: 'move'; atomId: string; expectedRevision: number; parentNodeId?: string; reason: string }
  | {
      action: 'merge'
      atomId: string
      expectedRevision: number
      targetAtomId: string
      targetExpectedRevision: number
      reason: string
    }
  | { action: 'invalidate' | 'reactivate'; atomId: string; expectedRevision: number; reason: string }

export interface MemoryAtomManagementResponse {
  action: MemoryAtomManagementAction
  atoms: Array<{
    id: string
    revision: number
    parentId?: string
    status: 'active' | 'archived' | 'tombstone'
    epistemicStatus: string
    resolutionStatus: string
  }>
  audit: {
    id: string
    action: MemoryAtomManagementAction
    at: string
    reason: string
    atomIds: string[]
  }
}

export interface MemoryAtomEvidenceExportResponse {
  cancelled: boolean
  export?: {
    outputPath: string
    atomId: string
    revision: number
    rawRecordCount: number
    exportedAt: string
  }
}

export interface MemoryV3MigrationPreflightOverview {
  checkedAt: string
  activeBackend: 'v2' | 'v3'
  previousBackend?: 'v2' | 'v3'
  pendingOperation?: {
    kind: 'migration' | 'rollback'
    phase: 'requested' | 'snapshot' | 'building' | 'validating' | 'ready' | 'committing' | 'recovery'
    attempts: number
    createdAt: string
    updatedAt: string
    error?: string
  }
  requiresRestart: boolean
  canCancel: boolean
  canMigrate: boolean
  canResume: boolean
  rollbackAvailable: boolean
  blockers: string[]
  source?: {
    fileCount: number
    totalBytes: number
    nodeCount: number
    resourceCount: number
  }
  storage?: {
    requiredBytes: number
    availableBytes: number
  }
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
  repository: MemoryRepositoryOverview
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
