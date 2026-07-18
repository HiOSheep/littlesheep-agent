import type { MemoryAtom } from './v3/contracts.js';
import {
  explicitParentRelation,
  validateAtomReparentBoundary,
} from './memory-hierarchy-validation.js';
import type {
  MemoryAtomSubtreeMoveProposal,
  MemoryAtomSubtreeResult,
  MemoryAtomSubtreeStatus,
} from './memory-subtree-contracts.js';

export const MAX_SUBTREE_PROPOSALS = 1;
const MAX_REASON_LENGTH = 500;
const MAX_EVIDENCE_REFS = 32;

export function validateSubtreeMoveProposal(
  proposal: MemoryAtomSubtreeMoveProposal,
): string | undefined {
  if (!proposal || proposal.action !== 'move-subtree' || proposal.basis !== 'explicit-parent-relation') {
    return 'Only explicit-parent-relation subtree move proposals are supported.';
  }
  if (!safeId(proposal.id) || !validRef(proposal.root) || !validRef(proposal.parent)
    || !safeId(proposal.relationId)) {
    return 'The subtree move proposal contains an invalid id or revision.';
  }
  if (proposal.root.atomId === proposal.parent.atomId) {
    return 'A memory subtree root cannot become its own parent.';
  }
  if (typeof proposal.reason !== 'string' || proposal.reason.trim().length < 12) {
    return 'A subtree move proposal needs a concrete reason.';
  }
  if (proposal.reason.length > MAX_REASON_LENGTH) return 'The subtree move reason is too long.';
  if (!Array.isArray(proposal.evidenceRefs) || proposal.evidenceRefs.length < 1
    || proposal.evidenceRefs.length > MAX_EVIDENCE_REFS
    || proposal.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref.trim() || ref.length > 240)) {
    return 'A subtree move proposal needs bounded runtime evidence references.';
  }
  return undefined;
}

export function validateSubtreeBoundary(root: MemoryAtom, parent: MemoryAtom): string | undefined {
  return validateAtomReparentBoundary(root, parent);
}

export { explicitParentRelation as explicitSubtreeParentRelation };

export function subtreeMoveReason(proposal: MemoryAtomSubtreeMoveProposal): string {
  return `[subtree:${proposal.id}; relation:${proposal.relationId}] ${proposal.reason}`
    .slice(0, MAX_REASON_LENGTH + 140);
}

export function subtreeFailureStatus(error: unknown): MemoryAtomSubtreeStatus {
  return /revision|boundary|scope|cycle|parent|active|descendant|relation|not found|invalid|cannot|must|self/iu
    .test(subtreeErrorMessage(error))
    ? 'rejected'
    : 'deferred';
}

export function subtreeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function subtreeResult(
  proposal: MemoryAtomSubtreeMoveProposal,
  status: MemoryAtomSubtreeStatus,
  reason: string,
  activeDescendantCount?: number,
  managementResults: MemoryAtomSubtreeResult['managementResults'] = [],
): MemoryAtomSubtreeResult {
  return {
    proposalId: proposal.id,
    status,
    rootAtomId: proposal.root.atomId,
    parentAtomId: proposal.parent.atomId,
    activeDescendantCount,
    committed: status === 'committed',
    reason,
    managementResults,
  };
}

function validRef(value: unknown): value is MemoryAtomSubtreeMoveProposal['root'] {
  return !!value && typeof value === 'object'
    && safeId((value as MemoryAtomSubtreeMoveProposal['root']).atomId)
    && Number.isSafeInteger((value as MemoryAtomSubtreeMoveProposal['root']).expectedRevision)
    && (value as MemoryAtomSubtreeMoveProposal['root']).expectedRevision >= 1;
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && /^[\w.:-]+$/u.test(value);
}
