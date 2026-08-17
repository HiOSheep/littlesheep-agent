// Parses model revision proposals and enforces run-evidence/KnownState gates
// before delegating any projection mutation to the Runtime revision service.

import type {
  MemoryIntentDecisionRecord,
  RunContext,
  RuntimeKnownStateMemoryReference,
} from '@littlesheep/types';
import {
  MAX_REVISION_PROPOSALS,
  type MemoryAtomRevisionPatch,
  type MemoryAtomRevisionProposal,
  type MemoryAtomRevisionResult,
  type MemoryAtomRevisionServiceLike,
} from '@littlesheep/memory-tree';
import {
  collectRunEvidence,
} from '../memory-intent-gate.js';
import {
  atomProposalDecisionRecord,
  cleanString,
  hasCompleteD3Envelope,
  isCurrentAdopted,
  isRecord,
  knownStateEnvelopeMatches,
  parseAtomReference,
  validateEvolveAtomProposalGate,
} from './atom-proposal-support.js';
import {
  commitAtomProposalPlan,
  type AtomProposalCommitPlan,
  type EvolveAtomProposalResult,
} from './atom-proposal-commit.js';

interface RawRevisionProposal {
  action?: unknown;
  basis?: unknown;
  atom?: unknown;
  replacement?: unknown;
  reason?: unknown;
}

type RevisionPlan = AtomProposalCommitPlan<MemoryAtomRevisionProposal>;

const MAX_AUDITED_REVISION_PROPOSALS = MAX_REVISION_PROPOSALS + 1;

export type EvolveRevisionResult = EvolveAtomProposalResult<MemoryAtomRevisionResult>;

export async function processEvolveRevisions(
  value: unknown,
  ctx: RunContext,
  reviser?: MemoryAtomRevisionServiceLike,
): Promise<EvolveRevisionResult> {
  return commitAtomProposalPlan<MemoryAtomRevisionProposal, MemoryAtomRevisionResult>({
    ctx,
    plan: parsePlan(value, ctx),
    proposedIntent: 'revise',
    serviceName: 'Revision',
    commit: reviser ? (proposals) => reviser.revise(proposals) : undefined,
    summarizeProposal: (proposal) => `Refine the projection for ${proposal.atom.atomId}`,
    summarizeResult: (result) => `Refine the projection for ${result.atomId}`,
  });
}

function parsePlan(value: unknown, ctx: RunContext): RevisionPlan {
  if (!Array.isArray(value)) return { proposals: [], decisions: [] };

  const evidence = collectRunEvidence(ctx);
  const contract = [...(ctx.modelRequests ?? [])]
    .reverse()
    .find((snapshot) => snapshot.callContract?.purpose === 'evolve')
    ?.callContract;
  const known = new Map(
    (ctx.memoryKnownState?.references ?? []).map((reference) => [reference.atomId, reference]),
  );
  const proposals: MemoryAtomRevisionProposal[] = [];
  const decisions: MemoryIntentDecisionRecord[] = [];

  for (const [index, raw] of value.slice(0, MAX_AUDITED_REVISION_PROPOSALS).entries()) {
    const id = `${ctx.runId}:evolve:revision:${index + 1}`;
    const candidate = isRecord(raw) ? raw as RawRevisionProposal : undefined;
    const atom = parseAtomReference(candidate?.atom);
    const replacement = parseReplacement(candidate?.replacement);
    const reason = cleanString(candidate?.reason, 500);
    const atomKnown = atom ? known.get(atom.atomId) : undefined;
    const proposalEvidence = [...new Set([
      ...evidence.refs,
      ...(atom ? [`memory-v3:atom:${atom.atomId}@${atom.expectedRevision}`] : []),
    ])].slice(0, 32);

    if (index >= MAX_REVISION_PROPOSALS) {
      decisions.push(decision(
        ctx,
        id,
        'rejected',
        'Only one Atom revision proposal may be considered in a single evolve run; this additional proposal was rejected.',
        atomKnown?.envelope.branch,
        atom ? `Refine the projection for ${atom.atomId}` : undefined,
        proposalEvidence,
        'rejected',
      ));
      continue;
    }

    const invalidReason = validateProposal({
      raw: candidate,
      atom,
      replacement,
      reason,
      atomKnown,
      evidence,
      contractAllowsRevise: Boolean(contract?.memoryIntentPolicy.allowed.includes('revise')),
    });
    if (invalidReason) {
      decisions.push(decision(
        ctx,
        id,
        'rejected',
        invalidReason,
        atomKnown?.envelope.branch,
        atom ? `Refine the projection for ${atom.atomId}` : undefined,
        proposalEvidence,
        'rejected',
      ));
      continue;
    }

    proposals.push({
      id,
      action: 'revise',
      basis: 'same-claim-refinement',
      atom: atom!,
      replacement: replacement!,
      reason: reason!,
      evidenceRefs: proposalEvidence,
    });
  }

  if (value.length > MAX_AUDITED_REVISION_PROPOSALS) {
    decisions.push(decision(
      ctx,
      `${ctx.runId}:evolve:revision:overflow`,
      'rejected',
      `The evolve response contained ${value.length - MAX_AUDITED_REVISION_PROPOSALS} additional revision proposal(s) beyond the bounded audit limit.`,
      undefined,
      undefined,
      evidence.refs,
      'rejected',
    ));
  }

  return { proposals, decisions };
}

