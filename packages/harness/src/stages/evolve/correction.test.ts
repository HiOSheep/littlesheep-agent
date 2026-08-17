import { describe, expect, it, vi } from 'vitest';
import type { MemoryAtomCorrectionServiceLike } from '@littlesheep/memory-tree';
import type { RuntimeKnownStateMemoryReference } from '@littlesheep/types';
import { createMockLlm, makeCtx, textResponse } from '../../tests/helpers.js';
import { createEvolveStage } from '../evolve.js';

describe('EVOLVE Atom correction proposals', () => {
  it('commits one verified correction using current complete D3 KnownState references', async () => {
    const resolve = vi.fn(async (proposals: Parameters<MemoryAtomCorrectionServiceLike['resolve']>[0]) => (
      proposals.map((proposal) => ({
        proposalId: proposal.id,
        status: 'committed' as const,
        supersededAtomId: proposal.superseded.atomId,
        replacementAtomId: proposal.replacement.atomId,
        committed: true,
        previousRevision: proposal.superseded.expectedRevision,
        revision: proposal.superseded.expectedRevision + 1,
        reason: 'Committed by the runtime correction gate.',
        managementResults: [],
      }))
    ));
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [],
      corrections: [correctionJson('atom-old', 3, 'atom-new', 5)],
      createSkill: null,
    })));
    const ctx = verifiedCtx();
    const oldReference = knownReference('atom-old', 3, 'conflicted');
    oldReference.envelope.conflict = true;
    ctx.memoryKnownState = knownState(ctx.runId, [
      oldReference,
      knownReference('atom-new', 5, 'adopted'),
    ]);

    const result = await createEvolveStage({
      llm,
      model: 'test',
      memoryCorrector: { resolve },
    })(ctx);

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith([
      expect.objectContaining({
        action: 'supersede',
        basis: 'evidence-backed-correction',
        superseded: { atomId: 'atom-old', expectedRevision: 3 },
        replacement: { atomId: 'atom-new', expectedRevision: 5 },
        relationId: 'relation:new-replaces-old',
        evidenceRefs: expect.arrayContaining([
          'memory-v3:atom:atom-old@3',
          'memory-v3:atom:atom-new@5',
          'memory-v3:relation:relation:new-replaces-old',
          expect.stringContaining(':verification:1:pass'),
        ]),
      }),
    ]);
    expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
      proposedIntent: 'conflict',
      decision: 'committed',
      reconciliationDecision: 'committed',
      summary: 'Supersede atom-old with atom-new',
    }));
    expect(result.meta?.memoryAtomCorrections).toEqual([
      expect.objectContaining({
        status: 'committed',
        supersededAtomId: 'atom-old',
        replacementAtomId: 'atom-new',
        revision: 4,
      }),
    ]);
  });

  it('rejects incomplete or non-current references before calling Runtime', async () => {
    for (const mutate of [
      (oldReference: RuntimeKnownStateMemoryReference, replacement: RuntimeKnownStateMemoryReference) => {
        oldReference.envelope.disclosureLevel = 'D2';
        return [oldReference, replacement];
      },
      (oldReference: RuntimeKnownStateMemoryReference, replacement: RuntimeKnownStateMemoryReference) => {
        replacement.envelope.truncated = true;
        return [oldReference, replacement];
      },
      (oldReference: RuntimeKnownStateMemoryReference, replacement: RuntimeKnownStateMemoryReference) => {
        replacement.atomRevision += 1;
        return [oldReference, replacement];
      },
      (oldReference: RuntimeKnownStateMemoryReference, replacement: RuntimeKnownStateMemoryReference) => {
        replacement.envelope.atomId = 'atom-other';
        return [oldReference, replacement];
      },
    ]) {
      const resolve = vi.fn();
      const llm = createMockLlm(textResponse(JSON.stringify({
        memories: [],
        corrections: [correctionJson('atom-old', 3, 'atom-new', 5)],
        createSkill: null,
      })));
      const ctx = verifiedCtx();
      const oldReference = knownReference('atom-old', 3, 'conflicted');
      oldReference.envelope.conflict = true;
      const references = mutate(oldReference, knownReference('atom-new', 5, 'adopted'));
      ctx.memoryKnownState = knownState(ctx.runId, references);

      await createEvolveStage({ llm, model: 'test', memoryCorrector: { resolve } })(ctx);

      expect(resolve).not.toHaveBeenCalled();
      expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
        proposedIntent: 'conflict',
        decision: 'rejected',
        reason: expect.stringMatching(/complete D3|current/iu),
      }));
    }
  });

  it('audits extra correction proposals while sending only the first one to Runtime', async () => {
    const resolve = vi.fn(async (proposals: Parameters<MemoryAtomCorrectionServiceLike['resolve']>[0]) => (
      proposals.map((proposal) => ({
        proposalId: proposal.id,
        status: 'noop' as const,
        supersededAtomId: proposal.superseded.atomId,
        replacementAtomId: proposal.replacement.atomId,
        committed: false,
        previousRevision: proposal.superseded.expectedRevision,
        revision: proposal.superseded.expectedRevision,
        reason: 'Already superseded.',
        managementResults: [],
      }))
    ));
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [],
      corrections: [
        correctionJson('atom-old', 3, 'atom-new', 5),
        correctionJson('atom-second-old', 2, 'atom-second-new', 4),
      ],
      createSkill: null,
    })));
    const ctx = verifiedCtx();
    const oldReference = knownReference('atom-old', 3, 'conflicted');
    oldReference.envelope.conflict = true;
    const secondOld = knownReference('atom-second-old', 2, 'conflicted');
    secondOld.envelope.conflict = true;
    ctx.memoryKnownState = knownState(ctx.runId, [
      oldReference,
      knownReference('atom-new', 5, 'adopted'),
      secondOld,
      knownReference('atom-second-new', 4, 'adopted'),
    ]);

    await createEvolveStage({ llm, model: 'test', memoryCorrector: { resolve } })(ctx);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toHaveLength(1);
    expect(resolve.mock.calls[0]?.[0][0]?.superseded.atomId).toBe('atom-old');
    expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
      id: `${ctx.runId}:evolve:correction:2`,
      proposedIntent: 'conflict',
      decision: 'rejected',
      reason: expect.stringContaining('Only one Atom correction proposal'),
    }));
  });

  it('keeps ordinary conflict intents deferred and never routes them to the correction service', async () => {
    const resolve = vi.fn();
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [{ intent: 'conflict', summary: 'A stale memory may exist.' }],
      corrections: [],
      createSkill: null,
    })));
    const ctx = verifiedCtx();

    await createEvolveStage({ llm, model: 'test', memoryCorrector: { resolve } })(ctx);

    expect(resolve).not.toHaveBeenCalled();
    expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
      proposedIntent: 'conflict',
      decision: 'deferred',
      reason: expect.stringContaining('never mutate memory directly'),
    }));
  });

  it('rejects a correction when the current run has no passing VERIFY evidence', async () => {
    const resolve = vi.fn();
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [],
      corrections: [correctionJson('atom-old', 3, 'atom-new', 5)],
      createSkill: null,
    })));
    const ctx = verifiedCtx();
    ctx.verificationHistory = [{
      attempt: 1,
      verdict: 'fail',
      reason: 'The replacement was not verified.',
      verifiedAt: '2026-07-17T10:00:02.000Z',
      source: 'model',
    }];
    const oldReference = knownReference('atom-old', 3, 'conflicted');
    oldReference.envelope.conflict = true;
    ctx.memoryKnownState = knownState(ctx.runId, [
      oldReference,
      knownReference('atom-new', 5, 'adopted'),
    ]);

    await createEvolveStage({ llm, model: 'test', memoryCorrector: { resolve } })(ctx);

    expect(resolve).not.toHaveBeenCalled();
    expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
      proposedIntent: 'conflict',
      decision: 'rejected',
      reason: expect.stringContaining('passing verification'),
    }));
  });
});

