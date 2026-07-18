import type { MemoryAtom } from './v3/contracts.js';
import type {
  MemoryAtomRevisionPatch,
} from './memory-repository/management.js';
import type {
  MemoryAtomRevisionProposal,
  MemoryAtomRevisionResult,
  MemoryAtomRevisionStatus,
} from './memory-revision-contracts.js';
import { cleanText, normalizedText, textTerms, unique } from './memory-repository/text.js';

export const MAX_REVISION_PROPOSALS = 1;
const MAX_TITLE_LENGTH = 500;
const MAX_SUMMARY_LENGTH = 8_000;
const MAX_CONTENT_LENGTH = 12_000;
const MAX_RETRIEVAL_KEYS = 64;
const MAX_RETRIEVAL_KEY_LENGTH = 200;
const MAX_REASON_LENGTH = 500;
const MAX_EVIDENCE_REFS = 32;

export function validateRevisionProposal(proposal: MemoryAtomRevisionProposal): string | undefined {
  if (!proposal || proposal.action !== 'revise' || proposal.basis !== 'same-claim-refinement') {
    return 'Only same-claim-refinement Atom revision proposals are supported.';
  }
  if (!safeId(proposal.id) || !safeId(proposal.atom.atomId)) {
    return 'The Atom revision proposal contains an invalid id.';
  }
  if (!Number.isSafeInteger(proposal.atom.expectedRevision) || proposal.atom.expectedRevision < 1) {
    return 'The Atom revision proposal contains an invalid expected revision.';
  }
  const patchError = validateRevisionPatch(proposal.replacement);
  if (patchError) return patchError;
  if (typeof proposal.reason !== 'string' || proposal.reason.trim().length < 12) {
    return 'An Atom revision proposal needs a concrete reason.';
  }
  if (proposal.reason.length > MAX_REASON_LENGTH) return 'The Atom revision reason is too long.';
  if (!Array.isArray(proposal.evidenceRefs)
    || proposal.evidenceRefs.length < 1
    || proposal.evidenceRefs.length > MAX_EVIDENCE_REFS
    || proposal.evidenceRefs.some((ref) => typeof ref !== 'string' || ref.trim().length === 0 || ref.length > 240)) {
    return 'An Atom revision proposal needs bounded runtime evidence references.';
  }
  return undefined;
}

export function normalizeRevisionPatch(patch: MemoryAtomRevisionPatch): MemoryAtomRevisionPatch {
  return {
    title: cleanText(patch.title).slice(0, MAX_TITLE_LENGTH),
    summary: cleanText(patch.summary).slice(0, MAX_SUMMARY_LENGTH),
    content: cleanText(patch.content).slice(0, MAX_CONTENT_LENGTH),
    retrievalKeys: unique(patch.retrievalKeys.map((key) => cleanText(key).slice(0, MAX_RETRIEVAL_KEY_LENGTH)))
      .slice(0, MAX_RETRIEVAL_KEYS),
  };
}

export function validateRevisionPatch(patch: MemoryAtomRevisionPatch): string | undefined {
  if (!patch || typeof patch !== 'object') return 'An Atom revision proposal needs a replacement projection.';
  if (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > MAX_TITLE_LENGTH) {
    return `The revised Atom title must contain 1-${MAX_TITLE_LENGTH} characters.`;
  }
  if (typeof patch.summary !== 'string' || !patch.summary.trim() || patch.summary.length > MAX_SUMMARY_LENGTH) {
    return `The revised Atom summary must contain 1-${MAX_SUMMARY_LENGTH} characters.`;
  }
  if (typeof patch.content !== 'string' || !patch.content.trim() || patch.content.length > MAX_CONTENT_LENGTH) {
    return `The revised Atom content must contain 1-${MAX_CONTENT_LENGTH} characters.`;
  }
  if (!Array.isArray(patch.retrievalKeys)
    || patch.retrievalKeys.length < 1
    || patch.retrievalKeys.length > MAX_RETRIEVAL_KEYS
    || patch.retrievalKeys.some((key) => typeof key !== 'string' || !key.trim() || key.length > MAX_RETRIEVAL_KEY_LENGTH)) {
    return `The revised Atom needs 1-${MAX_RETRIEVAL_KEYS} bounded retrieval keys.`;
  }
  return undefined;
}

/**
 * First-release revision boundary: improve one projection without changing
 * the claim it represents. Corrections and replacements must remain separate
 * conflict/replacement operations so the prior claim is never silently lost.
 */
