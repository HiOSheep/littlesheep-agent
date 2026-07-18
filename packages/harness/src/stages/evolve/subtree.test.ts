import { describe, expect, it, vi } from 'vitest';
import type { MemoryAtomSubtreeServiceLike } from '@littlesheep/memory-tree';
import type { RuntimeKnownStateMemoryReference } from '@littlesheep/types';
import { createMockLlm, makeCtx, textResponse } from '../../tests/helpers.js';
import { createEvolveStage } from '../evolve.js';

describe('EVOLVE Atom subtree proposals', () => {
  it('commits one verified subtree move using current complete D3 KnownState references', async () => {
    const moveSubtrees = vi.fn(async (proposals: Parameters<MemoryAtomSubtreeServiceLike['moveSubtrees']>[0]) => (
      proposals.map((proposal) => ({
        proposalId: proposal.id,
        status: 'committed' as const,
        rootAtomId: proposal.root.atomId,
        parentAtomId: proposal.parent.atomId,
        activeDescendantCount: 4,
        committed: true,
        reason: 'Committed by the runtime subtree gate.',
        managementResults: [],
      }))
    ));
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [],
      subtreeMoves: [subtreeJson('atom-root', 3, 'atom-parent', 5)],
      createSkill: null,
    })));
    const ctx = verifiedCtx();
    ctx.memoryKnownState = knownState(ctx.runId, [
      knownReference('atom-root', 3),
      knownReference('atom-parent', 5),
    ]);

    const result = await createEvolveStage({
      llm,
      model: 'test',
      memorySubtree: { moveSubtrees },
    })(ctx);

    expect(moveSubtrees).toHaveBeenCalledWith([
      expect.objectContaining({
        action: 'move-subtree',
        root: { atomId: 'atom-root', expectedRevision: 3 },
        parent: { atomId: 'atom-parent', expectedRevision: 5 },
        relationId: 'relation:root-belongs-to-parent',
        evidenceRefs: expect.arrayContaining([
          'memory-v3:atom:atom-root@3',
          'memory-v3:atom:atom-parent@5',
          'memory-v3:relation:relation:root-belongs-to-parent',
          expect.stringContaining(':verification:1:pass'),
        ]),
      }),
    ]);
    expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
      proposedIntent: 'move',
      decision: 'committed',
      reconciliationDecision: 'committed',
    }));
    expect(result.meta?.memorySubtreeMoves).toEqual([
      expect.objectContaining({
        status: 'committed',
        rootAtomId: 'atom-root',
        parentAtomId: 'atom-parent',
        activeDescendantCount: 4,
      }),
    ]);
  });

  it('rejects incomplete D3 references and missing VERIFY evidence before Runtime', async () => {
    for (const mutate of [
      (ctx: ReturnType<typeof verifiedCtx>, root: RuntimeKnownStateMemoryReference) => {
        root.envelope.disclosureLevel = 'D2';
        return ctx;
      },
      (ctx: ReturnType<typeof verifiedCtx>, root: RuntimeKnownStateMemoryReference) => {
        root.envelope.truncated = true;
        return ctx;
      },
      (ctx: ReturnType<typeof verifiedCtx>) => {
        ctx.verificationHistory = [{
          attempt: 1,
          verdict: 'fail',
          reason: 'The hierarchy evidence failed verification.',
          verifiedAt: '2026-07-17T10:00:02.000Z',
          source: 'model',
        }];
        return ctx;
      },
    ]) {
      const moveSubtrees = vi.fn();
      const llm = createMockLlm(textResponse(JSON.stringify({
        memories: [],
        subtreeMoves: [subtreeJson('atom-root', 3, 'atom-parent', 5)],
        createSkill: null,
      })));
      const ctx = verifiedCtx();
      const root = knownReference('atom-root', 3);
      mutate(ctx, root);
      ctx.memoryKnownState = knownState(ctx.runId, [root, knownReference('atom-parent', 5)]);

      await createEvolveStage({ llm, model: 'test', memorySubtree: { moveSubtrees } })(ctx);

      expect(moveSubtrees).not.toHaveBeenCalled();
      expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
        proposedIntent: 'move',
        decision: 'rejected',
        reason: expect.stringMatching(/complete D3|passing verification/iu),
      }));
    }
  });

  it('audits extra subtree proposals while sending only the first to Runtime', async () => {
    const moveSubtrees = vi.fn(async (proposals: Parameters<MemoryAtomSubtreeServiceLike['moveSubtrees']>[0]) => (
      proposals.map((proposal) => ({
        proposalId: proposal.id,
        status: 'noop' as const,
        rootAtomId: proposal.root.atomId,
        parentAtomId: proposal.parent.atomId,
        activeDescendantCount: 2,
        committed: false,
        reason: 'Already moved.',
        managementResults: [],
      }))
    ));
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [],
      subtreeMoves: [
        subtreeJson('atom-root', 3, 'atom-parent', 5),
        subtreeJson('second-root', 2, 'second-parent', 4),
      ],
      createSkill: null,
    })));
    const ctx = verifiedCtx();
    ctx.memoryKnownState = knownState(ctx.runId, [
      knownReference('atom-root', 3),
      knownReference('atom-parent', 5),
      knownReference('second-root', 2),
      knownReference('second-parent', 4),
    ]);

    await createEvolveStage({ llm, model: 'test', memorySubtree: { moveSubtrees } })(ctx);

    expect(moveSubtrees).toHaveBeenCalledTimes(1);
    expect(moveSubtrees.mock.calls[0]?.[0]).toHaveLength(1);
    expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
      id: `${ctx.runId}:evolve:subtree:2`,
      decision: 'rejected',
      reason: expect.stringContaining('Only one subtree move proposal'),
    }));
  });

  it('does not route an ordinary move memory intent through the subtree service', async () => {
    const moveSubtrees = vi.fn();
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [{ intent: 'move', summary: 'Move a subtree without a dedicated proposal.' }],
      subtreeMoves: [],
      createSkill: null,
    })));
    const ctx = verifiedCtx();

    await createEvolveStage({ llm, model: 'test', memorySubtree: { moveSubtrees } })(ctx);

    expect(moveSubtrees).not.toHaveBeenCalled();
    expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
      proposedIntent: 'move',
      decision: 'deferred',
      reason: expect.stringContaining('hierarchy gate'),
    }));
  });
});

