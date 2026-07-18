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
  appendMemoryIntentDecisionRecords,
  collectRunEvidence,
} from '../memory-intent-gate.js';
import {
  atomProposalDecisionRecord,
  cleanString,
  isCurrentAdopted,
  isRecord,
  parseAtomReference,
} from './atom-proposal-support.js';

interface RawRevisionProposal {
  action?: unknown;
  basis?: unknown;
  atom?: unknown;
  replacement?: unknown;
  reason?: unknown;
}

interface RevisionPlan {
  proposals: MemoryAtomRevisionProposal[];
  decisions: MemoryIntentDecisionRecord[];
}

const MAX_AUDITED_REVISION_PROPOSALS = MAX_REVISION_PROPOSALS + 1;

export interface EvolveRevisionResult {
  results: MemoryAtomRevisionResult[];
  decisions: MemoryIntentDecisionRecord[];
}

export async function processEvolveRevisions(
  value: unknown,
  ctx: RunContext,
  reviser?: MemoryAtomRevisionServiceLike,
): Promise<EvolveRevisionResult> {
  return commitPlan(ctx, reviser, parsePlan(value, ctx));
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

async function commitPlan(
  ctx: RunContext,
  reviser: MemoryAtomRevisionServiceLike | undefined,
  plan: RevisionPlan,
): Promise<EvolveRevisionResult> {
  const decisions = [...plan.decisions];
  if (plan.proposals.length === 0) {
    appendMemoryIntentDecisionRecords(ctx, decisions);
    return { results: [], decisions };
  }
  if (!reviser) {
    for (const proposal of plan.proposals) {
      decisions.push(decision(
        ctx,
        proposal.id,
        'deferred',
        'The runtime has no Atom revision service.',
        undefined,
        `Refine the projection for ${proposal.atom.atomId}`,
        proposal.evidenceRefs,
        'deferred',
      ));
    }
    appendMemoryIntentDecisionRecords(ctx, decisions);
    return { results: [], decisions };
  }

  let results: MemoryAtomRevisionResult[];
  try {
    results = await reviser.revise(plan.proposals);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const proposal of plan.proposals) {
      decisions.push(decision(
        ctx,
        proposal.id,
        'deferred',
        `Revision service failed before commit: ${message}`,
        undefined,
        `Refine the projection for ${proposal.atom.atomId}`,
        proposal.evidenceRefs,
        'deferred',
      ));
    }
    appendMemoryIntentDecisionRecords(ctx, decisions);
    return { results: [], decisions };
  }

  const resultById = new Map(results.map((result) => [result.proposalId, result]));
  for (const proposal of plan.proposals) {
    const result = resultById.get(proposal.id);
    if (!result) {
      decisions.push(decision(
        ctx,
        proposal.id,
        'deferred',
        'The revision service returned no result for the proposal.',
        undefined,
        `Refine the projection for ${proposal.atom.atomId}`,
        proposal.evidenceRefs,
        'deferred',
      ));
      continue;
    }
    const runtimeDecision = result.status === 'rejected'
      ? 'rejected'
      : result.status === 'deferred'
        ? 'deferred'
        : 'committed';
    decisions.push(decision(
      ctx,
      proposal.id,
      runtimeDecision,
      result.reason,
      undefined,
      `Refine the projection for ${result.atomId}`,
      proposal.evidenceRefs,
      result.status,
    ));
  }
  appendMemoryIntentDecisionRecords(ctx, decisions);
  return { results, decisions };
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
  if (!input.contractAllowsRevise) return 'The evolve call contract does not allow Atom revision proposals.';
  if (!input.evidence.verified || input.evidence.refs.length === 0) {
    return 'An Atom revision proposal requires a passing verification record and runtime evidence.';
  }
  if (!input.atom || !input.replacement || !input.reason || input.reason.length < 12) {
    return 'An Atom revision proposal needs one Atom, a complete replacement projection and a concrete reason.';
  }
  if (!input.atomKnown || !isCurrentAdopted(input.atomKnown, input.atom.expectedRevision)) {
    return `Memory atom ${input.atom.atomId} is not an adopted, current, unconflicted KnownState reference.`;
  }
  if (input.atomKnown.envelope.disclosureLevel !== 'D3' || input.atomKnown.envelope.truncated) {
    return `Memory atom ${input.atom.atomId} must be a complete D3 KnownState reference before revision.`;
  }
  if (input.atomKnown.envelope.atomId !== input.atom.atomId
    || input.atomKnown.envelope.atomRevision !== input.atom.expectedRevision) {
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