function correctionJson(
  supersededAtomId: string,
  supersededRevision: number,
  replacementAtomId: string,
  replacementRevision: number,
) {
  return {
    action: 'supersede',
    basis: 'evidence-backed-correction',
    superseded: { atomId: supersededAtomId, expectedRevision: supersededRevision },
    replacement: { atomId: replacementAtomId, expectedRevision: replacementRevision },
    relationId: 'relation:new-replaces-old',
    reason: 'Current verified evidence proves that the replacement projection supersedes the older claim.',
  };
}

function verifiedCtx() {
  const ctx = makeCtx({ reply: 'Verified correction completed.' });
  ctx.taskExecution = {
    goal: 'verify memory correction gating',
    complexity: 'simple',
    status: 'done',
    startedAt: '2026-07-17T10:00:00.000Z',
    endedAt: '2026-07-17T10:00:01.000Z',
    steps: [{
      stepId: 'step-1',
      description: 'Verify the replacement claim',
      status: 'done',
      startedAt: '2026-07-17T10:00:00.000Z',
      endedAt: '2026-07-17T10:00:01.000Z',
      toolCallIds: ['tool-1'],
      toolResults: [{ callId: 'tool-1', ok: true, output: 'verified' }],
    }],
  };
  ctx.toolResults = [{ callId: 'tool-1', ok: true, output: 'verified' }];
  ctx.verificationHistory = [{
    attempt: 1,
    verdict: 'pass',
    reason: 'Acceptance criteria passed.',
    verifiedAt: '2026-07-17T10:00:02.000Z',
    source: 'model',
  }];
  return ctx;
}

function knownState(runId: string, references: RuntimeKnownStateMemoryReference[]) {
  return {
    version: 1 as const,
    runId,
    revision: 1,
    updatedAt: '2026-07-17T10:00:00.000Z',
    references,
  };
}

function knownReference(
  atomId: string,
  atomRevision: number,
  decision: RuntimeKnownStateMemoryReference['decision'],
): RuntimeKnownStateMemoryReference {
  return {
    atomId,
    atomRevision,
    sourceRefs: [`conversation-source:${atomId}`],
    evidenceRefs: [`tool:${atomId}`],
    decision,
    reason: 'Selected for the verified correction task.',
    envelope: {
      atomId,
      atomRevision,
      parentNodeId: 'atom-policy-parent',
      branch: 'project',
      scope: 'workspace',
      scopeKey: process.cwd(),
      tier: 2,
      disclosureLevel: 'D3',
      statementKind: 'factual-claim',
      epistemicStatus: decision === 'conflicted' ? 'disputed' : 'verified',
      authorityScope: { kind: 'tool-evidence', scope: 'workspace', scopeKey: process.cwd(), topics: ['repository'] },
      assertedBy: { kind: 'tool', id: 'test-tool' },
      sourceRefs: [`conversation-source:${atomId}`],
      evidenceRefs: [`tool:${atomId}`],
      confidence: 0.9,
      importance: 0.8,
      verifiedUsefulness: { useful: 1, notUseful: 0, conflicts: 0, stale: 0 },
      taskRelevance: 0.9,
      routingRelevance: 0.8,
      relationshipRelevance: 0.8,
      updatedAt: '2026-07-17T10:00:00.000Z',
      retrievalPath: 'relation',
      matchReason: 'Selected through an explicit replacement relation.',
      conflict: false,
      expired: false,
      truncated: false,
    },
    stages: ['enter', 'evolve'],
    firstSeenAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
    reactivatedCount: 0,
  };
}