export function validateAtomRevisionBoundary(
  atom: MemoryAtom,
  replacementValue: MemoryAtomRevisionPatch,
): string | undefined {
  if (atom.status !== 'active') return `Memory atom ${atom.id} must be active before revision.`;
  if (atom.merge) return `Memory atom ${atom.id} has already been merged and cannot be revised.`;
  if (atom.invalidation) return `Memory atom ${atom.id} is invalidated and cannot be revised.`;
  if (atom.epistemicStatus === 'disputed' || atom.epistemicStatus === 'superseded'
    || atom.resolutionStatus === 'rejected' || atom.resolutionStatus === 'superseded') {
    return `Memory atom ${atom.id} is outside the safe same-claim revision boundary.`;
  }
  const patchError = validateRevisionPatch(replacementValue);
  if (patchError) return patchError;
  const replacement = normalizeRevisionPatch(replacementValue);
  if (projectionMatches(atom, replacement)) return undefined;

  const beforeText = projectionText(atom);
  const afterText = projectionText(replacement);
  const beforeTerms = textTerms(beforeText);
  const afterTerms = textTerms(afterText);
  const sharedTerms = sharedCount(beforeTerms, afterTerms);
  const retention = beforeTerms.size === 0 ? 0 : sharedTerms / beforeTerms.size;
  const precision = afterTerms.size === 0 ? 0 : sharedTerms / afterTerms.size;
  if (retention < 0.45 || precision < 0.55) {
    return `The revised projection for ${atom.id} does not preserve enough of the current claim.`;
  }

  const beforeAnchors = hardAnchors(beforeText);
  const afterAnchors = hardAnchors(afterText);
  const droppedAnchor = [...beforeAnchors].find((anchor) => !afterAnchors.has(anchor));
  if (droppedAnchor) return `The revised projection drops the hard anchor ${droppedAnchor}.`;
  const introducedAnchor = [...afterAnchors].find((anchor) => !beforeAnchors.has(anchor));
  if (introducedAnchor) return `The revised projection introduces the unsupported hard anchor ${introducedAnchor}.`;

  const maximumExpandedCharacters = Math.max(beforeText.length + 512, Math.ceil(beforeText.length * 1.5));
  if (afterText.length > maximumExpandedCharacters) {
    return `The revised projection for ${atom.id} expands beyond the bounded same-claim limit.`;
  }

  const beforeKeyTerms = textTerms(atom.retrievalKeys.join(' '));
  const afterKeyTerms = textTerms(replacement.retrievalKeys.join(' '));
  if (beforeKeyTerms.size > 0 && sharedCount(beforeKeyTerms, afterKeyTerms) / beforeKeyTerms.size < 0.25) {
    return `The revised projection for ${atom.id} discards too many existing retrieval anchors.`;
  }
  return undefined;
}

export function projectionMatches(atom: MemoryAtom, patchValue: MemoryAtomRevisionPatch): boolean {
  const patch = normalizeRevisionPatch(patchValue);
  return normalizedText(atom.title) === normalizedText(patch.title)
    && normalizedText(atom.summary) === normalizedText(patch.summary)
    && normalizedText(atom.content) === normalizedText(patch.content)
    && canonicalStrings(atom.retrievalKeys) === canonicalStrings(patch.retrievalKeys);
}

export function revisionReason(proposal: MemoryAtomRevisionProposal): string {
  return `[revision:${proposal.id}] ${proposal.reason}`.slice(0, MAX_REASON_LENGTH + 80);
}

export function revisionResult(
  proposal: MemoryAtomRevisionProposal,
  status: MemoryAtomRevisionStatus,
  reason: string,
  managementResults: MemoryAtomRevisionResult['managementResults'] = [],
  revision?: number,
): MemoryAtomRevisionResult {
  return {
    proposalId: proposal.id,
    status,
    atomId: proposal.atom.atomId,
    committed: status === 'committed',
    previousRevision: proposal.atom.expectedRevision,
    revision,
    reason,
    managementResults,
  };
}

export function revisionFailureStatus(error: unknown): MemoryAtomRevisionStatus {
  return /revision|active|invalid|merged|boundary|claim|anchor|not found|must|cannot|unsupported/iu.test(errorMessage(error))
    ? 'rejected'
    : 'deferred';
}

export function revisionErrorMessage(error: unknown): string {
  return errorMessage(error);
}

function projectionText(value: Pick<MemoryAtom, 'title' | 'summary' | 'content'> | MemoryAtomRevisionPatch): string {
  return `${value.title}\n${value.summary}\n${value.content}`;
}

function hardAnchors(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLocaleLowerCase();
  const matches = normalized.match(/(?:https?:\/\/[^\s"'，。；;]+|[a-z]:\\[^\s"'，。；;]+|[\p{L}\p{N}_./\\:-]{3,})/gu) ?? [];
  return new Set(matches
    .map((match) => match.replace(/[),.;!?，。；！？]+$/gu, ''))
    .filter((match) => /[\d./\\:]/u.test(match)));
}

function sharedCount(left: Set<string>, right: Set<string>): number {
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared;
}

function canonicalStrings(values: string[]): string {
  return unique(values.map((value) => normalizedText(value))).sort().join('\u0000');
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && /^[\w.:-]+$/u.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
