import {
  type MemoryIntentDecisionRecord,
  type RunContext,
  type RuntimeKnownStateMemoryReference,
} from '@littlesheep/types';
import type {
  MemoryAtomReconciliationProposal,
  MemoryAtomReconciliationResult,
  MemoryAtomReconciliationServiceLike,
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

interface AtomReferenceProposal {
  atomId?: unknown;
  expectedRevision?: unknown;
  revision?: unknown;
}

interface AtomReconciliationProposal {
  action?: unknown;
  basis?: unknown;
  target?: AtomReferenceProposal;
  sources?: unknown;
  reason?: unknown;
}

interface ReconciliationPlan {
  proposals: MemoryAtomReconciliationProposal[];
  decisions: MemoryIntentDecisionRecord[];
}

export interface EvolveReconciliationResult {
  results: MemoryAtomReconciliationResult[];
  decisions: MemoryIntentDecisionRecord[];
}

export async function processEvolveReconciliations(
  value: unknown,
  ctx: RunContext,
  reconciler?: MemoryAtomReconciliationServiceLike,
): Promise<EvolveReconciliationResult> {
  return commitPlan(ctx, reconciler, parsePlan(value, ctx));
}

function parsePlan(value: unknown, ctx: RunContext): ReconciliationPlan {
  if (!Array.isArray(value)) return { proposals: [], decisions: [] };
  const evidence = collectRunEvidence(ctx);
  const contract = [...(ctx.modelRequests ?? [])]
    .reverse()
    .find((snapshot) => snapshot.callContract?.purpose === 'evolve')
    ?.callContract;
  const known = new Map((ctx.memoryKnownState?.references ?? []).map((reference) => [reference.atomId, reference]));
  const proposals: MemoryAtomReconciliationProposal[] = [];
  const decisions: MemoryIntentDecisionRecord[] = [];

  for (const [index, raw] of value.slice(0, 2).entries()) {
    const id = `${ctx.runId}:evolve:reconciliation:${index + 1}`;
    const candidate = isRecord(raw) ? raw as AtomReconciliationProposal : undefined;
    const target = parseAtomReference(candidate?.target);
    const sources = Array.isArray(candidate?.sources)
      ? candidate.sources.slice(0, 4).map(parseAtomReference).filter((ref): ref is NonNullable<typeof ref> => Boolean(ref))
      : [];
    const reason = cleanString(candidate?.reason, 500);
    const atomRefs = [target, ...sources]
      .filter((ref): ref is NonNullable<typeof ref> => Boolean(ref))
      .map((ref) => `memory-v3:atom:${ref.atomId}@${ref.expectedRevision}`);
    const proposalEvidence = [...new Set([...evidence.refs, ...atomRefs])].slice(0, 32);
    const targetKnown = target ? known.get(target.atomId) : undefined;
    const invalidReason = validateProposal({
      raw: candidate,
      target,
      sources,
      reason,
      targetKnown,
      known,
      evidence,
      contractAllowsMerge: Boolean(contract?.memoryIntentPolicy.allowed.includes('merge')),
    });
    if (invalidReason) {
      decisions.push(decisionRecord(
        ctx, id, 'rejected', invalidReason, targetKnown?.envelope.branch,
        target ? `Merge proposal for ${target.atomId}` : undefined,
        proposalEvidence, 'rejected',
      ));
      continue;
    }
    proposals.push({
      id,
      action: 'merge',
      basis: 'duplicate-projection',
      target: target!,
      sources,
      reason: reason!,
      evidenceRefs: proposalEvidence,
    });
  }
  return { proposals, decisions };
}

async function commitPlan(
  ctx: RunContext,
  reconciler: MemoryAtomReconciliationServiceLike | undefined,
  plan: ReconciliationPlan,
): Promise<EvolveReconciliationResult> {
  const decisions = [...plan.decisions];
  if (plan.proposals.length === 0) {
    appendMemoryIntentDecisionRecords(ctx, decisions);
    return { results: [], decisions };
  }
  if (!reconciler) {
    for (const proposal of plan.proposals) {
      decisions.push(decisionRecord(
        ctx, proposal.id, 'deferred', 'The runtime has no Atom reconciliation service.', undefined,
        `Merge proposal for ${proposal.target.atomId}`, proposal.evidenceRefs, 'deferred',
      ));
    }
    appendMemoryIntentDecisionRecords(ctx, decisions);
    return { results: [], decisions };
  }

  let results: MemoryAtomReconciliationResult[];
  try {
    results = await reconciler.reconcile(plan.proposals);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const proposal of plan.proposals) {
      decisions.push(decisionRecord(
        ctx, proposal.id, 'deferred', `Reconciliation service failed before commit: ${message}`, undefined,
        `Merge proposal for ${proposal.target.atomId}`, proposal.evidenceRefs, 'deferred',
      ));
    }
    appendMemoryIntentDecisionRecords(ctx, decisions);
    return { results: [], decisions };
  }

  const resultById = new Map(results.map((result) => [result.proposalId, result]));
  for (const proposal of plan.proposals) {
    const result = resultById.get(proposal.id);
    if (!result) {
      decisions.push(decisionRecord(
        ctx, proposal.id, 'deferred', 'The reconciliation service returned no result for the proposal.', undefined,
        `Merge proposal for ${proposal.target.atomId}`, proposal.evidenceRefs, 'deferred',
      ));
      continue;
    }
    const runtimeDecision = result.status === 'rejected'
      ? 'rejected'
      : result.status === 'deferred' || result.status === 'partial'
        ? 'deferred'
        : 'committed';
    decisions.push(decisionRecord(
      ctx, proposal.id, runtimeDecision, result.reason, undefined,
      `Merge proposal for ${result.targetAtomId}`, proposal.evidenceRefs, result.status,
    ));
  }
  appendMemoryIntentDecisionRecords(ctx, decisions);
  return { results, decisions };
}

