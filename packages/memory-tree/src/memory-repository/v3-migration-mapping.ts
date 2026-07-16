// Maps validated Memory v2 nodes to stable Memory v3 atoms and graph entities.

import type { MemoryNode, MemoryTreeDocument, MemoryWriteIntent } from '../types.js';
import type { MemoryEntity } from '../v3/contracts.js';
import type { MemoryRepositoryV3Backend } from './v3-backend.js';
import { classifyMemoryWriteIntent } from './v3-statement.js';
import {
  createMemoryAtomInput,
  legacySourceEvidence,
  memoryV3ScopeRootId,
  mergedIntentEvidence,
  scopeEntity,
  sourceEntity,
  sourceRefEntityType,
} from './v3-node-mapping.js';
import { cleanText, unique } from './text.js';

export async function memoryV2NodeToAtomInput(
  backend: MemoryRepositoryV3Backend,
  node: MemoryNode,
  storageScopeKey: string | undefined,
) {
  const intent = memoryV2NodeAsIntent(node);
  const classification = classifyMemoryWriteIntent(intent);
  if (classification.relationRefs.length > 0) {
    throw new Error(`Memory v2 node ${node.id} references relations without a v2 graph source.`);
  }
  const entityRefs = new Set<string>();
  const scoped = scopeEntity(node.scope, storageScopeKey, node.scopeKey, node.updatedAt);
  if (scoped) {
    await backend.graphStore.upsertEntity(scoped);
    entityRefs.add(scoped.id);
  }
  for (const sourceRef of node.sourceRefs ?? []) {
    const candidate = sourceEntity(sourceRef, node.scope, storageScopeKey, node.updatedAt);
    const existing = await backend.graphStore.getEntity(candidate.id);
    const entity = sourceEntity(sourceRef, node.scope, storageScopeKey, node.updatedAt, existing);
    await backend.graphStore.upsertEntity(entity);
    entityRefs.add(entity.id);
  }
  for (const entityId of classification.entityRefs) {
    const existing = await backend.graphStore.getEntity(entityId);
    if (!existing) await backend.graphStore.upsertEntity(legacyEntity(entityId, node, storageScopeKey));
    entityRefs.add(entityId);
  }

  const parentId = node.parentNodeId === `${node.branch}:root`
    ? memoryV3ScopeRootId(node.branch, node.scope, storageScopeKey)
    : node.parentNodeId!;
  const created = createMemoryAtomInput({
    id: node.id,
    parentId,
    branch: node.branch,
    scope: node.scope,
    storageScopeKey,
    tier: node.tier,
    summary: node.summary,
    content: node.content,
    retrievalKeys: node.retrievalKeys,
    importance: node.importance,
    confidence: node.confidence,
    reason: node.reason,
    sourceRunId: node.sourceRunIds[0] ?? `memory-v2:${node.id}`,
    sourceStage: node.sourceStages[0] ?? 'migration',
    sourceRefs: [],
    entityRefs: [...entityRefs],
    relationRefs: [],
    classification,
    createdAt: node.createdAt,
  });
  return {
    ...created,
    title: node.summary,
    sourceRefs: [],
    mergedIntentIds: unique(node.mergedFrom ?? []),
    sourceRunIds: [...node.sourceRunIds],
    sourceStages: [...node.sourceStages],
    status: node.status === 'deleted' ? 'tombstone' as const : node.status,
    updatedAt: node.updatedAt,
  };
}

export function memoryV2NodeAsIntent(node: MemoryNode): MemoryWriteIntent {
  return {
    id: `memory-v2-migration:${node.id}`,
    branch: node.branch,
    parentNodeId: node.parentNodeId!,
    scope: node.scope,
    scopeKey: node.scopeKey,
    tier: node.tier,
    summary: node.summary,
    content: node.content,
    retrievalKeys: node.retrievalKeys,
    sourceRunId: node.sourceRunIds[0] ?? `memory-v2:${node.id}`,
    sourceStage: node.sourceStages[0] ?? 'migration',
    sourceRefs: [],
    evidenceRefs: unique((node.sourceRefs ?? []).map(legacySourceEvidence)),
    importance: node.importance,
    confidence: node.confidence,
    reason: node.reason,
    createdAt: node.createdAt,
  };
}

export function publicMemoryV2Nodes(document: MemoryTreeDocument): MemoryNode[] {
  return Object.values(document.nodes).filter((node) => !node.isBranchRoot);
}

export function orderedPublicMemoryV2Nodes(document: MemoryTreeDocument): MemoryNode[] {
  const depth = new Map<string, number>();
  const resolveDepth = (node: MemoryNode): number => {
    const cached = depth.get(node.id);
    if (cached !== undefined) return cached;
    const parent = node.parentNodeId ? document.nodes[node.parentNodeId] : undefined;
    const value = !parent || parent.isBranchRoot ? 1 : resolveDepth(parent) + 1;
    depth.set(node.id, value);
    return value;
  };
  return publicMemoryV2Nodes(document)
    .sort((left, right) => resolveDepth(left) - resolveDepth(right) || left.id.localeCompare(right.id));
}

function legacyEntity(id: string, node: MemoryNode, storageScopeKey: string | undefined): MemoryEntity {
  return {
    version: 1,
    id,
    type: sourceRefEntityType(id),
    owner: { kind: 'external', id },
    scope: node.scope,
    scopeKey: storageScopeKey,
    externalKey: id,
    label: cleanText(id).slice(0, 240) || id,
    aliases: [],
    status: 'active',
    revision: 1,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}
