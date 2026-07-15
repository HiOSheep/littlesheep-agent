// Applies one normalized write intent and refreshes the affected index ancestors.

import { randomUUID } from 'node:crypto';
import type {
  MemoryNode,
  MemoryTreeDocument,
  MemoryWriteAuditRecord,
  MemoryWriteIntent,
  MemoryWritePolicy,
  MemoryWriteResult,
} from '../types.js';
import { MEMORY_BRANCH_ROOTS } from './document-store.js';
import {
  equivalentMemoryNode,
  memoryIntentRejectionReason,
  memoryNodeSimilarity,
} from './write-policy.js';
import { unique } from './text.js';

export function applyMemoryIntent(
  document: MemoryTreeDocument,
  intent: MemoryWriteIntent,
  policy: MemoryWritePolicy,
  queueOnMissingParent = true,
): MemoryWriteResult {
  const intentId = intent.id!;
  const rejection = memoryIntentRejectionReason(intent, policy);
  if (rejection) {
    auditMemoryWrite(document, intent, policy, 'rejected', rejection);
    return { intentId, decision: 'rejected', reason: rejection };
  }

  const parent = document.nodes[intent.parentNodeId];
  if (!parent || parent.branch !== intent.branch || parent.status !== 'active') {
    const reason = `Parent node "${intent.parentNodeId}" is unavailable in branch "${intent.branch}".`;
    if (queueOnMissingParent) {
      const queuedId = randomUUID();
      document.recoveryQueue.push({ id: queuedId, intent, error: reason, queuedAt: new Date().toISOString(), attempts: 0 });
      auditMemoryWrite(document, intent, policy, 'queued', reason);
      return { intentId, decision: 'queued', reason, queuedId };
    }
    auditMemoryWrite(document, intent, policy, 'queued', reason);
    document.recoveryQueue.push({
      id: randomUUID(),
      intent,
      error: reason,
      queuedAt: new Date().toISOString(),
      attempts: 1,
    });
    return { intentId, decision: 'queued', reason };
  }

  const candidates = Object.values(document.nodes).filter((node) =>
    !node.isBranchRoot
    && node.status === 'active'
    && node.branch === intent.branch
    && node.scope === intent.scope
    && (node.scopeKey ?? '') === (intent.scopeKey ?? ''),
  );
  const exact = candidates.find((node) => equivalentMemoryNode(node, intent));
  if (exact) {
    reinforceMemoryNode(exact, intent);
    refreshMemoryAncestors(document, exact.parentNodeId);
    auditMemoryWrite(
      document,
      intent,
      policy,
      'reinforced',
      'An equivalent indexed memory already exists; provenance and confidence were reinforced.',
      exact.id,
    );
    return {
      intentId,
      decision: 'reinforced',
      reason: 'Equivalent indexed memory reinforced.',
      node: structuredClone(exact),
    };
  }

  const similar = candidates
    .map((node) => ({ node, score: memoryNodeSimilarity(node, intent) }))
    .sort((left, right) => right.score - left.score)[0];
  if (similar && similar.score >= policy.duplicateSimilarityThreshold) {
    mergeMemoryNode(similar.node, intent);
    refreshMemoryAncestors(document, similar.node.parentNodeId);
    const reason = `Merged with indexed memory ${similar.node.id} (similarity ${similar.score.toFixed(2)}).`;
    auditMemoryWrite(document, intent, policy, 'merged', reason, similar.node.id);
    return { intentId, decision: 'merged', reason, node: structuredClone(similar.node) };
  }

  const now = intent.createdAt!;
  const node: MemoryNode = {
    id: randomUUID(),
    branch: intent.branch,
    parentNodeId: parent.id,
    childIds: [],
    scope: intent.scope,
    scopeKey: intent.scopeKey,
    tier: intent.tier,
    summary: intent.summary,
    content: intent.content,
    retrievalKeys: intent.retrievalKeys,
    importance: intent.importance,
    confidence: intent.confidence,
    reason: intent.reason,
    sourceRunIds: [intent.sourceRunId],
    sourceStages: [intent.sourceStage],
    sourceRefs: intent.sourceRefs,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  document.nodes[node.id] = node;
  parent.childIds = unique([...parent.childIds, node.id]);
  refreshMemoryAncestors(document, parent.id);
  auditMemoryWrite(document, intent, policy, 'created', 'Created an indexed memory node and refreshed its parent index.', node.id);
  return { intentId, decision: 'created', reason: 'Indexed memory created.', node: structuredClone(node) };
}

export function refreshMemoryAncestors(document: MemoryTreeDocument, startingId: string | undefined): void {
  let currentId = startingId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = document.nodes[currentId];
    if (!node) break;
    const activeChildren = node.childIds
      .map((id) => document.nodes[id])
      .filter((child): child is MemoryNode => !!child && child.status === 'active');
    if (node.isBranchRoot) {
      const base = MEMORY_BRANCH_ROOTS[node.branch].summary;
      const recent = activeChildren.slice(-3).map((child) => child.summary).join(' | ');
      node.summary = `${base} ${activeChildren.length} indexed item(s).${recent ? ` Recent: ${recent}` : ''}`;
    }
    node.retrievalKeys = unique([
      ...node.retrievalKeys,
      ...activeChildren.flatMap((child) => child.retrievalKeys.slice(0, 4)),
    ]).slice(0, 64);
    node.updatedAt = new Date().toISOString();
    currentId = node.parentNodeId;
  }
}

