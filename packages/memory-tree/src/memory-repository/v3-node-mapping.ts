// Maps stable Memory v3 atoms and entities to the existing MemoryRepository node contract.

import { createHash } from 'node:crypto';
import { InjectionTier, type MemoryBranchKind, type MemoryNode, type MemoryScope } from '../types.js';
import type { CreateMemoryAtomInput, MemoryAtom, MemoryEntity, MemoryEntityType } from '../v3/contracts.js';
import { MEMORY_BRANCH_ROOTS, memoryBranchRootId } from './document-store.js';
import type { ClassifiedMemoryStatement } from './v3-statement.js';
import { unique } from './text.js';

const INTERNAL_SCOPE_ROOT_PREFIX = 'v3-scope-root:';
const MERGED_INTENT_PREFIX = 'memory-intent:';
const INTERNAL_EVIDENCE_PREFIX = 'memory-internal:';

export function memoryV3ScopeRootId(
  branch: MemoryBranchKind,
  scope: MemoryScope,
  storageScopeKey?: string,
): string {
  if (scope === 'global') return memoryBranchRootId(branch);
  const digest = createHash('sha256')
    .update(`${branch}\0${scope}\0${storageScopeKey ?? ''}`, 'utf8')
    .digest('hex');
  return `${INTERNAL_SCOPE_ROOT_PREFIX}${digest}`;
}

export function isMemoryV3InternalRootId(id: string): boolean {
  return id.startsWith(INTERNAL_SCOPE_ROOT_PREFIX)
    || (['long-term', 'daily', 'project', 'experience'] as MemoryBranchKind[])
      .some((branch) => id === memoryBranchRootId(branch));
}

export function createMemoryV3ScopeRoot(
  branch: MemoryBranchKind,
  scope: MemoryScope,
  storageScopeKey: string | undefined,
  now: string,
): CreateMemoryAtomInput {
  const spec = MEMORY_BRANCH_ROOTS[branch];
  return {
    id: memoryV3ScopeRootId(branch, scope, storageScopeKey),
    domain: branchDomain(branch, scope),
    branch,
    scope,
    scopeKey: storageScopeKey,
    tier: InjectionTier.T1_ESSENTIAL,
    statementKind: 'instruction',
    epistemicStatus: 'verified',
    authorityScope: { kind: 'system-policy', scope, scopeKey: storageScopeKey, topics: ['memory-index'] },
    assertedBy: { kind: 'system', id: 'memory-v3-repository' },
    evidenceRefs: [`${INTERNAL_EVIDENCE_PREFIX}scope-root`],
    entityRefs: [],
    relationRefs: [],
    title: `${branch} scope index`,
    summary: spec.summary,
    content: '',
    retrievalKeys: spec.keys,
    importance: 1,
    confidence: 1,
    basePriority: 1,
    verifiedUsefulness: { useful: 0, notUseful: 0, conflicts: 0, stale: 0 },
    feedbackRevision: 0,
    reason: 'Canonical internal Memory v3 scope root.',
    sourceRunIds: [],
    sourceStages: ['migration'],
    status: 'active',
    resolutionStatus: 'resolved',
    createdAt: now,
    updatedAt: now,
  };
}

export function memoryAtomToNode(
  atom: MemoryAtom,
  childIds: string[],
  publicScopeKey: string | undefined,
): MemoryNode {
  return {
    id: atom.id,
    branch: atom.branch,
    parentNodeId: atom.parentId && isMemoryV3InternalRootId(atom.parentId)
      ? memoryBranchRootId(atom.branch)
      : atom.parentId,
    childIds,
    scope: atom.scope,
    scopeKey: publicScopeKey,
    tier: atom.tier,
    summary: atom.summary,
    content: atom.content,
    retrievalKeys: [...atom.retrievalKeys],
    importance: atom.importance,
    confidence: atom.confidence,
    reason: atom.reason,
    sourceRunIds: [...atom.sourceRunIds],
    sourceStages: [...atom.sourceStages],
    sourceRefs: atom.evidenceRefs.filter((value) => (
      !value.startsWith(MERGED_INTENT_PREFIX) && !value.startsWith(INTERNAL_EVIDENCE_PREFIX)
    )),
    status: atom.status === 'tombstone' ? 'deleted' : atom.status,
    createdAt: atom.createdAt,
    updatedAt: atom.updatedAt,
    mergedFrom: atom.evidenceRefs
      .filter((value) => value.startsWith(MERGED_INTENT_PREFIX))
      .map((value) => value.slice(MERGED_INTENT_PREFIX.length)),
  };
}