function validateProposal(input: {
  raw?: RawRevisionProposal;
  atom?: MemoryAtomRevisionProposal['atom'];
  replacement?: MemoryAtomRevisionPatch;
  reason?: string;
  atomKnown?: RuntimeKnownStateMemoryReference;
  evidence: { refs: string[]; verified: boolean };
  contractAllowsRevise: boolean;
}): string | undefined {
  if (!input.raw || input.raw.action !== 'revise' || input.raw.basis !== 'same-claim-refinement') {
    return 'Only same-claim-refinement Atom revision proposals are accepted.';
  }
  const gateReason = validateEvolveAtomProposalGate({
    proposalKind: 'revision',
    contractAllowed: input.contractAllowsRevise,
    evidence: input.evidence,
  });
  if (gateReason) return gateReason;
  if (!input.atom || !input.replacement || !input.reason || input.reason.length < 12) {
    return 'An Atom revision proposal needs one Atom, a complete replacement projection and a concrete reason.';
  }
  if (!input.atomKnown || !isCurrentAdopted(input.atomKnown, input.atom.expectedRevision)) {
    return `Memory atom ${input.atom.atomId} is not an adopted, current, unconflicted KnownState reference.`;
  }
  if (!hasCompleteD3Envelope(input.atomKnown)) {
    return `Memory atom ${input.atom.atomId} must be a complete D3 KnownState reference before revision.`;
  }
  if (!knownStateEnvelopeMatches(input.atomKnown, input.atom.atomId, input.atom.expectedRevision)) {
    return `Memory atom ${input.atom.atomId} does not match its KnownState envelope revision.`;
  }
  return undefined;
}

function parseReplacement(value: unknown): MemoryAtomRevisionPatch | undefined {
  if (!isRecord(value)) return undefined;
  const title = boundedText(value.title, 500);
  const summary = boundedText(value.summary, 8_000);
  const content = boundedText(value.content, 12_000);
  if (!title || !summary || !content || !Array.isArray(value.retrievalKeys)) return undefined;
  if (value.retrievalKeys.length < 1 || value.retrievalKeys.length > 64) return undefined;
  const parsedKeys = value.retrievalKeys.map((entry) => boundedText(entry, 200));
  if (parsedKeys.some((entry) => !entry)) return undefined;
  const retrievalKeys = [...new Set(parsedKeys as string[])];
  return {
    title,
    summary,
    content,
    retrievalKeys,
  };
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length > max) return undefined;
  return cleanString(value, max);
}

function decision(
  ctx: RunContext,
  id: string,
  decisionValue: MemoryIntentDecisionRecord['decision'],
  reason: string,
  branch: string | undefined,
  summary: string | undefined,
  evidenceRefs: string[],
  reconciliationDecision: NonNullable<MemoryIntentDecisionRecord['reconciliationDecision']>,
): MemoryIntentDecisionRecord {
  return atomProposalDecisionRecord({
    ctx,
    id,
    proposedIntent: 'revise',
    decision: decisionValue,
    reason,
    branch,
    summary,
    evidenceRefs,
    reconciliationDecision,
  });
}