function validateProposal(input: {
  raw?: AtomReconciliationProposal;
  target?: { atomId: string; expectedRevision: number };
  sources: Array<{ atomId: string; expectedRevision: number }>;
  reason?: string;
  targetKnown?: RuntimeKnownStateMemoryReference;
  known: Map<string, RuntimeKnownStateMemoryReference>;
  evidence: { refs: string[]; verified: boolean };
  contractAllowsMerge: boolean;
}): string | undefined {
  if (!input.raw || input.raw.action !== 'merge' || input.raw.basis !== 'duplicate-projection') {
    return 'Only duplicate-projection merge proposals are accepted.';
  }
  if (!input.contractAllowsMerge) return 'The evolve call contract does not allow merge proposals.';
  if (!input.evidence.verified || input.evidence.refs.length === 0) {
    return 'A merge proposal requires a passing verification record and runtime evidence.';
  }
  if (!input.target || input.sources.length < 1 || input.sources.length > 4 || !input.reason || input.reason.length < 12) {
    return 'A merge proposal needs one target, 1-4 source atoms and a concrete reason.';
  }
  if (input.sources.some((source) => source.atomId === input.target!.atomId)
    || new Set(input.sources.map((source) => source.atomId)).size !== input.sources.length) {
    return 'A merge proposal cannot contain a self-reference or duplicate source atom.';
  }
  const target = input.known.get(input.target.atomId);
  if (!input.targetKnown || !target || !isCurrentAdopted(target, input.target.expectedRevision)) {
    return `Target atom ${input.target.atomId} is not an adopted, current, unconflicted KnownState reference.`;
  }
  for (const source of input.sources) {
    const reference = input.known.get(source.atomId);
    if (!reference || !isCurrentAdopted(reference, source.expectedRevision)) {
      return `Source atom ${source.atomId} is not an adopted, current, unconflicted KnownState reference.`;
    }
    if (reference.envelope.branch !== target.envelope.branch
      || reference.envelope.scope !== target.envelope.scope
      || (reference.envelope.scopeKey ?? '') !== (target.envelope.scopeKey ?? '')) {
      return `Source atom ${source.atomId} crosses the target scope boundary.`;
    }
  }
  return undefined;
}

function decisionRecord(
  ctx: RunContext,
  id: string,
  decision: MemoryIntentDecisionRecord['decision'],
  reason: string,
  branch: string | undefined,
  summary: string | undefined,
  evidenceRefs: string[],
  reconciliationDecision: NonNullable<MemoryIntentDecisionRecord['reconciliationDecision']>,
): MemoryIntentDecisionRecord {
  return atomProposalDecisionRecord({
    ctx,
    id,
    proposedIntent: 'merge',
    decision,
    reason,
    branch,
    summary,
    evidenceRefs,
    reconciliationDecision,
  });
}
