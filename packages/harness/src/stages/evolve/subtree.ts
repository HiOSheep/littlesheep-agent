// Parses model subtree proposals and keeps non-leaf structural mutation behind
// complete KnownState, VERIFY, relation, size and Runtime commit boundaries.

import type {
  MemoryIntentDecisionRecord,
  RunContext,
} from '@littlesheep/types';
import {
  MAX_SUBTREE_PROPOSALS,
  type MemoryAtomSubtreeMoveProposal,
  type MemoryAtomSubtreeResult,
  type MemoryAtomSubtreeServiceLike,
} from '@littlesheep/memory-tree';
import {
  appendMemoryIntentDecisionRecords,
  collectRunEvidence,
} from '../memory-intent-gate.js';
import {
  atomProposalDecisionRecord,
  cleanString,
  isRecord,
  parseAtomReference,
} from './atom-proposal-support.js';
import {
  validateEvolveSubtreeMove,
  type RawSubtreeMoveProposal,
} from './subtree-validation.js';

interface SubtreePlan {
  proposals: MemoryAtomSubtreeMoveProposal[];
  decisions: MemoryIntentDecisionRecord[];
}

const MAX_AUDITED_SUBTREE_PROPOSALS = MAX_SUBTREE_PROPOSALS + 1;

export interface EvolveSubtreeResult {
  results: MemoryAtomSubtreeResult[];
  decisions: MemoryIntentDecisionRecord[];
}

export async function processEvolveSubtreeMoves(
  value: unknown,
  ctx: RunContext,
  service?: MemoryAtomSubtreeServiceLike,
): Promise<EvolveSubtreeResult> {
  return commitPlan(ctx, service, parsePlan(value, ctx));
}