function subtreeJson(rootAtomId: string, rootRevision: number, parentAtomId: string, parentRevision: number) {
  return {
    action: 'move-subtree',
    basis: 'explicit-parent-relation',
    root: { atomId: rootAtomId, expectedRevision: rootRevision },
    parent: { atomId: parentAtomId, expectedRevision: parentRevision },
    relationId: 'relation:root-belongs-to-parent',
    reason: 'Current verified evidence proves that this complete semantic subtree belongs under the destination parent.',
  };
}

function verifiedCtx() {
  const ctx = makeCtx({ reply: 'Verified subtree work completed.' });
  ctx.taskExecution = {
    goal: 'verify memory subtree gating',
    complexity: 'simple',
    status: 'done',
    startedAt: '2026-07-17T10:00:00.000Z',
    endedAt: '2026-07-17T10:00:01.000Z',
    steps: [{
      stepId: 'step-1',
      description: 'Verify the subtree relation',
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

function knownReference(atomId: string, atomRevision: number): RuntimeKnownStateMemoryReference {
  return {
    atomId,
    atomRevision,
    sourceRefs: [`conversation-source:${atomId}`],
    evidenceRefs: [`tool:${atomId}`],
    decision: 'adopted',
    reason: 'Selected for the verified subtree task.',
    envelope: {
      atomId,
      atomRevision,
      parentNodeId: atomId.includes('parent') ? 'project:root' : 'atom-old-parent',
      branch: 'project',
      scope: 'workspace',
      scopeKey: process.cwd(),
      tier: 2,
      disclosureLevel: 'D3',
      statementKind: 'factual-claim',
      epistemicStatus: 'verified',
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
      matchReason: 'Selected through an explicit parent relation.',
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
