import {
  MEMORY_INTENT_DECISION_VERSION,
  type LlmMemoryIntentKind,
  type MemoryIntentDecisionRecord,
  type RunContext,
  type RuntimeKnownStateMemoryReference,
} from '@littlesheep/types';
import type { MemoryAtomRevisionReference } from '@littlesheep/memory-tree';

export function parseAtomReference(value: unknown): MemoryAtomRevisionReference | undefined {
  if (!isRecord(value)) return undefined;
  const atomId = cleanString(value.atomId, 240);
  const rawRevision = value.expectedRevision ?? value.revision;
  const expectedRevision = typeof rawRevision === 'number' ? rawRevision : Number(rawRevision);
  if (!atomId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return undefined;
  return { atomId, expectedRevision };
}

export function isCurrentAdopted(reference: RuntimeKnownStateMemoryReference, revision: number): boolean {
  return reference.decision === 'adopted'
    && reference.atomRevision === revision
    && ['D2', 'D3'].includes(reference.envelope.disclosureLevel)
    && !reference.envelope.conflict
    && !reference.envelope.expired;
}

export function hasCompleteD3Envelope(reference: RuntimeKnownStateMemoryReference): boolean {
  return reference.envelope.disclosureLevel === 'D3'
    && !reference.envelope.truncated;
}

export function knownStateEnvelopeMatches(
  reference: RuntimeKnownStateMemoryReference,
  atomId: string,
  revision: number,
): boolean {
  return reference.envelope.atomId === atomId
    && reference.envelope.atomRevision === revision;
}

export function validateEvolveAtomProposalGate(input: {
  proposalKind: 'correction' | 'revision';
  contractAllowed: boolean;
  evidence: { refs: readonly string[]; verified: boolean };
}): string | undefined {
  if (!input.contractAllowed) {
    return `The evolve call contract does not allow Atom ${input.proposalKind} proposals.`;
  }
  if (!input.evidence.verified || input.evidence.refs.length === 0) {
    return `An Atom ${input.proposalKind} proposal requires a passing verification record and runtime evidence.`;
  }
  return undefined;
}

export function atomProposalDecisionRecord(input: {
  ctx: RunContext;
  id: string;
  proposedIntent: Extract<LlmMemoryIntentKind, 'merge' | 'move' | 'revise' | 'conflict'>;
  decision: MemoryIntentDecisionRecord['decision'];
  reason: string;
  branch?: string;
  summary?: string;
  evidenceRefs: string[];
  reconciliationDecision: NonNullable<MemoryIntentDecisionRecord['reconciliationDecision']>;
}): MemoryIntentDecisionRecord {
  return Object.freeze({
    version: MEMORY_INTENT_DECISION_VERSION,
    id: input.id,
    runId: input.ctx.runId,
    stage: 'evolve',
    proposedIntent: input.proposedIntent,
    decision: input.decision,
    reason: input.reason,
    branch: input.branch,
    summary: input.summary,
    evidenceRefs: Object.freeze([...input.evidenceRefs].slice(0, 32)),
    writeIntentId: input.id,
    reconciliationDecision: input.reconciliationDecision,
    createdAt: new Date().toISOString(),
  });
}

export function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
