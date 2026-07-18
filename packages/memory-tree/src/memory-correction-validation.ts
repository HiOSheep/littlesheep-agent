import type { MemoryAtom, MemoryRelation, MemoryRelationNeighborhood } from './v3/contracts.js';
import type {
  MemoryAtomCorrectionProposal,
  MemoryAtomCorrectionResult,
  MemoryAtomCorrectionStatus,
} from './memory-correction-contracts.js';

export const MAX_CORRECTION_PROPOSALS = 1;
const MAX_REASON_LENGTH = 500;
const MAX_EVIDENCE_REFS = 32;
const MIN_RELATION_CONFIDENCE = 0.75;
const MIN_RELATION_RELEVANCE = 0.5;
const FACTUAL_KINDS = new Set(['factual-claim', 'reported-observation']);
const AUTHORITATIVE_KINDS = new Set([
  'instruction', 'goal', 'preference', 'value', 'decision', 'approval',
]);
const AUTHORITATIVE_SCOPES = new Set([
  'user-self', 'system-policy', 'project-owner', 'session-owner', 'tool-evidence',
]);

export function validateCorrectionProposal(proposal: MemoryAtomCorrectionProposal): string | undefined {
  if (!proposal || proposal.action !== 'supersede'
    || !['evidence-backed-correction', 'conflict-replacement'].includes(proposal.basis)) {
    return 'Only evidence-backed correction or conflict-replacement proposals are supported.';
  }
  if (!safeId(proposal.id) || !validRef(proposal.superseded)
    || !validRef(proposal.replacement) || !safeId(proposal.relationId)) {
    return 'The Atom correction proposal contains an invalid id or revision.';
  }
  if (proposal.superseded.atomId === proposal.replacement.atomId) {
    return 'A memory atom cannot replace itself.';
  }
  if (typeof proposal.reason !== 'string' || proposal.reason.trim().length < 12) {
    return 'An Atom correction proposal needs a concrete reason.';
  }
  if (proposal.reason.length > MAX_REASON_LENGTH) return 'The Atom correction reason is too long.';
  if (!Array.isArray(proposal.evidenceRefs) || proposal.evidenceRefs.length < 1
    || proposal.evidenceRefs.length > MAX_EVIDENCE_REFS
    || proposal.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref.trim() || ref.length > 240)) {
    return 'An Atom correction proposal needs bounded runtime evidence references.';
  }
  return undefined;
}

export function validateAtomCorrectionBoundary(
  superseded: MemoryAtom,
  replacement: MemoryAtom,
): string | undefined {
  if (superseded.branch !== replacement.branch
    || superseded.scope !== replacement.scope
    || (superseded.scopeKey ?? '') !== (replacement.scopeKey ?? '')) {
    return `Memory atoms ${superseded.id} and ${replacement.id} cross a branch or scope boundary.`;
  }
  if ((superseded.parentId ?? '') !== (replacement.parentId ?? '')) {
    return 'A correction replacement must remain under the same semantic parent.';
  }
  if (superseded.domain !== replacement.domain || superseded.statementKind !== replacement.statementKind) {
    return 'A correction replacement cannot cross domain or statement-kind boundaries.';
  }
  if (superseded.contentHash === replacement.contentHash) {
    return 'Equivalent projections must use duplicate reconciliation instead of correction.';
  }
  if (superseded.status !== 'active' || superseded.merge || superseded.invalidation || superseded.supersession) {
    return `Memory atom ${superseded.id} is not eligible to be superseded.`;
  }
  if (replacement.status !== 'active' || replacement.merge || replacement.invalidation || replacement.supersession) {
    return `Replacement memory atom ${replacement.id} is not active and independent.`;
  }
  if (replacement.epistemicStatus === 'disputed' || replacement.epistemicStatus === 'superseded'
    || replacement.resolutionStatus === 'rejected' || replacement.resolutionStatus === 'superseded') {
    return `Replacement memory atom ${replacement.id} is not an accepted current projection.`;
  }
  if (!replacementIsAuthoritative(replacement)) {
    return `Replacement memory atom ${replacement.id} lacks sufficient authority or evidence.`;
  }
  if (replacement.sourceRefs.length === 0 && replacement.evidenceRefs.length === 0) {
    return `Replacement memory atom ${replacement.id} has no traceable source or evidence.`;
  }
  return undefined;
}

