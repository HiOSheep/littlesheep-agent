// Parses model fact-correction proposals and enforces complete KnownState,
// verification and contract gates before Runtime may supersede an Atom.

import type {
  MemoryIntentDecisionRecord,
  RunContext,
} from '@littlesheep/types';
import {
  MAX_CORRECTION_PROPOSALS,
  type MemoryAtomCorrectionProposal,
  type MemoryAtomCorrectionResult,
  type MemoryAtomCorrectionServiceLike,
} from '@littlesheep/memory-tree';
import {
  collectRunEvidence,
} from '../memory-intent-gate.js';
import {
  commitAtomProposalPlan,
  type AtomProposalCommitPlan,
  type EvolveAtomProposalResult,
} from './atom-proposal-commit.js';
import {
  atomProposalDecisionRecord,
  cleanString,
  isRecord,
  parseAtomReference,
} from './atom-proposal-support.js';
import {
  correctionSummary,
  parseCorrectionBasis,
  validateEvolveCorrectionProposal,
  type RawCorrectionProposal,
} from './correction-validation.js';

type CorrectionPlan = AtomProposalCommitPlan<MemoryAtomCorrectionProposal>;

const MAX_AUDITED_CORRECTION_PROPOSALS = MAX_CORRECTION_PROPOSALS + 1;

export type EvolveCorrectionResult = EvolveAtomProposalResult<MemoryAtomCorrectionResult>;

export async function processEvolveCorrections(
  value: unknown,
  ctx: RunContext,
  corrector?: MemoryAtomCorrectionServiceLike,
): Promise<EvolveCorrectionResult> {
  return commitAtomProposalPlan<MemoryAtomCorrectionProposal, MemoryAtomCorrectionResult>({
    ctx,
    plan: parsePlan(value, ctx),
    proposedIntent: 'conflict',
    serviceName: 'Correction',
    commit: corrector ? (proposals) => corrector.resolve(proposals) : undefined,
    summarizeProposal: (proposal) => correctionSummary(
      proposal.superseded.atomId,
      proposal.replacement.atomId,
    ),
    summarizeResult: (result) => correctionSummary(
      result.supersededAtomId,
      result.replacementAtomId,
    ),
  });
}

function parsePlan(value: unknown, ctx: RunContext): CorrectionPlan {
  if (!Array.isArray(value)) return { proposals: [], decisions: [] };

  const evidence = collectRunEvidence(ctx);
  const contract = [...(ctx.modelRequests ?? [])]
    .reverse()
    .find((snapshot) => snapshot.callContract?.purpose === 'evolve')
    ?.callContract;
  const known = new Map(
    (ctx.memoryKnownState?.references ?? []).map((reference) => [reference.atomId, reference]),
  );
  const proposals: MemoryAtomCorrectionProposal[] = [];
  const decisions: MemoryIntentDecisionRecord[] = [];

  for (const [index, raw] of value.slice(0, MAX_AUDITED_CORRECTION_PROPOSALS).entries()) {
    const id = `${ctx.runId}:evolve:correction:${index + 1}`;
    const candidate = isRecord(raw) ? raw as RawCorrectionProposal : undefined;
    const superseded = parseAtomReference(candidate?.superseded);
    const replacement = parseAtomReference(candidate?.replacement);
    const basis = parseCorrectionBasis(candidate?.basis);
    const relationId = cleanString(candidate?.relationId, 240);
    const reason = cleanString(candidate?.reason, 500);
    const supersededKnown = superseded ? known.get(superseded.atomId) : undefined;
    const replacementKnown = replacement ? known.get(replacement.atomId) : undefined;
    const proposalEvidence = [...new Set([
      ...evidence.refs,
      ...(superseded ? [`memory-v3:atom:${superseded.atomId}@${superseded.expectedRevision}`] : []),
      ...(replacement ? [`memory-v3:atom:${replacement.atomId}@${replacement.expectedRevision}`] : []),
      ...(relationId ? [`memory-v3:relation:${relationId}`] : []),
    ])].slice(0, 32);

    if (index >= MAX_CORRECTION_PROPOSALS) {
      decisions.push(decision(
        ctx,
        id,
        'rejected',
        'Only one Atom correction proposal may be considered in a single evolve run; this additional proposal was rejected.',
        supersededKnown?.envelope.branch,
        correctionSummary(superseded?.atomId, replacement?.atomId),
        proposalEvidence,
        'rejected',
      ));
      continue;
    }

    const invalidReason = validateEvolveCorrectionProposal({
      raw: candidate,
      basis,
      superseded,
      replacement,
      relationId,
      reason,
      supersededKnown,
      replacementKnown,
      evidence,
      contractAllowsConflict: Boolean(contract?.memoryIntentPolicy.allowed.includes('conflict')),
    });
    if (invalidReason) {
      decisions.push(decision(
        ctx,
        id,
        'rejected',
        invalidReason,
        supersededKnown?.envelope.branch,
        correctionSummary(superseded?.atomId, replacement?.atomId),
        proposalEvidence,
        'rejected',
      ));
      continue;
    }

    proposals.push({
      id,
      action: 'supersede',
      basis: basis!,
      superseded: superseded!,
      replacement: replacement!,
      relationId: relationId!,
      reason: reason!,
      evidenceRefs: proposalEvidence,
    });
  }

  if (value.length > MAX_AUDITED_CORRECTION_PROPOSALS) {
    decisions.push(decision(
      ctx,
      `${ctx.runId}:evolve:correction:overflow`,
      'rejected',
      `The evolve response contained ${value.length - MAX_AUDITED_CORRECTION_PROPOSALS} additional correction proposal(s) beyond the bounded audit limit.`,
      undefined,
      undefined,
      evidence.refs,
      'rejected',
    ));
  }

  return { proposals, decisions };
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
    proposedIntent: 'conflict',
    decision: decisionValue,
    reason,
    branch,
    summary,
    evidenceRefs,
    reconciliationDecision,
  });
}
