import type { Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import type { ProjectIndex } from './project-index.js'

const LEGACY_MEMORY_MIGRATION_ID = 'legacy-user-data-v1'
const BRANCH_ORDER = ['long-term', 'project', 'daily', 'experience'] as const

export type MemoryNodeManagementAction = 'archive' | 'restore' | 'delete' | 'promote' | 'demote'
export type ManageRuntimeMemoryNodeResult =
  | { status: 'not_found' }
  | { status: 'invalid'; error: string }
  | { status: 'changed'; node: unknown; audit: unknown }

export async function manageRuntimeMemoryNode(
  runner: AgentRunner,
  nodeId: string,
  action: MemoryNodeManagementAction,
  reason?: string,
): Promise<ManageRuntimeMemoryNodeResult> {
  const existing = await runner.infra.memoryRepository.getNode(nodeId)
  if (!existing || existing.isBranchRoot) return { status: 'not_found' as const }
  try {
    const result = await runner.infra.memoryRepository.manageNode(
      nodeId,
      action,
      reason || `User selected ${action} in the memory-tree management page.`,
    )
    if (!result) return { status: 'not_found' as const }
    await runner.infra.memoryTree.invalidateBranch(existing.branch)
    return { status: 'changed' as const, ...result }
  } catch (error) {
    return { status: 'invalid' as const, error: (error as Error).message }
  }
}

export async function buildMemoryTreePayload(
  runner: AgentRunner,
  projectIndex: ProjectIndex,
  config: Config,
): Promise<Record<string, unknown>> {
  const projects = await projectIndex.list()
  const treeDocument = await runner.infra.memoryRepository.snapshot()
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

  const writeHistory = new Map<string, typeof treeDocument.writeAudit>()
  for (const audit of treeDocument.writeAudit) {
    if (!audit.nodeId) continue
    const current = writeHistory.get(audit.nodeId) ?? []
    current.push(audit)
    writeHistory.set(audit.nodeId, current)
  }
  const managementHistory = new Map<string, typeof treeDocument.managementAudit>()
  for (const audit of treeDocument.managementAudit) {
    const current = managementHistory.get(audit.nodeId) ?? []
    current.push(audit)
    managementHistory.set(audit.nodeId, current)
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
  for (const ledger of runner.infra.memoryTree.listLedgers(80)) {
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
        content: node.content,
        retrievalKeys: node.retrievalKeys,
        importance: node.importance,
        confidence: node.confidence,
        reason: node.reason,
        sourceRunIds: node.sourceRunIds,
        sourceStages: node.sourceStages,
        sourceRefs: node.sourceRefs ?? [],
        status: node.status,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        hitCount: recentHits.length,
        recentHits: recentHits.slice(0, 5),
        writeHistory: (writeHistory.get(node.id) ?? []).slice(-8).reverse(),
        managementHistory: (managementHistory.get(node.id) ?? []).slice(-8).reverse(),
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
  const branches = runner.infra.memoryTree.list()
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

  const longTermExcerpt = [
    ...(activeByBranch.get('long-term') ?? []).slice(0, 10).map((node) => `- **${node.summary}**\n  ${node.content}`),
    legacyLongTerm.trim(),
  ].filter(Boolean).join('\n\n')
  const indexedDailyDates = (activeByBranch.get('daily') ?? []).map((node) => node.createdAt.slice(0, 10))
  const dailyDates = [...new Set([...legacyDailyDates, ...indexedDailyDates])].sort().slice(-14).reverse()
  const recentAccesses = nodes
    .flatMap((node) => node.recentHits.map((hit) => ({ nodeId: node.id, summary: node.summary, branch: node.branch, ...hit })))
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 30)

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      branches: branches.length,
      projects: projects.length,
      dailyMemories: (activeByBranch.get('daily')?.length ?? 0) + legacyDailyDates.length,
      experiences: (activeByBranch.get('experience')?.length ?? 0) + legacyExperienceCount,
      longTermChars: longTermExcerpt.trim().length,
      indexedMemories: activeNodes.length,
      archivedMemories: visibleNodes.filter((node) => node.status === 'archived').length,
      deletedMemories: allNodes.filter((node) => node.status === 'deleted').length,
      recoveryQueue: treeDocument.recoveryQueue.length,
    },
    branches,
    nodes,
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      lastActiveAt: project.lastActiveAt,
    })),
    dailyDates,
    longTermExcerpt: longTermExcerpt.slice(0, 1_600),
    recentAccesses,
    migration: migration ?? null,
    learningPolicy: {
      experienceWriteThreshold: config.memory.experienceWriteThreshold,
    },
  }
}

function normalizePath(value: string): string {
  return value.trim().replace(/[\\/]+/g, '/').replace(/\/$/, '').toLocaleLowerCase()
}
