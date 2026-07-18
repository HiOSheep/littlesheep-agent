import type {
  MemoryIntentDecisionRecord,
  RunContext,
  RuntimeKnownStateMemoryReference,
} from '@littlesheep/types';
import type {
  MemoryAtomHierarchyResult,
  MemoryAtomHierarchyServiceLike,
  MemoryAtomReparentProposal,
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

interface RawReparentProposal {
  action?: unknown;
  basis?: unknown;
  atom?: unknown;
  parent?: unknown;
  relationId?: unknown;
  reason?: unknown;
}

interface HierarchyPlan {
  proposals: MemoryAtomReparentProposal[];
  decisions: MemoryIntentDecisionRecord[];
}

const MAX_AUDITED_REPARENT_PROPOSALS = 8;

export interface EvolveHierarchyResult {
  results: MemoryAtomHierarchyResult[];
  decisions: MemoryIntentDecisionRecord[];
}

export async function processEvolveReparents(
  value: unknown,
  ctx: RunContext,
  hierarchy?: MemoryAtomHierarchyServiceLike,
): Promise<EvolveHierarchyResult> {
  return commitPlan(ctx, hierarchy, parsePlan(value, ctx));
}

function parsePlan(value: unknown, ctx: RunContext): HierarchyPlan {
  if (!Array.isArray(value)) return { proposals: [], decisions: [] };
  const evidence = collectRunEvidence(ctx);
  const contract = [...(ctx.modelRequests ?? [])]
    .reverse()
    .find((snapshot) => snapshot.callContract?.purpose === 'evolve')
    ?.callContract;
  const known = new Map((ctx.memoryKnownState?.references ?? []).map((reference) => [reference.atomId, reference]));
  const proposals: MemoryAtomReparentProposal[] = [];
  const decisions: MemoryIntentDecisionRecord[] = [];

  for (const [index, raw] of value.slice(0, MAX_AUDITED_REPARENT_PROPOSALS).entries()) {
    const id = `${ctx.runId}:evolve:reparent:${index + 1}`;
    const candidate = isRecord(raw) ? raw as RawReparentProposal : undefined;
    const atom = parseAtomReference(candidate?.atom);
    const parent = parseAtomReference(candidate?.parent);
    const relationId = cleanString(candidate?.relationId, 240);
    const reason = cleanString(candidate?.reason, 500);
    const atomKnown = atom ? known.get(atom.atomId) : undefined;
    const parentKnown = parent ? known.get(parent.atomId) : undefined;
    const proposalEvidence = [...new Set([
      ...evidence.refs,
      ...(atom ? [`memory-v3:atom:${atom.atomId}@${atom.expectedRevision}`] : []),
      ...(parent ? [`memory-v3:atom:${parent.atomId}@${parent.expectedRevision}`] : []),
      ...(relationId ? [`memory-v3:relation:${relationId}`] : []),
    ])].slice(0, 32);
    if (index > 0) {
      decisions.push(decision(
        ctx,
        id,
        'rejected',
        'Only one reparent proposal may be considered in a single evolve run; this additional proposal was rejected.',
        atomKnown?.envelope.branch,
        atom && parent ? `Move ${atom.atomId} under ${parent.atomId}` : undefined,
        proposalEvidence,
        'rejected',
      ));
      continue;
    }
    const invalidReason = validateProposal({
      raw: candidate,
      atom,
      parent,
      relationId,
      reason,
      atomKnown,
      parentKnown,
      evidence,
      contractAllowsMove: Boolean(contract?.memoryIntentPolicy.allowed.includes('move')),
    });
    if (invalidReason) {
      decisions.push(decision(ctx, id, 'rejected', invalidReason, atomKnown?.envelope.branch,
        atom && parent ? `Move ${atom.atomId} under ${parent.atomId}` : undefined,
        proposalEvidence, 'rejected'));
      continue;
    }
    proposals.push({
      id,
      action: 'move',
      basis: 'explicit-parent-relation',
      atom: atom!,
      parent: parent!,
      relationId: relationId!,
      reason: reason!,
      evidenceRefs: proposalEvidence,
    });
  }
  if (value.length > MAX_AUDITED_REPARENT_PROPOSALS) {
    decisions.push(decision(
      ctx,
      `${ctx.runId}:evolve:reparent:overflow`,
      'rejected',
      `The evolve response contained ${value.length - MAX_AUDITED_REPARENT_PROPOSALS} additional reparent proposal(s) beyond the bounded audit limit.`,
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
  hierarchy: MemoryAtomHierarchyServiceLike | undefined,
  plan: HierarchyPlan,
): Promise<EvolveHierarchyResult> {
  const decisions = [...plan.decisions];
  if (plan.proposals.length === 0) {
    appendMemoryIntentDecisionRecords(ctx, decisions);
    return { results: [], decisions };
  }
  if (!hierarchy) {
    for (const proposal of plan.proposals) {
      decisions.push(decision(ctx, proposal.id, 'deferred', 'The runtime has no Atom hierarchy service.', undefined,
        `Move ${proposal.atom.atomId} under ${proposal.parent.atomId}`, proposal.evidenceRefs, 'deferred'));
    }
    appendMemoryIntentDecisionRecords(ctx, decisions);
    return { results: [], decisions };
  }

  let results: MemoryAtomHierarchyResult[];
  try {
    results = await hierarchy.reparent(plan.proposals);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const proposal of plan.proposals) {
      decisions.push(decision(ctx, proposal.id, 'deferred', `Hierarchy service failed before commit: ${message}`, undefined,
        `Move ${proposal.atom.atomId} under ${proposal.parent.atomId}`, proposal.evidenceRefs, 'deferred'));
    }
    appendMemoryIntentDecisionRecords(ctx, decisions);
    return { results: [], decisions };
  }

  const byId = new Map(results.map((result) => [result.proposalId, result]));
  for (const proposal of plan.proposals) {
    const result = byId.get(proposal.id);
    if (!result) {
      decisions.push(decision(ctx, proposal.id, 'deferred', 'The hierarchy service returned no result for the proposal.', undefined,
        `Move ${proposal.atom.atomId} under ${proposal.parent.atomId}`, proposal.evidenceRefs, 'deferred'));
      continue;
    }
    const runtimeDecision = result.status === 'rejected'
      ? 'rejected'
      : result.status === 'deferred'
        ? 'deferred'
        : 'committed';
    decisions.push(decision(ctx, proposal.id, runtimeDecision, result.reason, undefined,
      `Move ${result.atomId} under ${result.parentAtomId}`, proposal.evidenceRefs, result.status));
  }
  appendMemoryIntentDecisionRecords(ctx, decisions);
  return { results, decisions };
}

function validateProposal(input: {
  raw?: RawReparentProposal;
  atom?: MemoryAtomReparentProposal['atom'];
  parent?: MemoryAtomReparentProposal['parent'];
  relationId?: string;
  reason?: string;
  atomKnown?: RuntimeKnownStateMemoryReference;
  parentKnown?: RuntimeKnownStateMemoryReference;
  evidence: { refs: string[]; verified: boolean };
  contractAllowsMove: boolean;
}): string | undefined {
  if (!input.raw || input.raw.action !== 'move' || input.raw.basis !== 'explicit-parent-relation') {
    return 'Only explicit-parent-relation move proposals are accepted.';
  }
  if (!input.contractAllowsMove) return 'The evolve call contract does not allow hierarchy move proposals.';
  if (!input.evidence.verified || input.evidence.refs.length === 0) {
    return 'A hierarchy proposal requires a passing verification record and runtime evidence.';
  }
  if (!input.atom || !input.parent || !input.relationId || !input.reason || input.reason.length < 12) {
    return 'A hierarchy proposal needs one atom, one parent, one relation id and a concrete reason.';
  }
  if (input.atom.atomId === input.parent.atomId) return 'A memory atom cannot become its own parent.';
  if (!input.atomKnown || !isCurrentAdopted(input.atomKnown, input.atom.expectedRevision)) {
    return `Memory atom ${input.atom.atomId} is not an adopted, current D2/D3 KnownState reference.`;
  }
  if (!input.parentKnown || !isCurrentAdopted(input.parentKnown, input.parent.expectedRevision)) {
    return `Parent atom ${input.parent.atomId} is not an adopted, current D2/D3 KnownState reference.`;
  }
  if (input.atomKnown.envelope.branch !== input.parentKnown.envelope.branch
    || input.atomKnown.envelope.scope !== input.parentKnown.envelope.scope
    || (input.atomKnown.envelope.scopeKey ?? '') !== (input.parentKnown.envelope.scopeKey ?? '')) {
    return `Parent atom ${input.parent.atomId} crosses the hierarchy scope boundary.`;
  }
  return undefined;
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
    proposedIntent: 'move',
    decision: decisionValue,
    reason,
    branch,
    summary,
    evidenceRefs,
    reconciliationDecision,
  });
}
