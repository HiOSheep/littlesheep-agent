import { describe, expect, it, vi } from 'vitest';
import type { MemoryIntentDecisionRecord, RunContext } from '@littlesheep/types';
import { makeCtx } from '../../tests/helpers.js';
import { atomProposalDecisionRecord } from './atom-proposal-support.js';
import { commitAtomProposalPlan } from './atom-proposal-commit.js';

interface TestProposal {
  id: string;
  evidenceRefs: string[];
}

interface TestResult {
  proposalId: string;
  status: 'committed' | 'noop' | 'rejected' | 'deferred';
  reason: string;
}

describe('EVOLVE Atom proposal commit flow', () => {
  it('keeps parse decisions in order and skips Runtime when no proposal survived validation', async () => {
    const ctx = makeCtx();
    const parsedDecision = seedDecision(ctx, 'parsed-rejection');
    const writes = trackDecisionWrites(ctx);
    const commit = vi.fn();

    const result = await commitAtomProposalPlan<TestProposal, TestResult>({
      ctx,
      plan: { proposals: [], decisions: [parsedDecision] },
      proposedIntent: 'revise',
      serviceName: 'Revision',
      commit,
      summarizeProposal: (proposal) => proposal.id,
      summarizeResult: (runtimeResult) => runtimeResult.proposalId,
    });

    expect(commit).not.toHaveBeenCalled();
    expect(result).toEqual({ results: [], decisions: [parsedDecision] });
    expect(writes.count()).toBe(1);
    expect(writes.value()).toEqual([parsedDecision]);
  });

  it('defers once without calling Runtime when the domain service is unavailable', async () => {
    const ctx = makeCtx();
    const writes = trackDecisionWrites(ctx);
    const proposal = testProposal('revision-1');

    const result = await commitAtomProposalPlan<TestProposal, TestResult>({
      ctx,
      plan: { proposals: [proposal], decisions: [] },
      proposedIntent: 'revise',
      serviceName: 'Revision',
      summarizeProposal: (candidate) => `Refine ${candidate.id}`,
      summarizeResult: (runtimeResult) => `Refined ${runtimeResult.proposalId}`,
    });

    expect(result.results).toEqual([]);
    expect(result.decisions).toEqual([
      expect.objectContaining({
        id: 'revision-1',
        proposedIntent: 'revise',
        decision: 'deferred',
        reconciliationDecision: 'deferred',
        reason: 'The runtime has no Atom revision service.',
        summary: 'Refine revision-1',
      }),
    ]);
    expect(writes.count()).toBe(1);
  });

  it('converts one Runtime failure into ordered deferred audits and one Memory-state write', async () => {
    const ctx = makeCtx();
    const writes = trackDecisionWrites(ctx);
    const proposals = [testProposal('correction-1'), testProposal('correction-2')];
    const commit = vi.fn(async () => {
      throw new Error('backend offline');
    });

    const result = await commitAtomProposalPlan<TestProposal, TestResult>({
      ctx,
      plan: { proposals, decisions: [] },
      proposedIntent: 'conflict',
      serviceName: 'Correction',
      commit,
      summarizeProposal: (proposal) => `Supersede ${proposal.id}`,
      summarizeResult: (runtimeResult) => `Superseded ${runtimeResult.proposalId}`,
    });

    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(proposals);
    expect(result.results).toEqual([]);
    expect(result.decisions.map((decision) => [decision.id, decision.reason])).toEqual([
      ['correction-1', 'Correction service failed before commit: backend offline'],
      ['correction-2', 'Correction service failed before commit: backend offline'],
    ]);
    expect(writes.count()).toBe(1);
  });

  it('matches Runtime results by proposal id while preserving result and audit ordering', async () => {
    const ctx = makeCtx();
    const writes = trackDecisionWrites(ctx);
    const proposals = [
      testProposal('proposal-rejected'),
      testProposal('proposal-deferred'),
      testProposal('proposal-noop'),
      testProposal('proposal-missing'),
    ];
    const runtimeResults: TestResult[] = [
      { proposalId: 'proposal-noop', status: 'noop', reason: 'Already committed.' },
      { proposalId: 'proposal-rejected', status: 'rejected', reason: 'Rejected by Runtime.' },
      { proposalId: 'proposal-deferred', status: 'deferred', reason: 'Deferred by Runtime.' },
    ];
    const commit = vi.fn(async () => runtimeResults);

    const result = await commitAtomProposalPlan<TestProposal, TestResult>({
      ctx,
      plan: { proposals, decisions: [] },
      proposedIntent: 'revise',
      serviceName: 'Revision',
      commit,
      summarizeProposal: (proposal) => `Proposal ${proposal.id}`,
      summarizeResult: (runtimeResult) => `Result ${runtimeResult.proposalId}`,
    });

    expect(commit).toHaveBeenCalledOnce();
    expect(result.results).toBe(runtimeResults);
    expect(result.decisions.map((decision) => ({
      id: decision.id,
      decision: decision.decision,
      reconciliationDecision: decision.reconciliationDecision,
      summary: decision.summary,
      reason: decision.reason,
    }))).toEqual([
      {
        id: 'proposal-rejected', decision: 'rejected', reconciliationDecision: 'rejected',
        summary: 'Result proposal-rejected', reason: 'Rejected by Runtime.',
      },
      {
        id: 'proposal-deferred', decision: 'deferred', reconciliationDecision: 'deferred',
        summary: 'Result proposal-deferred', reason: 'Deferred by Runtime.',
      },
      {
        id: 'proposal-noop', decision: 'committed', reconciliationDecision: 'noop',
        summary: 'Result proposal-noop', reason: 'Already committed.',
      },
      {
        id: 'proposal-missing', decision: 'deferred', reconciliationDecision: 'deferred',
        summary: 'Proposal proposal-missing',
        reason: 'The revision service returned no result for the proposal.',
      },
    ]);
    expect(writes.count()).toBe(1);
    expect(writes.value()).toEqual(result.decisions);
  });
});

function testProposal(id: string): TestProposal {
  return { id, evidenceRefs: [`evidence:${id}`] };
}

function seedDecision(ctx: RunContext, id: string): MemoryIntentDecisionRecord {
  return atomProposalDecisionRecord({
    ctx,
    id,
    proposedIntent: 'revise',
    decision: 'rejected',
    reason: 'Rejected while parsing.',
    evidenceRefs: ['evidence:parse'],
    reconciliationDecision: 'rejected',
  });
}

function trackDecisionWrites(ctx: RunContext): {
  count: () => number;
  value: () => MemoryIntentDecisionRecord[] | undefined;
} {
  let count = 0;
  let value = ctx.memoryIntentDecisions;
  Object.defineProperty(ctx, 'memoryIntentDecisions', {
    configurable: true,
    get: () => value,
    set: (next: MemoryIntentDecisionRecord[] | undefined) => {
      count += 1;
      value = next;
    },
  });
  return { count: () => count, value: () => value };
}
