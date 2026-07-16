// Adapts MemoryService queries and guarded management commands for Local App API.
// It does not own a second memory index or bypass repository lifecycle rules.
import type { Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import type {
  MemoryResourceManagementAction,
  MemoryTreeDisclosureLevel,
  MemoryTreeManagementAction,
  MemoryTreeNodeDetail,
  MemoryTreeOverview,
  ProjectMemoryProjectionState,
} from '../shared/memory-control-contracts.js'
import type { ProjectIndex } from './project-index.js'

const LEGACY_MEMORY_MIGRATION_ID = 'legacy-user-data-v1'
const BRANCH_ORDER = ['long-term', 'project', 'daily', 'experience'] as const
const NODE_ACTION_LABELS: Record<MemoryTreeManagementAction, string> = {
  archive: '归档',
  restore: '恢复',
  delete: '删除',
  promote: '提升层级',
  demote: '降低层级',
}
const RESOURCE_ACTION_LABELS: Record<Exclude<MemoryResourceManagementAction, 'rebind'>, string> = {
  disable: '停用',
  restore: '恢复',
  remove: '移除登记',
}

export type {
  MemoryResourceManagementAction,
  MemoryTreeManagementAction as MemoryNodeManagementAction,
} from '../shared/memory-control-contracts.js'
export type ManageRuntimeMemoryNodeResult =
  | { status: 'not_found' }
  | { status: 'invalid'; error: string }
  | { status: 'changed'; node: unknown; audit: unknown }

export async function manageRuntimeMemoryNode(
  runner: AgentRunner,
  nodeId: string,
  action: MemoryTreeManagementAction,
  reason?: string,
): Promise<ManageRuntimeMemoryNodeResult> {
  const existing = await runner.infra.memoryService.getNode(nodeId)
  if (!existing || existing.isBranchRoot) return { status: 'not_found' as const }
  try {
    const result = await runner.infra.memoryService.manageNode(
      nodeId,
      action,
      reason || `用户在记忆树管理页面执行了“${NODE_ACTION_LABELS[action]}”操作。`,
    )
    if (!result) return { status: 'not_found' as const }
    return { status: 'changed' as const, ...result }
  } catch (error) {
    return { status: 'invalid' as const, error: (error as Error).message }
  }
}

export type ManageRuntimeMemoryResourceResult =
  | { status: 'not_found' }
  | { status: 'invalid'; error: string }
  | { status: 'changed'; result: unknown }

export async function manageRuntimeMemoryResource(
  runner: AgentRunner,
  resourceId: string,
  action: MemoryResourceManagementAction,
  options: { sourcePath?: string; reason?: string } = {},
): Promise<ManageRuntimeMemoryResourceResult> {
  try {
    if (action === 'rebind' && !options.sourcePath?.trim()) {
      return { status: 'invalid', error: '重新定位记忆资源时必须提供来源路径。' }
    }
    const result = action === 'rebind'
      ? await runner.infra.memoryService.rebindResourceSource(
          resourceId,
          options.sourcePath ?? '',
          options.reason || '用户从记忆树管理页面重新定位了资源。',
        )
      : await runner.infra.memoryService.manageResource(
          resourceId,
          action,
          options.reason || `用户在记忆树资源目录执行了“${RESOURCE_ACTION_LABELS[action]}”操作。`,
        )
    if (!result) return { status: 'not_found' }
    return { status: 'changed', result }
  } catch (error) {
    return { status: 'invalid', error: (error as Error).message }
  }
}

export async function buildMemoryTreeNodeDetail(
  runner: AgentRunner,
  nodeId: string,
  disclosureLevel: MemoryTreeDisclosureLevel,
): Promise<MemoryTreeNodeDetail | undefined> {
  const node = await runner.infra.memoryService.getNode(nodeId)
  if (!node || node.isBranchRoot || node.status === 'deleted') return undefined
  const inspection = await runner.infra.memoryRepository.management.inspectNode(nodeId, disclosureLevel)
  if (!inspection) return undefined
  const snapshot = disclosureLevel === 'D3'
    ? await runner.infra.memoryService.getManagementSnapshot()
    : undefined
  const recentHits = snapshot ? snapshot.ledgers.flatMap((ledger) => ledger.records
    .filter((record) => (record.action === 'expand' || record.action === 'deep_search') && record.fragmentIds.includes(nodeId))
    .map((record) => ({
      runId: ledger.runId,
      sessionId: String(ledger.sessionId),
      at: record.at,
      action: record.action as 'expand' | 'deep_search',
      query: record.query,
      reason: record.reason,
    })))
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 12) : []
  const writeHistory = snapshot?.document.writeAudit
    .filter((record) => record.nodeId === nodeId)
    .slice(-16)
    .reverse() ?? []
  const managementHistory = snapshot?.document.managementAudit
    .filter((record) => record.nodeId === nodeId)
    .slice(-16)
    .reverse() ?? []
  const atom = inspection.atom
  const catalog = inspection.catalog
  const envelope = inspection.envelope
  const sourceRecords = disclosureLevel === 'D3' && atom
    ? await runner.infra.memoryService.listConversationSources(atom.sourceRefs, 100)
    : []
  return {
    nodeId,
    backendKind: inspection.backendKind,
    disclosureLevel,
    content: node.content,
    retrievalKeys: node.retrievalKeys,
    reason: node.reason,
    sourceRunIds: node.sourceRunIds,
    sourceStages: node.sourceStages,
    sourceRefs: node.sourceRefs ?? [],
    recentHits,
    writeHistory,
    managementHistory,
    v3: atom && catalog && envelope ? {
      revision: atom.revision,
      domain: atom.domain,
      statementKind: atom.statementKind,
      epistemicStatus: atom.epistemicStatus,
      resolutionStatus: atom.resolutionStatus,
      authorityScope: atom.authorityScope,
      assertedBy: atom.assertedBy,
      sourceRefs: atom.sourceRefs,
      evidenceRefs: atom.evidenceRefs,
      effectiveAt: atom.effectiveAt,
      expiresAt: atom.expiresAt,
      revalidateAt: atom.revalidateAt,
      lastVerifiedAt: atom.lastVerifiedAt,
      lastUsefulAt: atom.lastUsefulAt,
      verifiedUsefulness: atom.verifiedUsefulness,
      embedding: {
        status: catalog.embeddingStatus,
        engineId: catalog.embeddingEngineId,
        modelId: catalog.embeddingModelId,
        dimensions: catalog.embeddingDimensions,
      },
      conflict: envelope.conflict,
      expired: envelope.expired,
      neighborhood: inspection.neighborhood ? {
        entities: inspection.neighborhood.entities.map((entity) => ({
          id: entity.id,
          type: entity.type,
          label: entity.label,
          status: entity.status,
        })),
        relations: inspection.neighborhood.relations.map((relation) => ({
          id: relation.id,
          fromEntityId: relation.fromEntityId,
          toEntityId: relation.toEntityId,
          type: relation.type,
          status: relation.status,
          confidence: relation.confidence,
          relevance: relation.relevance,
        })),
        truncated: inspection.neighborhood.truncated,
      } : undefined,
      history: inspection.history ? {
        revision: inspection.history.revision,
        entries: inspection.history.entries,
        truncated: inspection.history.truncated,
      } : undefined,
      sourceRecords: disclosureLevel === 'D3' ? sourceRecords.map((record) => ({
        id: record.id,
        kind: record.kind,
        sessionId: record.sessionId,
        runId: record.runId,
        occurredAt: record.occurredAt,
        summary: sourceRecordSummary(record.payload),
      })) : undefined,
      projectionRecords: inspection.projectionRecords?.map((record) => ({
        id: record.id,
        kind: record.event.kind,
        capturedAt: record.capturedAt,
        occurredAt: record.event.occurredAt,
        sourceKind: record.event.source.kind,
        evidenceRefs: record.event.evidenceRefs,
        atomIds: record.atomIds,
      })),
    } : undefined,
  }
}