export function explicitCorrectionRelation(
  proposal: MemoryAtomCorrectionProposal,
  superseded: MemoryAtom,
  replacement: MemoryAtom,
  supersededNeighborhood?: MemoryRelationNeighborhood,
  replacementNeighborhood?: MemoryRelationNeighborhood,
): MemoryRelation | undefined {
  const relations = new Map<string, MemoryRelation>();
  for (const relation of [
    ...(supersededNeighborhood?.relations ?? []),
    ...(replacementNeighborhood?.relations ?? []),
  ]) relations.set(relation.id, relation);
  const relation = relations.get(proposal.relationId);
  if (!relation || !['replaces', 'conflicts-with'].includes(relation.type)
    || (proposal.basis === 'evidence-backed-correction' && relation.type !== 'replaces')
    || relation.status !== 'active' || relation.resolutionStatus !== 'resolved'
    || relation.confidence < MIN_RELATION_CONFIDENCE || relation.relevance < MIN_RELATION_RELEVANCE
    || (relation.sourceRefs.length === 0 && relation.evidenceRefs.length === 0)
    || relation.scope !== superseded.scope
    || (relation.scopeKey ?? '') !== (superseded.scopeKey ?? '')) {
    return undefined;
  }
  const oldEntities = new Set(superseded.entityRefs);
  const newEntities = new Set(replacement.entityRefs);
  if (relation.type === 'replaces') {
    return newEntities.has(relation.fromEntityId) && oldEntities.has(relation.toEntityId)
      ? relation
      : undefined;
  }
  const forward = newEntities.has(relation.fromEntityId) && oldEntities.has(relation.toEntityId);
  const reverse = oldEntities.has(relation.fromEntityId) && newEntities.has(relation.toEntityId);
  return forward || reverse ? relation : undefined;
}

export function correctionReason(proposal: MemoryAtomCorrectionProposal): string {
  return `[correction:${proposal.id}; relation:${proposal.relationId}] ${proposal.reason}`
    .slice(0, MAX_REASON_LENGTH + 140);
}

export function correctionResult(
  proposal: MemoryAtomCorrectionProposal,
  status: MemoryAtomCorrectionStatus,
  reason: string,
  managementResults: MemoryAtomCorrectionResult['managementResults'] = [],
  revision?: number,
): MemoryAtomCorrectionResult {
  return {
    proposalId: proposal.id,
    status,
    supersededAtomId: proposal.superseded.atomId,
    replacementAtomId: proposal.replacement.atomId,
    committed: status === 'committed',
    previousRevision: proposal.superseded.expectedRevision,
    revision,
    reason,
    managementResults,
  };
}

export function correctionFailureStatus(error: unknown): MemoryAtomCorrectionStatus {
  return /revision|boundary|scope|parent|domain|statement|active|authority|evidence|relation|not found|invalid|cannot|must|self|supersed/iu
    .test(correctionErrorMessage(error))
    ? 'rejected'
    : 'deferred';
}

export function correctionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replacementIsAuthoritative(atom: MemoryAtom): boolean {
  if (!['adopted', 'resolved'].includes(atom.resolutionStatus)) return false;
  if (FACTUAL_KINDS.has(atom.statementKind)) {
    return ['corroborated', 'verified'].includes(atom.epistemicStatus) && atom.confidence >= 0.7;
  }
  if (AUTHORITATIVE_KINDS.has(atom.statementKind)) {
    return AUTHORITATIVE_SCOPES.has(atom.authorityScope.kind);
  }
  return false;
}

function validRef(value: unknown): value is MemoryAtomCorrectionProposal['superseded'] {
  return !!value && typeof value === 'object'
    && safeId((value as MemoryAtomCorrectionProposal['superseded']).atomId)
    && Number.isSafeInteger((value as MemoryAtomCorrectionProposal['superseded']).expectedRevision)
    && (value as MemoryAtomCorrectionProposal['superseded']).expectedRevision >= 1;
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && /^[\w.:-]+$/u.test(value);
}
