// Builds deterministic repository events, audits, and lifecycle mutations for Memory v3 nodes.

import { createHash, randomUUID } from 'node:crypto';
import { InjectionTier } from '../types.js';
import type {
  MemoryBranchKind,
  MemoryManagementAction,
  MemoryNode,
  MemoryWriteAuditRecord,
  MemoryWriteIntent,
} from '../types.js';
import type {
  MemoryAtom,
  MemoryStorageMutation,
  MemoryUpdateEvent,
  MemoryUpdateEventKind,
} from '../v3/contracts.js';
import { MEMORY_EVENT_VERSION } from '../v3/contracts.js';
import { MEMORY_BRANCH_ROOTS, memoryBranchRootId } from './document-store.js';
import type { ClassifiedMemoryStatement } from './v3-statement.js';

export function intentEvent(
  intent: MemoryWriteIntent,
  classification: ClassifiedMemoryStatement,
  storageScopeKey: string | undefined,
  decision: MemoryWriteAuditRecord['decision'],
  audit: MemoryWriteAuditRecord,
  atomId: string,
  expectedRevision?: number,
): MemoryUpdateEvent {
  const observedAt = new Date().toISOString();
  return {
    version: MEMORY_EVENT_VERSION,
    id: randomUUID(),
    idempotencyKey: `memory-repository:${intent.id}:${decision}:${atomId}:${expectedRevision ?? 0}`,
    kind: eventKindForStage(intent.sourceStage),
    domain: classification.domain,
    scope: intent.scope,
    scopeKey: storageScopeKey,
    atomId,
    expectedAtomRevision: expectedRevision,
    source: classification.assertedBy,
    occurredAt: intent.createdAt!,
    observedAt,
    evidenceRefs: classification.evidenceRefs,
    payload: {
      statementKind: classification.statementKind,
      epistemicStatus: classification.epistemicStatus,
      repositoryWriteAudit: audit,
    },
  };
}

export function repositoryEvent(
  atom: MemoryAtom,
  action: string,
  kind: MemoryUpdateEventKind,
  payload: Record<string, unknown> | undefined,
): MemoryUpdateEvent {
  const now = new Date().toISOString();
  return {
    version: MEMORY_EVENT_VERSION,
    id: randomUUID(),
    idempotencyKey: `memory-repository:${atom.id}:${atom.revision}:${action}`,
    kind,
    domain: atom.domain,
    scope: atom.scope,
    scopeKey: atom.scopeKey,
    atomId: atom.id,
    expectedAtomRevision: atom.revision,
    source: { kind: 'user' },
    occurredAt: now,
    observedAt: now,
    evidenceRefs: [`memory-atom:${atom.id}@${atom.revision}`],
    payload: payload ?? {},
  };
}

export function writeAudit(
  intent: MemoryWriteIntent,
  decision: MemoryWriteAuditRecord['decision'],
  reason: string,
  nodeId?: string,
): MemoryWriteAuditRecord {
  const digest = createHash('sha256')
    .update(`${intent.id}\0${decision}\0${nodeId ?? ''}`, 'utf8')
    .digest('hex');
  return {
    id: `memory-write-audit:${digest}`,
    intentId: intent.id!,
    sourceRunId: intent.sourceRunId,
    branch: intent.branch,
    at: new Date().toISOString(),
    decision,
    nodeId,
    reason,
  };
}

export function atomIdForIntent(intentId: string): string {
  return `memory-atom:${createHash('sha256').update(intentId, 'utf8').digest('hex')}`;
}

export function branchForRootId(id: string): MemoryBranchKind | undefined {
  return (Object.keys(MEMORY_BRANCH_ROOTS) as MemoryBranchKind[])
    .find((branch) => memoryBranchRootId(branch) === id);
}

export function statusMutation(atom: MemoryAtom, status: MemoryNode['status']): MemoryStorageMutation {
  if (status === 'archived') return { kind: 'archive', atomId: atom.id, expectedRevision: atom.revision };
  if (status === 'active' && atom.status === 'archived') {
    return { kind: 'restore', atomId: atom.id, expectedRevision: atom.revision };
  }
  return {
    kind: 'update',
    atomId: atom.id,
    expectedRevision: atom.revision,
    patch: { status: status === 'deleted' ? 'tombstone' : status },
  };
}

export function managementMutation(
  atom: MemoryAtom,
  action: MemoryManagementAction,
): { mutation: MemoryStorageMutation; toStatus: MemoryNode['status']; toTier: InjectionTier } {
  if (action === 'archive') {
    if (atom.status !== 'active') throw new Error('Only active memories can be archived.');
    return {
      mutation: { kind: 'archive', atomId: atom.id, expectedRevision: atom.revision },
      toStatus: 'archived',
      toTier: atom.tier,
    };
  }
  if (action === 'restore') {
    if (atom.status !== 'archived') throw new Error('Only archived memories can be restored.');
    return {
      mutation: { kind: 'restore', atomId: atom.id, expectedRevision: atom.revision },
      toStatus: 'active',
      toTier: atom.tier,
    };
  }
  if (action === 'delete') {
    if (atom.status === 'tombstone') throw new Error('This memory has already been deleted.');
    return {
      mutation: { kind: 'update', atomId: atom.id, expectedRevision: atom.revision, patch: { status: 'tombstone' } },
      toStatus: 'deleted',
      toTier: atom.tier,
    };
  }
  if (atom.status !== 'active') throw new Error('Only active memories can change injection tier.');
  const highestTier = atom.branch === 'daily' ? InjectionTier.T2_RELEVANT : InjectionTier.T1_ESSENTIAL;
  if (action === 'promote') {
    if (atom.tier <= highestTier) throw new Error('This memory is already at its highest allowed tier.');
    const tier = atom.tier - 1 as InjectionTier;
    return {
      mutation: { kind: 'update', atomId: atom.id, expectedRevision: atom.revision, patch: { tier } },
      toStatus: 'active',
      toTier: tier,
    };
  }
  if (atom.tier >= InjectionTier.T3_DETAIL) throw new Error('This memory is already at T3.');
  const tier = atom.tier + 1 as InjectionTier;
  return {
    mutation: { kind: 'update', atomId: atom.id, expectedRevision: atom.revision, patch: { tier } },
    toStatus: 'active',
    toTier: tier,
  };
}

export function strongerEpistemicStatus(
  current: MemoryAtom['epistemicStatus'],
  incoming: MemoryAtom['epistemicStatus'],
): MemoryAtom['epistemicStatus'] {
  const rank: Record<MemoryAtom['epistemicStatus'], number> = {
    superseded: 0,
    disputed: 1,
    unverified: 2,
    reported: 3,
    corroborated: 4,
    verified: 5,
  };
  return rank[incoming] > rank[current] ? incoming : current;
}

export function strongerResolutionStatus(
  current: MemoryAtom['resolutionStatus'],
  incoming: MemoryAtom['resolutionStatus'],
): MemoryAtom['resolutionStatus'] {
  const rank: Record<MemoryAtom['resolutionStatus'], number> = {
    unresolved: 0,
    proposed: 1,
    'under-review': 2,
    adopted: 3,
    rejected: 3,
    resolved: 4,
    superseded: 5,
  };
  return rank[incoming] > rank[current] ? incoming : current;
}

function eventKindForStage(stage: MemoryWriteIntent['sourceStage']): MemoryUpdateEventKind {
  if (stage === 'tool') return 'tool-evidence';
  if (stage === 'capture') return 'task-state';
  if (stage === 'evolve') return 'agent-capability-change';
  return 'resource-change';
}
