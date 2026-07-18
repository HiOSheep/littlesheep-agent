import type { RuntimeKnownStateMemoryReference } from '@littlesheep/types';
import type {
  MemoryAtomCorrectionBasis,
  MemoryAtomCorrectionProposal,
} from '@littlesheep/memory-tree';
import { cleanString, isCurrentAdopted } from './atom-proposal-support.js';

export interface RawCorrectionProposal {
  action?: unknown;
  basis?: unknown;
  superseded?: unknown;
  replacement?: unknown;
  relationId?: unknown;
  reason?: unknown;
}

const CORRECTION_BASES = new Set<MemoryAtomCorrectionBasis>([
  'evidence-backed-correction',
  'conflict-replacement',
]);

export function parseCorrectionBasis(value: unknown): MemoryAtomCorrectionBasis | undefined {
  const parsed = cleanString(value, 48) as MemoryAtomCorrectionBasis | undefined;
  return parsed && CORRECTION_BASES.has(parsed) ? parsed : undefined;
}

export function validateEvolveCorrectionProposal(input: {
  raw?: RawCorrectionProposal;
  basis?: MemoryAtomCorrectionBasis;
  superseded?: MemoryAtomCorrectionProposal['superseded'];
  replacement?: MemoryAtomCorrectionProposal['replacement'];
  relationId?: string;
  reason?: string;
  supersededKnown?: RuntimeKnownStateMemoryReference;
  replacementKnown?: RuntimeKnownStateMemoryReference;
  evidence: { refs: string[]; verified: boolean };
  contractAllowsConflict: boolean;
}): string | undefined {
  if (!input.raw || input.raw.action !== 'supersede' || !input.basis) {
    return 'Only evidence-backed-correction or conflict-replacement Atom correction proposals are accepted.';
  }
  if (!input.contractAllowsConflict) return 'The evolve call contract does not allow Atom correction proposals.';
  if (!input.evidence.verified || input.evidence.refs.length === 0) {
    return 'An Atom correction proposal requires a passing verification record and runtime evidence.';
  }
  if (!input.superseded || !input.replacement || !input.relationId || !input.reason || input.reason.length < 12) {
    return 'An Atom correction proposal needs two Atom revisions, one relation id and a concrete reason.';
  }
  if (input.superseded.atomId === input.replacement.atomId) {
    return 'A memory Atom cannot replace itself.';
  }
  if (!input.replacementKnown || !isCurrentCompleteAdopted(input.replacementKnown, input.replacement.expectedRevision)) {
    return `Replacement Atom ${input.replacement.atomId} is not an adopted, current, unconflicted and complete D3 KnownState reference.`;
  }
  if (!input.supersededKnown || !isCurrentCompleteSupersededCandidate(
    input.supersededKnown,
    input.superseded.expectedRevision,
  )) {
    return `Superseded Atom ${input.superseded.atomId} is not a current adopted/conflicted and complete D3 KnownState reference.`;
  }
  if (!sameKnownStateBoundary(input.supersededKnown, input.replacementKnown)) {
    return `Replacement Atom ${input.replacement.atomId} crosses the correction branch, scope, parent or statement-kind boundary.`;
  }
  return undefined;
}

export function correctionSummary(
  supersededAtomId?: string,
  replacementAtomId?: string,
): string | undefined {
  return supersededAtomId && replacementAtomId
    ? `Supersede ${supersededAtomId} with ${replacementAtomId}`
    : undefined;
}

function isCurrentCompleteAdopted(
  reference: RuntimeKnownStateMemoryReference,
  revision: number,
): boolean {
  return isCurrentAdopted(reference, revision)
    && completeEnvelopeMatches(reference, revision);
}

function isCurrentCompleteSupersededCandidate(
  reference: RuntimeKnownStateMemoryReference,
  revision: number,
): boolean {
  const currentConflicted = reference.decision === 'conflicted'
    && reference.atomRevision === revision
    && reference.envelope.conflict
    && !reference.envelope.expired;
  return (isCurrentAdopted(reference, revision) || currentConflicted)
    && completeEnvelopeMatches(reference, revision);
}

function completeEnvelopeMatches(
  reference: RuntimeKnownStateMemoryReference,
  revision: number,
): boolean {
  return reference.envelope.disclosureLevel === 'D3'
    && !reference.envelope.truncated
    && reference.envelope.atomId === reference.atomId
    && reference.envelope.atomRevision === revision;
}

function sameKnownStateBoundary(
  superseded: RuntimeKnownStateMemoryReference,
  replacement: RuntimeKnownStateMemoryReference,
): boolean {
  return superseded.envelope.branch === replacement.envelope.branch
    && superseded.envelope.scope === replacement.envelope.scope
    && (superseded.envelope.scopeKey ?? '') === (replacement.envelope.scopeKey ?? '')
    && (superseded.envelope.parentNodeId ?? '') === (replacement.envelope.parentNodeId ?? '')
    && superseded.envelope.statementKind === replacement.envelope.statementKind;
}