function sourceRecordSummary(payload: Record<string, unknown>): string {
  const text = typeof payload.text === 'string'
    ? payload.text
    : typeof payload.description === 'string'
      ? payload.description
      : typeof payload.name === 'string'
        ? payload.name
        : typeof payload.message === 'string'
          ? payload.message
          : ''
  if (text.trim()) return text.replace(/[\r\n]+/gu, ' ').trim().slice(0, 180)
  const keys = Object.keys(payload).slice(0, 6)
  return keys.length > 0 ? keys.join(' · ') : '可见对话记录'
}

export async function buildMemoryTreePayload(
  runner: AgentRunner,
  projectIndex: ProjectIndex,
  config: Config,
): Promise<MemoryTreeOverview> {
  const projects = await projectIndex.list()
  const projectionStates = await runner.infra.memoryService.listProjectMemoryProjectionStates(
    projects.map((project) => ({ id: project.id, name: project.name, path: project.path })),
  )
  // Projection inspection also reconciles derived resource status. Read the
  // management snapshot afterwards so one payload cannot report conflicting records.
  const memorySnapshot = await runner.infra.memoryService.getManagementSnapshot()
  const repository = await runner.infra.memoryRepository.management.status()
  const projectionByProjectId = new Map(projectionStates.map((state) => [state.projectId, state]))
  const treeDocument = memorySnapshot.document
  const migration = treeDocument.migrations[LEGACY_MEMORY_MIGRATION_ID]
  const allNodes = Object.values(treeDocument.nodes).filter((node) => !node.isBranchRoot)
  const activeNodes = allNodes.filter((node) => node.status === 'active')
  const visibleNodes = allNodes.filter((node) => node.status !== 'deleted')
  const activeByBranch = new Map<string, typeof activeNodes>()
  for (const node of activeNodes) {
    const current = activeByBranch.get(node.branch) ?? []
    current.push(node)
    activeByBranch.set(node.branch, current)
  }

  let legacyLongTerm = ''
  let legacyDailyDates: string[] = []
  let legacyExperienceCount = 0
  if (!migration) {
    try { legacyLongTerm = await runner.infra.memoryStore.readLongTerm() } catch { /* absent legacy source */ }
    try { legacyDailyDates = await runner.infra.memoryStore.listDailyDates() } catch { /* absent legacy source */ }
    try { legacyExperienceCount = (await runner.infra.experienceStore.list()).length } catch { /* absent legacy source */ }
  }

  const resourceManagementHistory = new Map<string, typeof treeDocument.resourceManagementAudit>()
  for (const audit of treeDocument.resourceManagementAudit) {
    const current = resourceManagementHistory.get(audit.resourceId) ?? []
    current.push(audit)
    resourceManagementHistory.set(audit.resourceId, current)
  }

  type RecentHit = {
    runId: string
    sessionId: string
    at: string
    action: 'expand' | 'deep_search'
    query?: string
    reason?: string
  }
  const hitsByNode = new Map<string, RecentHit[]>()
  for (const ledger of memorySnapshot.ledgers) {
    for (const record of ledger.records) {
      if (record.action !== 'expand' && record.action !== 'deep_search') continue
      for (const fragmentId of record.fragmentIds) {
        const current = hitsByNode.get(fragmentId) ?? []
        current.push({
          runId: ledger.runId,
          sessionId: String(ledger.sessionId),
          at: record.at,
          action: record.action,
          query: record.query,
          reason: record.reason,
        })
        hitsByNode.set(fragmentId, current)
      }
    }
  }

  const normalizedProjects = new Map(projects.map((project) => [normalizePath(project.path), project]))
  const nodes = visibleNodes
    .sort((left, right) => {
      const branchDelta = BRANCH_ORDER.indexOf(left.branch) - BRANCH_ORDER.indexOf(right.branch)
      return branchDelta || left.tier - right.tier || right.updatedAt.localeCompare(left.updatedAt)
    })
    .map((node) => {
      const recentHits = (hitsByNode.get(node.id) ?? []).sort((left, right) => right.at.localeCompare(left.at))
      const project = node.scopeKey ? normalizedProjects.get(normalizePath(node.scopeKey)) : undefined
      return {
        id: node.id,
        branch: node.branch,
        parentNodeId: node.parentNodeId,
        childCount: node.childIds.filter((id) => treeDocument.nodes[id]?.status !== 'deleted').length,
        scope: node.scope,
        scopeKey: node.scopeKey,
        project: project ? { id: project.id, name: project.name, path: project.path } : undefined,
        tier: node.tier,
        summary: node.summary,
        retrievalKeys: node.retrievalKeys,
        importance: node.importance,
        confidence: node.confidence,
        reason: node.reason,
        status: node.status === 'archived' ? 'archived' as const : 'active' as const,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        hitCount: recentHits.length,
        atomRevision: node.atomRevision,
        invalidatedAt: node.invalidatedAt,
        mergedIntoId: node.mergedIntoId,
      }
    })

  const branchLabels: Record<string, string> = {
    'long-term': '长期记忆',
    project: '项目记忆',
    daily: '每日流水',
    experience: '经验库',
  }
  const branchTiers: Record<string, string> = {
    'long-term': 'T1/T2',
    project: 'T1/T2',
    daily: 'T2/T3',
    experience: 'T2/T3',
  }
  const legacyCounts: Record<string, number> = migration ? {} : {
    'long-term': legacyLongTerm.trim() ? 1 : 0,
    daily: legacyDailyDates.length,
    experience: legacyExperienceCount,
  }
  const archivedByBranch = new Map<string, number>()
  for (const node of visibleNodes) {
    if (node.status !== 'archived') continue
    archivedByBranch.set(node.branch, (archivedByBranch.get(node.branch) ?? 0) + 1)
  }
  const branches = memorySnapshot.branches
    .filter((branch): branch is typeof branch & { id: (typeof BRANCH_ORDER)[number] } => (
      BRANCH_ORDER.includes(branch.id as (typeof BRANCH_ORDER)[number])
    ))
    .sort((left, right) => (
      BRANCH_ORDER.findIndex((id) => id === left.id)
      - BRANCH_ORDER.findIndex((id) => id === right.id)
    ))
    .map((branch) => {
      const indexedCount = activeByBranch.get(branch.id)?.length ?? 0
      const dynamicCount = branch.id === 'project' ? projects.length : 0
      const count = indexedCount + dynamicCount + (legacyCounts[branch.id] ?? 0)
      return {
        id: branch.id,
        title: branchLabels[branch.id] ?? branch.displayName,
        tier: branchTiers[branch.id] ?? 'T2/T3',
        status: count > 0 ? 'active' as const : 'empty' as const,
        count,
        indexedCount,
        archivedCount: archivedByBranch.get(branch.id) ?? 0,
        source: migration
          ? 'memory-tree/index.json'
          : 'memory-tree/index.json + legacy compatibility sources',
        description: branch.purpose,
        whenToUse: branch.whenToUse,
        searchHints: branch.searchHints,
      }
    })

  const longTermChars = (activeByBranch.get('long-term') ?? [])
    .reduce((total, node) => total + node.content.length, legacyLongTerm.trim().length)
  const indexedDailyDates = (activeByBranch.get('daily') ?? []).map((node) => node.createdAt.slice(0, 10))
  const dailyDates = [...new Set([...legacyDailyDates, ...indexedDailyDates])].sort().slice(-14).reverse()
  const recentAccesses = visibleNodes
    .flatMap((node) => (hitsByNode.get(node.id) ?? []).map((hit) => ({
      nodeId: node.id,
      summary: node.summary,
      branch: node.branch,
      ...hit,
    })))
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 30)

  return {
    generatedAt: new Date().toISOString(),
    repository,
    totals: {
      branches: branches.length,
      projects: projects.length,
      dailyMemories: (activeByBranch.get('daily')?.length ?? 0) + legacyDailyDates.length,
      experiences: (activeByBranch.get('experience')?.length ?? 0) + legacyExperienceCount,
      longTermChars,
      indexedMemories: activeNodes.length,
      archivedMemories: visibleNodes.filter((node) => node.status === 'archived').length,
      deletedMemories: allNodes.filter((node) => node.status === 'deleted').length,
      recoveryQueue: treeDocument.recoveryQueue.length,
      registeredResources: memorySnapshot.resources.length,
      activeResources: memorySnapshot.resources.filter((resource) => resource.status === 'active').length,
    },
    branches,
    nodes,
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      lastActiveAt: project.lastActiveAt,
      projection: publicProjectionState(projectionByProjectId.get(project.id)),
    })),
    resources: memorySnapshot.resources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      title: resource.title,
      description: resource.description,
      tier: resource.tier,
      branch: resource.branch,
      scope: resource.scope,
      scopeKey: resource.scopeKey,
      authority: resource.authority,
      privacy: resource.privacy,
      sourceKind: resource.source.kind,
      sourcePath: resource.source.path,
      indexKeys: resource.indexKeys,
      status: resource.status,
      registryGroup: resource.registryGroup,
      owner: resource.owner,
      updatedAt: resource.updatedAt,
      managementHistory: (resourceManagementHistory.get(resource.id) ?? [])
        .sort((left, right) => right.at.localeCompare(left.at))
        .slice(0, 8),
    })),
    dailyDates,
    recentAccesses,
    migration: migration ?? null,
    learningPolicy: {
      experienceWriteThreshold: config.memory.experienceWriteThreshold,
    },
  }
}

function publicProjectionState(
  state: Awaited<ReturnType<AgentRunner['infra']['memoryService']['getProjectMemoryProjectionState']>> | undefined,
): ProjectMemoryProjectionState | undefined {
  if (!state) return undefined
  return {
    projectId: state.projectId,
    enabled: state.enabled,
    projectionPath: state.projectionPath,
    projectionExists: state.projectionExists,
    safeToRemove: state.safeToRemove,
    status: state.status,
    gitRepository: state.gitRepository,
    gitIgnored: state.gitIgnored,
    gitIgnorePattern: state.gitIgnorePattern,
    sourceRevision: state.sourceRevision,
    entryCount: state.entryCount,
    omittedEntryCount: state.omittedEntryCount,
    lastSyncedAt: state.lastSyncedAt,
    conflictReason: state.conflictReason,
  }
}

function normalizePath(value: string): string {
  return value.trim().replace(/[\\/]+/g, '/').replace(/\/$/, '').toLocaleLowerCase()
}
