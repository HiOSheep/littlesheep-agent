// Owns the semantics-free Runtime call/result audit flow shared by bounded
// correction and revision proposals. Domain parsing and mutation stay outside.

import type {
  LlmMemoryIntentKind,
  MemoryIntentDecisionRecord,
  RunContext,
} from '@littlesheep/types';
import { appendMemoryIntentDecisionRecords } from '../memory-intent-gate.js';
import { atomProposalDecisionRecord } from './atom-proposal-support.js';

type AtomProposalRuntimeStatus = Exclude<
  NonNullable<MemoryIntentDecisionRecord['reconciliationDecision']>,
  'partial'
>;

interface AtomProposalForCommit {
  id: string;
  evidenceRefs: readonly string[];
}

interface AtomProposalRuntimeResult {
  proposalId: string;
  status: AtomProposalRuntimeStatus;
  reason: string;
}

export interface AtomProposalCommitPlan<TProposal extends AtomProposalForCommit> {
  proposals: TProposal[];
  decisions: MemoryIntentDecisionRecord[];
}

export interface EvolveAtomProposalResult<TResult extends AtomProposalRuntimeResult> {
  results: TResult[];
  decisions: MemoryIntentDecisionRecord[];
}

interface CommitAtomProposalPlanOptions<
  TProposal extends AtomProposalForCommit,
  TResult extends AtomProposalRuntimeResult,
> {
  ctx: RunContext;
  plan: AtomProposalCommitPlan<TProposal>;
  proposedIntent: Extract<LlmMemoryIntentKind, 'conflict' | 'revise'>;
  serviceName: string;
  commit?: (proposals: readonly TProposal[]) => Promise<TResult[]>;
  summarizeProposal: (proposal: TProposal) => string | undefined;
  summarizeResult: (result: TResult) => string | undefined;
}

/** Call one domain service and audit every proposal without owning its semantics. */
export async function commitAtomProposalPlan<
  TProposal extends AtomProposalForCommit,
  TResult extends AtomProposalRuntimeResult,
>(options: CommitAtomProposalPlanOptions<TProposal, TResult>): Promise<EvolveAtomProposalResult<TResult>> {
  const decisions = [...options.plan.decisions];
  const record = (
    proposal: TProposal,
    decision: MemoryIntentDecisionRecord['decision'],
    reason: string,
    summary: string | undefined,
    reconciliationDecision: NonNullable<MemoryIntentDecisionRecord['reconciliationDecision']>,
  ): void => {
    decisions.push(atomProposalDecisionRecord({
      ctx: options.ctx,
      id: proposal.id,
      proposedIntent: options.proposedIntent,
      decision,
      reason,
      summary,
      evidenceRefs: [...proposal.evidenceRefs],
      reconciliationDecision,
    }));
  };
  const finish = (results: TResult[]): EvolveAtomProposalResult<TResult> => {
    appendMemoryIntentDecisionRecords(options.ctx, decisions);
    return { results, decisions };
  };
  const deferAll = (reason: string): EvolveAtomProposalResult<TResult> => {
    for (const proposal of options.plan.proposals) {
      record(proposal, 'deferred', reason, options.summarizeProposal(proposal), 'deferred');
    }
    return finish([]);
  };

  if (options.plan.proposals.length === 0) return finish([]);

  const serviceName = options.serviceName.trim();
  const lowerServiceName = serviceName.toLowerCase();
  if (!options.commit) {
    return deferAll(`The runtime has no Atom ${lowerServiceName} service.`);
  }

  let results: TResult[];
  try {
    results = await options.commit(options.plan.proposals);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return deferAll(`${serviceName} service failed before commit: ${message}`);
  }

  const resultById = new Map(results.map((result) => [result.proposalId, result]));
  for (const proposal of options.plan.proposals) {
    const result = resultById.get(proposal.id);
    if (!result) {
      record(
        proposal,
        'deferred',
        `The ${lowerServiceName} service returned no result for the proposal.`,
        options.summarizeProposal(proposal),
        'deferred',
      );
      continue;
    }
    record(
      proposal,
      runtimeDecision(result.status),
      result.reason,
      options.summarizeResult(result),
      result.status,
    );
  }
  return finish(results);
}

function runtimeDecision(status: AtomProposalRuntimeStatus): MemoryIntentDecisionRecord['decision'] {
  return status === 'rejected'
    ? 'rejected'
    : status === 'deferred'
      ? 'deferred'
      : 'committed';
}