function reinforceMemoryNode(node: MemoryNode, intent: MemoryWriteIntent): void {
  node.confidence = Math.max(node.confidence, intent.confidence);
  node.importance = Math.max(node.importance, intent.importance);
  node.retrievalKeys = unique([...node.retrievalKeys, ...intent.retrievalKeys]);
  node.sourceRunIds = unique([...node.sourceRunIds, intent.sourceRunId]);
  node.sourceStages = unique([...node.sourceStages, intent.sourceStage]);
  node.sourceRefs = unique([...(node.sourceRefs ?? []), ...(intent.sourceRefs ?? [])]);
  node.reason = intent.reason || node.reason;
  node.updatedAt = new Date().toISOString();
}

function mergeMemoryNode(node: MemoryNode, intent: MemoryWriteIntent): void {
  const shouldReplace = intent.confidence >= node.confidence
    && intent.content.length >= Math.floor(node.content.length * 0.7);
  if (shouldReplace) {
    node.summary = intent.summary;
    node.content = intent.content;
    node.reason = intent.reason;
  }
  node.retrievalKeys = unique([...node.retrievalKeys, ...intent.retrievalKeys]);
  node.sourceRunIds = unique([...node.sourceRunIds, intent.sourceRunId]);
  node.sourceStages = unique([...node.sourceStages, intent.sourceStage]);
  node.sourceRefs = unique([...(node.sourceRefs ?? []), ...(intent.sourceRefs ?? [])]);
  node.mergedFrom = unique([...(node.mergedFrom ?? []), intent.id!]);
  node.importance = Math.max(node.importance, intent.importance);
  node.confidence = Math.max(node.confidence, intent.confidence);
  node.updatedAt = new Date().toISOString();
}

function auditMemoryWrite(
  document: MemoryTreeDocument,
  intent: MemoryWriteIntent,
  policy: MemoryWritePolicy,
  decision: MemoryWriteAuditRecord['decision'],
  reason: string,
  nodeId?: string,
): void {
  document.writeAudit.push({
    id: randomUUID(),
    intentId: intent.id!,
    sourceRunId: intent.sourceRunId,
    branch: intent.branch,
    at: new Date().toISOString(),
    decision,
    nodeId,
    reason,
  });
  if (document.writeAudit.length > policy.maxAuditRecords) {
    document.writeAudit.splice(0, document.writeAudit.length - policy.maxAuditRecords);
  }
}
