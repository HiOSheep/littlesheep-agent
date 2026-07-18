import type { MemoryAtom, MemoryRelation, MemoryRelationNeighborhood } from './v3/contracts.js';
import type {
  MemoryAtomHierarchyResult,
  MemoryAtomHierarchyStatus,
  MemoryAtomReparentProposal,
} from './memory-hierarchy-contracts.js';

export const MAX_HIERARCHY_PROPOSALS = 1;
const MAX_REASON_LENGTH = 500;
const MAX_EVIDENCE_REFS = 32;
const MIN_RELATION_CONFIDENCE = 0.75;
const MIN_RELATION_RELEVANCE = 0.5;

export function validateReparentProposal(proposal: MemoryAtomReparentProposal): string | undefined {
  if (!proposal || proposal.action !== 'move' || proposal.basis !== 'explicit-parent-relation') {
    return 'Only explicit-parent-relation move proposals are supported.';
  }
  if (!safeId(proposal.id) || !validRef(proposal.atom) || !validRef(proposal.parent)
    || !safeId(proposal.relationId)) {
    return 'The hierarchy proposal contains an invalid id or revision.';
  }
  if (proposal.atom.atomId === proposal.parent.atomId) {
    return 'A memory atom cannot become its own parent.';
  }
  if (typeof proposal.reason !== 'string' || proposal.reason.trim().length < 12) {
    return 'A hierarchy proposal needs a concrete reason.';
  }
  if (proposal.reason.length > MAX_REASON_LENGTH) return 'The hierarchy proposal reason is too long.';
  if (!Array.isArray(proposal.evidenceRefs) || proposal.evidenceRefs.length < 1
    || proposal.evidenceRefs.length > MAX_EVIDENCE_REFS
    || proposal.evidenceRefs.some((ref) => typeof ref !== 'string' || ref.trim().length === 0 || ref.length > 240)) {
    return 'A hierarchy proposal needs bounded runtime evidence references.';
  }
  return undefined;
}

export function validateAtomReparentBoundary(atom: MemoryAtom, parent: MemoryAtom): string | undefined {
  if (atom.branch !== parent.branch
    || atom.scope !== parent.scope
    || (atom.scopeKey ?? '') !== (parent.scopeKey ?? '')) {
    return `Memory atom ${atom.id} cannot move across a branch or scope boundary.`;
  }
  if (atom.status !== 'active' || atom.merge || atom.invalidation) {
    return `Memory atom ${atom.id} is not eligible for automatic hierarchy movement.`;
  }
  if (parent.status !== 'active' || parent.merge || parent.invalidation) {
    return `Destination parent ${parent.id} is not an active hierarchy target.`;
  }
  return undefined;
}

export function explicitParentRelation(
  atom: MemoryAtom,
  parent: MemoryAtom,
  relationId: string,
  atomNeighborhood?: MemoryRelationNeighborhood,
  parentNeighborhood?: MemoryRelationNeighborhood,
): MemoryRelation | undefined {
  const relations = new Map<string, MemoryRelation>();
  for (const relation of [...(atomNeighborhood?.relations ?? []), ...(parentNeighborhood?.relations ?? [])]) {
    relations.set(relation.id, relation);
  }
  const relation = relations.get(relationId);
  if (!relation || !['belongs-to', 'derived-from'].includes(relation.type)
    || relation.status !== 'active' || relation.resolutionStatus !== 'resolved'
    || relation.confidence < MIN_RELATION_CONFIDENCE || relation.relevance < MIN_RELATION_RELEVANCE
    || (relation.sourceRefs.length === 0 && relation.evidenceRefs.length === 0)
    || relation.scope !== atom.scope || (relation.scopeKey ?? '') !== (atom.scopeKey ?? '')) {
    return undefined;
  }
  const atomEntities = new Set(atom.entityRefs);
  const parentEntities = new Set(parent.entityRefs);
  return atomEntities.has(relation.fromEntityId) && parentEntities.has(relation.toEntityId)
    ? relation
    : undefined;
}

export function hierarchyReason(proposal: MemoryAtomReparentProposal): string {
  return `[hierarchy:${proposal.id}; relation:${proposal.relationId}] ${proposal.reason}`
    .slice(0, MAX_REASON_LENGTH + 120);
}

export function hierarchyFailureStatus(error: unknown): MemoryAtomHierarchyStatus {
  const message = hierarchyErrorMessage(error);
  return /revision|boundary|cycle|parent|active|not found|invalid|cannot|must|self/iu.test(message)
    ? 'rejected'
    : 'deferred';
}

export function hierarchyErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hierarchyResult(
  proposal: MemoryAtomReparentProposal,
  status: MemoryAtomHierarchyStatus,
  reason: string,
  managementResults: MemoryAtomHierarchyResult['managementResults'] = [],
): MemoryAtomHierarchyResult {
  return {
    proposalId: proposal.id,
    status,
    atomId: proposal.atom.atomId,
    parentAtomId: proposal.parent.atomId,
    committed: status === 'committed',
    reason,
    managementResults,
  };
}

function validRef(value: unknown): value is MemoryAtomReparentProposal['atom'] {
  return !!value && typeof value === 'object'
    && safeId((value as MemoryAtomReparentProposal['atom']).atomId)
    && Number.isSafeInteger((value as MemoryAtomReparentProposal['atom']).expectedRevision)
    && (value as MemoryAtomReparentProposal['atom']).expectedRevision >= 1;
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && /^[\w.:-]+$/u.test(value);
}