function parsePlan(value: unknown, ctx: RunContext): SubtreePlan {
  if (!Array.isArray(value)) return { proposals: [], decisions: [] };
  const evidence = collectRunEvidence(ctx);
  const contract = [...(ctx.modelRequests ?? [])]
    .reverse()
    .find((snapshot) => snapshot.callContract?.purpose === 'evolve')
    ?.callContract;
  const known = new Map((ctx.memoryKnownState?.references ?? [])
    .map((reference) => [reference.atomId, reference]));
  const proposals: MemoryAtomSubtreeMoveProposal[] = [];
  const decisions: MemoryIntentDecisionRecord[] = [];

  for (const [index, raw] of value.slice(0, MAX_AUDITED_SUBTREE_PROPOSALS).entries()) {
    const id = `${ctx.runId}:evolve:subtree:${index + 1}`;
    const candidate = isRecord(raw) ? raw as RawSubtreeMoveProposal : undefined;
    const root = parseAtomReference(candidate?.root);
    const parent = parseAtomReference(candidate?.parent);
    const relationId = cleanString(candidate?.relationId, 240);
    const reason = cleanString(candidate?.reason, 500);
    const rootKnown = root ? known.get(root.atomId) : undefined;
    const parentKnown = parent ? known.get(parent.atomId) : undefined;
    const proposalEvidence = [...new Set([
      ...evidence.refs,
      ...(root ? [`memory-v3:atom:${root.atomId}@${root.expectedRevision}`] : []),
      ...(parent ? [`memory-v3:atom:${parent.atomId}@${parent.expectedRevision}`] : []),
      ...(relationId ? [`memory-v3:relation:${relationId}`] : []),
    ])].slice(0, 32);

    if (index >= MAX_SUBTREE_PROPOSALS) {
      decisions.push(decision(
        ctx,
        id,
        'rejected',
        'Only one subtree move proposal may be considered in a single evolve run; this additional proposal was rejected.',
        rootKnown?.envelope.branch,
        summary(root?.atomId, parent?.atomId),
        proposalEvidence,
        'rejected',
      ));
      continue;
    }

    const invalidReason = validateEvolveSubtreeMove({
      raw: candidate,
      root,
      parent,
      relationId,
      reason,
      rootKnown,
      parentKnown,
      evidence,
      contractAllowsMove: Boolean(contract?.memoryIntentPolicy.allowed.includes('move')),
    });
    if (invalidReason) {
      decisions.push(decision(
        ctx,
        id,
        'rejected',
        invalidReason,
        rootKnown?.envelope.branch,
        summary(root?.atomId, parent?.atomId),
        proposalEvidence,
        'rejected',
      ));
      continue;
    }
    proposals.push({
      id,
      action: 'move-subtree',
      basis: 'explicit-parent-relation',
      root: root!,
      parent: parent!,
      relationId: relationId!,
      reason: reason!,
      evidenceRefs: proposalEvidence,
    });
  }

  if (value.length > MAX_AUDITED_SUBTREE_PROPOSALS) {
    decisions.push(decision(
      ctx,
      `${ctx.runId}:evolve:subtree:overflow`,
      'rejected',
      `The evolve response contained ${value.length - MAX_AUDITED_SUBTREE_PROPOSALS} additional subtree proposal(s) beyond the bounded audit limit.`,
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
  service: MemoryAtomSubtreeServiceLike | undefined,
  plan: SubtreePlan,
): Promise<EvolveSubtreeResult> {
  const decisions = [...plan.decisions];
  if (plan.proposals.length === 0) {
    appendMemoryIntentDecisionRecords(ctx, decisions);
    return { results: [], decisions };
  }
  if (!service) {
    for (const proposal of plan.proposals) {
      decisions.push(decision(
        ctx,
        proposal.id,
        'deferred',
        'The runtime has no Atom subtree service.',
        undefined,
        summary(proposal.root.atomId, proposal.parent.atomId),
        proposal.evidenceRefs,
        'deferred',
      ));
    }
    appendMemoryIntentDecisionRecords(ctx, decisions);
    return { results: [], decisions };
  }

  let results: MemoryAtomSubtreeResult[];
  try {
    results = await service.moveSubtrees(plan.proposals);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const proposal of plan.proposals) {
      decisions.push(decision(
        ctx,
        proposal.id,
        'deferred',
        `Subtree service failed before commit: ${message}`,
        undefined,
        summary(proposal.root.atomId, proposal.parent.atomId),
        proposal.evidenceRefs,
        'deferred',
      ));
    }
    appendMemoryIntentDecisionRecords(ctx, decisions);
    return { results: [], decisions };
  }

  const byId = new Map(results.map((result) => [result.proposalId, result]));
  for (const proposal of plan.proposals) {
    const result = byId.get(proposal.id);
    if (!result) {
      decisions.push(decision(
        ctx,
        proposal.id,
        'deferred',
        'The subtree service returned no result for the proposal.',
        undefined,
        summary(proposal.root.atomId, proposal.parent.atomId),
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
      summary(result.rootAtomId, result.parentAtomId),
      proposal.evidenceRefs,
      result.status,
    ));
  }
  appendMemoryIntentDecisionRecords(ctx, decisions);
  return { results, decisions };
}

function summary(rootAtomId?: string, parentAtomId?: string): string | undefined {
  return rootAtomId && parentAtomId
    ? `Move subtree ${rootAtomId} under ${parentAtomId}`
    : undefined;
}

function decision(
  ctx: RunContext,
  id: string,
  decisionValue: MemoryIntentDecisionRecord['decision'],
  reason: string,
  branch: string | undefined,
  summaryValue: string | undefined,
  evidenceRefs: string[],
  reconciliationDecision: NonNullable<MemoryIntentDecisionRecord['reconciliationDecision']>,
): MemoryIntentDecisionRecord {
  return atomProposalDecisionRecord({
    ctx,
    id,
    proposedIntent: 'move',
    decision: decisionValue,
    reason,
    branch,
    summary: summaryValue,
    evidenceRefs,
    reconciliationDecision,
  });
}
