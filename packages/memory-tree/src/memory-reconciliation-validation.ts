import type { MemoryAtom, MemoryRelationNeighborhood } from './v3/contracts.js';
import type {
  MemoryAtomMergeProposal,
  MemoryAtomReconciliationResult,
  MemoryAtomReconciliationStatus,
} from './memory-reconciliation-contracts.js';

export const MAX_RECONCILIATION_PROPOSALS = 2;
const MAX_SOURCES_PER_PROPOSAL = 4;
const MAX_REASON_LENGTH = 500;
const MAX_EVIDENCE_REFS = 32;

export function validateReconciliationProposal(proposal: MemoryAtomMergeProposal): string | undefined {
  if (!proposal || proposal.action !== 'merge' || proposal.basis !== 'duplicate-projection') {
    return 'Only duplicate-projection merge proposals are supported.';
  }
  if (!safeId(proposal.id) || !safeId(proposal.target.atomId)) return 'The reconciliation proposal contains an invalid id.';
  if (!Number.isSafeInteger(proposal.target.expectedRevision) || proposal.target.expectedRevision < 1) {
    return 'The reconciliation target revision is invalid.';
  }
  if (!Array.isArray(proposal.sources) || proposal.sources.length < 1 || proposal.sources.length > MAX_SOURCES_PER_PROPOSAL) {
    return `A reconciliation proposal must contain 1-${MAX_SOURCES_PER_PROPOSAL} source atoms.`;
  }
  const ids = new Set<string>();
  for (const source of proposal.sources) {
    if (!safeId(source.atomId) || ids.has(source.atomId) || source.atomId === proposal.target.atomId) {
      return 'A reconciliation proposal contains duplicate or self-referencing atom ids.';
    }
    if (!Number.isSafeInteger(source.expectedRevision) || source.expectedRevision < 1) {
      return `The source revision for ${source.atomId} is invalid.`;
    }
    ids.add(source.atomId);
  }
  if (typeof proposal.reason !== 'string' || proposal.reason.trim().length < 12) {
    return 'A reconciliation proposal needs a concrete reason.';
  }
  if (proposal.reason.length > MAX_REASON_LENGTH) return 'The reconciliation reason is too long.';
  if (!Array.isArray(proposal.evidenceRefs) || proposal.evidenceRefs.length < 1 || proposal.evidenceRefs.length > MAX_EVIDENCE_REFS
    || proposal.evidenceRefs.some((ref) => typeof ref !== 'string' || ref.trim().length === 0 || ref.length > 240)) {
    return 'A reconciliation proposal needs bounded runtime evidence references.';
  }
  return undefined;
}

export function validateAtomMergeBoundary(target: MemoryAtom, source: MemoryAtom): string | undefined {
  if (target.branch !== source.branch
    || target.scope !== source.scope
    || (target.scopeKey ?? '') !== (source.scopeKey ?? '')) {
    return `Memory atoms ${source.id} and ${target.id} cross a branch or scope boundary.`;
  }
  if ((target.parentId ?? '') !== (source.parentId ?? '')) {
    return `Memory atoms ${source.id} and ${target.id} do not share a parent.`;
  }
  if (target.domain !== source.domain
    || target.statementKind !== source.statementKind
    || target.epistemicStatus !== source.epistemicStatus
    || target.resolutionStatus !== source.resolutionStatus
    || canonical(target.authorityScope) !== canonical(source.authorityScope)
    || canonical(target.assertedBy) !== canonical(source.assertedBy)) {
    return `Memory atoms ${source.id} and ${target.id} cross an epistemic boundary.`;
  }
  return undefined;
}

export function hasDeterministicSemanticAnchor(target: MemoryAtom, source: MemoryAtom): boolean {
  if (target.contentHash === source.contentHash) return true;
  const keyOverlap = overlap(target.retrievalKeys, source.retrievalKeys);
  const contentOverlap = overlap(semanticTokens(`${target.summary} ${target.content}`), semanticTokens(`${source.summary} ${source.content}`));
  const sourceOverlap = overlap(target.sourceRefs, source.sourceRefs);
  const evidenceOverlap = overlap(target.evidenceRefs, source.evidenceRefs);
  const entityOverlap = overlap(target.entityRefs, source.entityRefs);
  return contentOverlap >= 0.68
    || (keyOverlap >= 0.5 && contentOverlap >= 0.18)
    || ((sourceOverlap > 0 || evidenceOverlap > 0) && contentOverlap >= 0.18)
    || (entityOverlap >= 0.5 && keyOverlap > 0);
}

export function hasBlockingSemanticRelation(
  target: MemoryAtom,
  source: MemoryAtom,
  targetNeighborhood?: MemoryRelationNeighborhood,
  sourceNeighborhood?: MemoryRelationNeighborhood,
): boolean {
  const targetEntities = new Set(target.entityRefs);
  const sourceEntities = new Set(source.entityRefs);
  const relations = new Map<string, MemoryRelationNeighborhood['relations'][number]>();
  for (const relation of [...(targetNeighborhood?.relations ?? []), ...(sourceNeighborhood?.relations ?? [])]) {
    relations.set(relation.id, relation);
  }
  return [...relations.values()].some((relation) => {
    if (!['conflicts-with', 'replaces'].includes(relation.type) || !['active', 'disputed'].includes(relation.status)) return false;
    return (targetEntities.has(relation.fromEntityId) && sourceEntities.has(relation.toEntityId))
      || (targetEntities.has(relation.toEntityId) && sourceEntities.has(relation.fromEntityId));
  });
}

export function reconciliationReason(proposal: MemoryAtomMergeProposal): string {
  return `[reconciliation:${proposal.id}] ${proposal.reason}`.slice(0, MAX_REASON_LENGTH + 80);
}

export function rejectedReconciliation(
  base: Pick<MemoryAtomReconciliationResult, 'proposalId' | 'targetAtomId' | 'sourceAtomIds'>,
  reason: string,
): MemoryAtomReconciliationResult {
  return {
    ...base,
    status: 'rejected',
    committedSourceAtomIds: [],
    remainingSourceAtomIds: [...base.sourceAtomIds],
    reason,
    managementResults: [],
  };
}

export function classifyReconciliationFailure(error: unknown): MemoryAtomReconciliationStatus {
  const message = errorMessage(error);
  return /revision|boundary|active|not found|invalid|cannot|must|self/iu.test(message) ? 'rejected' : 'deferred';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function semanticTokens(value: string): Set<string> {
  const lower = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = new Set<string>();
  for (const part of lower.split(/\s+/u).filter(Boolean)) {
    if (/\p{Script=Han}/u.test(part)) {
      for (const character of [...part]) tokens.add(character);
    } else {
      tokens.add(part);
    }
  }
  return tokens;
}

function overlap(left: Iterable<string>, right: Iterable<string>): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && /^[\w.:-]+$/u.test(value);
}