export function createMemoryAtomInput(
  input: {
    id: string;
    parentId: string;
    branch: MemoryBranchKind;
    scope: MemoryScope;
    storageScopeKey?: string;
    tier: InjectionTier;
    summary: string;
    content: string;
    retrievalKeys: string[];
    importance: number;
    confidence: number;
    reason: string;
    sourceRunId: string;
    sourceStage: MemoryAtom['sourceStages'][number];
    sourceRefs: string[];
    entityRefs: string[];
    relationRefs: string[];
    classification: ClassifiedMemoryStatement;
    createdAt: string;
  },
): CreateMemoryAtomInput {
  return {
    id: input.id,
    domain: input.classification.domain,
    branch: input.branch,
    parentId: input.parentId,
    scope: input.scope,
    scopeKey: input.storageScopeKey,
    tier: input.tier,
    statementKind: input.classification.statementKind,
    epistemicStatus: input.classification.epistemicStatus,
    authorityScope: {
      ...input.classification.authorityScope,
      scopeKey: input.classification.authorityScope.scope === 'global'
        ? undefined
        : input.classification.authorityScope.scope === input.scope
          ? input.storageScopeKey
          : input.classification.authorityScope.scopeKey,
    },
    assertedBy: input.classification.assertedBy,
    evidenceRefs: unique([...input.sourceRefs, ...input.classification.evidenceRefs]),
    entityRefs: unique(input.entityRefs),
    relationRefs: unique(input.relationRefs),
    title: input.summary,
    summary: input.summary,
    content: input.content,
    retrievalKeys: [...input.retrievalKeys],
    importance: input.importance,
    confidence: input.confidence,
    basePriority: Math.max(input.importance, input.confidence),
    verifiedUsefulness: { useful: 0, notUseful: 0, conflicts: 0, stale: 0 },
    feedbackRevision: 0,
    reason: input.reason,
    sourceRunIds: [input.sourceRunId],
    sourceStages: [input.sourceStage],
    status: 'active',
    resolutionStatus: input.classification.resolutionStatus,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function mergedIntentEvidence(intentId: string): string {
  return `${MERGED_INTENT_PREFIX}${intentId}`;
}

export function memoryV3EntityId(
  type: MemoryEntityType,
  scope: MemoryEntity['scope'],
  storageScopeKey: string | undefined,
  externalKey: string,
): string {
  const digest = createHash('sha256')
    .update(`${type}\0${scope}\0${storageScopeKey ?? ''}\0${externalKey}`, 'utf8')
    .digest('hex');
  return `memory-entity:${type}:${digest}`;
}

export function sourceRefEntityType(sourceRef: string): MemoryEntityType {
  if (/^(?:[a-z]:[\\/]|\/)/iu.test(sourceRef)) return 'file';
  if (/^user:/iu.test(sourceRef)) return 'user';
  if (/^skill:/iu.test(sourceRef)) return 'skill';
  if (/^tool:/iu.test(sourceRef)) return 'tool';
  if (/^task:/iu.test(sourceRef)) return 'task';
  if (/^session:/iu.test(sourceRef)) return 'session';
  if (/^project:/iu.test(sourceRef)) return 'project';
  if (/^file:/iu.test(sourceRef)) return 'file';
  if (/^rule:/iu.test(sourceRef)) return 'rule';
  if (/^concept:/iu.test(sourceRef)) return 'concept';
  return 'external-source';
}

export function scopeEntity(
  scope: MemoryScope,
  storageScopeKey: string | undefined,
  publicScopeKey: string | undefined,
  now: string,
  existing?: MemoryEntity,
): MemoryEntity | undefined {
  if (scope === 'global' || !storageScopeKey) return undefined;
  const type: MemoryEntityType = scope === 'workspace' ? 'directory' : scope;
  return {
    version: 1,
    id: memoryV3EntityId(type, scope, storageScopeKey, storageScopeKey),
    type,
    owner: { kind: 'user' },
    scope,
    scopeKey: storageScopeKey,
    externalKey: storageScopeKey,
    label: publicScopeKey ?? storageScopeKey,
    aliases: unique([...(existing?.aliases ?? []), storageScopeKey, publicScopeKey ?? storageScopeKey]),
    status: 'active',
    revision: (existing?.revision ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function sourceEntity(
  sourceRef: string,
  scope: MemoryScope,
  storageScopeKey: string | undefined,
  now: string,
  existing?: MemoryEntity,
): MemoryEntity {
  const type = sourceRefEntityType(sourceRef);
  return {
    version: 1,
    id: memoryV3EntityId(type, scope, storageScopeKey, sourceRef),
    type,
    owner: { kind: 'external', id: sourceRef },
    scope,
    scopeKey: storageScopeKey,
    externalKey: sourceRef,
    label: sourceRef,
    aliases: existing?.aliases ?? [],
    status: 'active',
    revision: (existing?.revision ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function branchDomain(branch: MemoryBranchKind, scope: MemoryScope): CreateMemoryAtomInput['domain'] {
  if (branch === 'experience') return 'experience';
  if (branch === 'project') return 'project';
  if (branch === 'daily') return scope === 'session' ? 'session' : 'task';
  return 'knowledge';
}
