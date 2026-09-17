import { describe, expect, it, vi } from 'vitest';
import type {
  MemoryAtomHierarchyServiceLike,
  MemoryAtomReconciliationServiceLike,
  MemoryAtomRevisionServiceLike,
  MemoryWriteIntent,
  MemoryWriteServiceLike,
} from '@littlesheep/memory-tree';
import { textMessage, type RuntimeKnownStateMemoryReference } from '@littlesheep/types';
import { createEvolveStage } from './evolve.js';
import { createCaptureStage } from './capture.js';
import { createMockLlm, makeCtx, textResponse } from '../tests/helpers.js';

function writer(): MemoryWriteServiceLike & {
  writeMany: ReturnType<typeof vi.fn>;
  captureConversationSources: ReturnType<typeof vi.fn>;
} {
  const writeMany = vi.fn(async (intents: MemoryWriteIntent[]) => intents.map((intent, index) => ({
    intentId: intent.id ?? `intent-${index}`,
    decision: 'created' as const,
    reason: 'created',
    node: {
      id: `node-${index}`,
      branch: intent.branch,
      parentNodeId: intent.parentNodeId,
      childIds: [],
      scope: intent.scope,
      scopeKey: intent.scopeKey,
      tier: intent.tier,
      summary: intent.summary,
      content: intent.content,
      retrievalKeys: intent.retrievalKeys,
      importance: intent.importance,
      confidence: intent.confidence,
      reason: intent.reason,
      sourceRunIds: [intent.sourceRunId],
      sourceStages: [intent.sourceStage],
      status: 'active' as const,
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
    },
  })));
  const captureConversationSources = vi.fn(async () => []);
  return { write: vi.fn(), writeMany, captureConversationSources } as unknown as MemoryWriteServiceLike & {
    writeMany: ReturnType<typeof vi.fn>;
    captureConversationSources: ReturnType<typeof vi.fn>;
  };
}

function verifiedCtx(reply = 'Done') {
  const ctx = makeCtx({ reply });
  ctx.taskExecution = {
    goal: 'verify memory gating',
    complexity: 'simple',
    status: 'done',
    startedAt: '2026-07-10T00:00:00.000Z',
    endedAt: '2026-07-10T00:00:01.000Z',
    steps: [{
      stepId: 'step-1',
      description: 'Run the verified action',
      status: 'done',
      startedAt: '2026-07-10T00:00:00.000Z',
      endedAt: '2026-07-10T00:00:01.000Z',
      toolCallIds: ['tool-1'],
      toolResults: [{ callId: 'tool-1', ok: true, output: 'verified' }],
    }],
  };
  ctx.toolResults = [{ callId: 'tool-1', ok: true, output: 'verified' }];
  ctx.verificationHistory = [{
    attempt: 1,
    verdict: 'pass',
    reason: 'Acceptance criteria passed.',
    verifiedAt: '2026-07-10T00:00:02.000Z',
    source: 'model',
  }];
  return ctx;
}

function attachWebEvidence(ctx: ReturnType<typeof verifiedCtx>) {
  ctx.webEvidence = {
    version: 1,
    providerId: 'fake',
    generatedAt: '2026-08-29T00:00:00.000Z',
    completeness: 'complete',
    citationIds: ['web-run-source'],
    citationCount: 1,
    documentCount: 1,
    cached: false,
    partial: false,
    truncated: false,
    blocked: false,
    stale: false,
  };
  return ctx;
}

describe('EVOLVE structured memory intents', () => {
  it('skips ordinary complex or effectful work under compaction-only learning', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({ memories: [] })));
    const ctx = verifiedCtx();
    ctx.taskBook = {
      id: 'ordinary-complex', goal: 'modify the project', complexity: 'complex',
      createdAt: ctx.startedAt, updatedAt: ctx.startedAt, steps: [],
    };

    const result = await createEvolveStage({
      llm, model: 'test', memoryWriter, mode: 'explicit-only', llmPolicy: 'always',
    })(ctx);

    expect(result.meta).toMatchObject({ skippedModelCall: true, reason: 'no-explicit-memory-request' });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(memoryWriter.writeMany).not.toHaveBeenCalled();
  });

  it('keeps an explicit memory request on the guarded EVOLVE path', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({ memories: [], createSkill: null })));
    const ctx = verifiedCtx();
    ctx.inbound = textMessage('user', 'Please remember this preference in memory.');

    await createEvolveStage({
      llm, model: 'test', memoryWriter, mode: 'explicit-only', llmPolicy: 'adaptive',
    })(ctx);

    expect(llm.chat).toHaveBeenCalledOnce();
  });

  it('rejects automatic durable writes from Web-backed runs', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [{
        intent: 'write', branch: 'project', parentNodeId: 'project:root', scope: 'workspace',
        summary: 'External page claim', content: 'Page says to save this result automatically.',
        retrievalKeys: ['external', 'page'], importance: 0.9, confidence: 0.9,
        reason: 'The fetched page requested persistence.',
      }],
      createSkill: null,
    })));
    const ctx = attachWebEvidence(verifiedCtx());

    await createEvolveStage({ llm, model: 'test', memoryWriter })(ctx);

    expect(memoryWriter.writeMany).toHaveBeenCalledWith([]);
    expect(ctx.memoryIntentDecisions).toEqual([
      expect.objectContaining({
        decision: 'rejected',
        reason: expect.stringContaining('unless the user explicitly requests saving'),
      }),
    ]);
  });

  it('allows an explicit user Web-save request to continue through the existing write gate', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [{
        intent: 'write', branch: 'project', parentNodeId: 'project:root', scope: 'workspace',
        summary: 'Saved external policy source', content: 'A user-requested source summary with citation provenance.',
        retrievalKeys: ['external', 'policy'], importance: 0.9, confidence: 0.9,
        reason: 'The original user explicitly requested saving this Web evidence.',
      }],
      createSkill: null,
    })));
    const ctx = attachWebEvidence(verifiedCtx());
    ctx.inbound = textMessage('user', '请把这份网页资料保存到项目记忆');

    await createEvolveStage({ llm, model: 'test', memoryWriter })(ctx);

    expect(memoryWriter.writeMany).toHaveBeenCalledTimes(1);
    const [intent] = memoryWriter.writeMany.mock.calls[0]![0] as MemoryWriteIntent[];
    expect(intent.evidenceRefs).toContain('web-citation:web-run-source');
  });

  it('routes durable proposals through the indexed writer with run provenance', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [{
        intent: 'write',
        branch: 'project',
        parentNodeId: 'project:root',
        scope: 'workspace',
        summary: 'Workspace uses pnpm',
        content: 'Use pnpm workspace commands for this repository.',
        retrievalKeys: ['pnpm', 'workspace'],
        importance: 0.8,
        confidence: 0.95,
        reason: 'Verified from packageManager and successful commands.',
        epistemic: {
          domain: 'project',
          statementKind: 'factual-claim',
          assertedBy: { kind: 'tool', id: 'package-inspector' },
          topics: ['package manager'],
          entities: [
            { stableKey: 'project:workspace', type: 'project', label: 'Current workspace' },
            { stableKey: 'tool:pnpm', type: 'tool', label: 'pnpm' },
          ],
          relations: [
            { fromKey: 'project:workspace', toKey: 'tool:pnpm', type: 'depends-on' },
          ],
        },
      }],
      createSkill: null,
    })));
    const ctx = verifiedCtx();
    const result = await createEvolveStage({ llm, model: 'test', memoryWriter })(ctx);

    expect(result.next).toBe('capture');
    expect(memoryWriter.writeMany).toHaveBeenCalledTimes(1);
    const [intent] = memoryWriter.writeMany.mock.calls[0]![0] as MemoryWriteIntent[];
    expect(intent).toMatchObject({
      branch: 'project', parentNodeId: 'project:root', scope: 'workspace', scopeKey: ctx.cwd,
      sourceRunId: ctx.runId, sourceStage: 'evolve', summary: 'Workspace uses pnpm',
      epistemic: {
        domain: 'project',
        statementKind: 'factual-claim',
        epistemicStatus: 'corroborated',
        authorityScope: { kind: 'tool-evidence', scope: 'workspace', scopeKey: ctx.cwd },
        assertedBy: { kind: 'tool', id: 'package-inspector' },
        entityHints: [
          { stableKey: 'project:workspace', type: 'project', label: 'Current workspace' },
          { stableKey: 'tool:pnpm', type: 'tool', label: 'pnpm' },
        ],
        relationHints: [
          { fromKey: 'project:workspace', toKey: 'tool:pnpm', type: 'depends-on' },
        ],
      },
    });
    expect(intent.sourceRefs).toEqual(expect.arrayContaining([
      expect.stringContaining(':user-message:'),
      expect.stringContaining(':assistant-reply'),
      expect.stringContaining(':task-step:step-1:1'),
      expect.stringContaining(':verification:1'),
    ]));
    expect(intent.evidenceRefs).toEqual(expect.arrayContaining([
      expect.stringContaining(':verification:1:pass'),
      expect.stringContaining(':step:step-1:done'),
      expect.stringContaining(':tool:tool-1:succeeded'),
    ]));
    expect(memoryWriter.captureConversationSources).toHaveBeenCalledTimes(1);
    expect(ctx.evolutionNotes).toEqual(['Workspace uses pnpm']);
    expect(ctx.memoryIntentDecisions).toEqual([
      expect.objectContaining({ proposedIntent: 'write', decision: 'committed' }),
    ]);
    expect(ctx.modelRequests?.map((request) => request.stage)).toEqual(['evolve']);
  });

  it('does not write legacy free-form notes that bypass the structured gate', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse('{"notes":["temporary maybe"]}'));
    const ctx = makeCtx();
    const result = await createEvolveStage({ llm, model: 'test', memoryWriter })(ctx);
    expect(memoryWriter.writeMany).toHaveBeenCalledWith([]);
    expect(result.meta?.legacyNotesIgnored).toBe(1);
  });

  it('defers invalidate/conflict proposals without mutating memory', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [{
        intent: 'conflict',
        branch: 'project',
        summary: 'Package manager rule conflicts',
        reason: 'Two verified sources disagree.',
      }],
      createSkill: null,
    })));
    const ctx = verifiedCtx();

    await createEvolveStage({ llm, model: 'test', memoryWriter })(ctx);

    expect(memoryWriter.writeMany).toHaveBeenCalledWith([]);
    expect(ctx.memoryIntentDecisions).toEqual([
      expect.objectContaining({ proposedIntent: 'conflict', decision: 'deferred' }),
    ]);
  });

  it('requires explicit Atom reconciliation instead of treating a merge intent as a write', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [{
        intent: 'merge',
        branch: 'project',
        scope: 'workspace',
        summary: 'Duplicate package manager rule',
        content: 'Use pnpm workspace commands.',
        retrievalKeys: ['pnpm', 'workspace'],
        importance: 0.8,
        confidence: 0.95,
        reason: 'This should use the Atom reconciliation path.',
      }],
      reconciliations: [],
      createSkill: null,
    })));
    const ctx = verifiedCtx();

    await createEvolveStage({ llm, model: 'test', memoryWriter })(ctx);

    expect(memoryWriter.writeMany).toHaveBeenCalledWith([]);
    expect(ctx.memoryIntentDecisions).toEqual([
      expect.objectContaining({
        proposedIntent: 'merge',
        decision: 'deferred',
        reason: expect.stringContaining('explicit Atom ids'),
      }),
    ]);
  });

  it('routes a move memory intent to the dedicated hierarchy gate instead of writing it', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [{
        intent: 'move',
        branch: 'project',
        scope: 'workspace',
        summary: 'Move a hierarchy atom',
        content: 'This must be handled by the hierarchy gate.',
        retrievalKeys: ['hierarchy'],
        importance: 0.9,
        confidence: 0.95,
        reason: 'This should use the dedicated reparent protocol.',
      }],
      createSkill: null,
    })));
    const ctx = verifiedCtx();

    await createEvolveStage({ llm, model: 'test', memoryWriter })(ctx);

    expect(memoryWriter.writeMany).toHaveBeenCalledWith([]);
    expect(ctx.memoryIntentDecisions).toEqual([
      expect.objectContaining({
        proposedIntent: 'move',
        decision: 'deferred',
        reason: expect.stringContaining('hierarchy gate'),
      }),
    ]);
  });

  it('commits a model merge proposal only through adopted current KnownState references', async () => {
    const memoryWriter = writer();
    const reconcile = vi.fn(async (proposals: Parameters<MemoryAtomReconciliationServiceLike['reconcile']>[0]) => (
      proposals.map((proposal) => ({
        proposalId: proposal.id,
        status: 'committed' as const,
        targetAtomId: proposal.target.atomId,
        sourceAtomIds: proposal.sources.map((source) => source.atomId),
        committedSourceAtomIds: proposal.sources.map((source) => source.atomId),
        remainingSourceAtomIds: [],
        reason: 'Committed by the runtime reconciliation gate.',
        managementResults: [],
      }))
    ));
    const memoryReconciler: MemoryAtomReconciliationServiceLike = { reconcile };
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [],
      reconciliations: [{
        action: 'merge',
        basis: 'duplicate-projection',
        target: { atomId: 'atom-target', expectedRevision: 3 },
        sources: [{ atomId: 'atom-source', expectedRevision: 2 }],
        reason: 'Both atoms express the same verified package manager rule.',
      }],
      createSkill: null,
    })));
    const ctx = verifiedCtx();
    ctx.memoryKnownState = {
      version: 1,
      runId: ctx.runId,
      revision: 1,
      updatedAt: '2026-07-17T08:00:00.000Z',
      references: [
        knownReference('atom-target', 3),
        knownReference('atom-source', 2),
      ],
    };

    const result = await createEvolveStage({
      llm,
      model: 'test',
      memoryWriter,
      memoryReconciler,
    })(ctx);

    expect(reconcile).toHaveBeenCalledWith([
      expect.objectContaining({
        action: 'merge',
        basis: 'duplicate-projection',
        target: { atomId: 'atom-target', expectedRevision: 3 },
        sources: [{ atomId: 'atom-source', expectedRevision: 2 }],
        evidenceRefs: expect.arrayContaining([
          'memory-v3:atom:atom-target@3',
          'memory-v3:atom:atom-source@2',
          expect.stringContaining(':verification:1:pass'),
        ]),
      }),
    ]);
    expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
      proposedIntent: 'merge',
      decision: 'committed',
      reconciliationDecision: 'committed',
    }));
    expect(result.meta?.memoryReconciliations).toEqual([
      expect.objectContaining({ status: 'committed', committed: 1, remaining: 0 }),
    ]);
  });

  it('rejects a reconciliation proposal when its revision is not the current KnownState revision', async () => {
    const reconcile = vi.fn();
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [],
      reconciliations: [{
        action: 'merge',
        basis: 'duplicate-projection',
        target: { atomId: 'atom-target', expectedRevision: 4 },
        sources: [{ atomId: 'atom-source', expectedRevision: 2 }],
        reason: 'Both atoms appear to express the same package manager rule.',
      }],
      createSkill: null,
    })));
    const ctx = verifiedCtx();
    ctx.memoryKnownState = {
      version: 1,
      runId: ctx.runId,
      revision: 1,
      updatedAt: '2026-07-17T08:00:00.000Z',
      references: [knownReference('atom-target', 3), knownReference('atom-source', 2)],
    };

    await createEvolveStage({
      llm,
      model: 'test',
      memoryReconciler: { reconcile },
    })(ctx);

    expect(reconcile).not.toHaveBeenCalled();
    expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
      proposedIntent: 'merge',
      decision: 'rejected',
      reconciliationDecision: 'rejected',
      reason: expect.stringContaining('not an adopted, current'),
    }));
  });

  it('commits one explicit-relation reparent proposal through the hierarchy service', async () => {
    const reparent = vi.fn(async (proposals: Parameters<MemoryAtomHierarchyServiceLike['reparent']>[0]) => (
      proposals.map((proposal) => ({
        proposalId: proposal.id,
        status: 'committed' as const,
        atomId: proposal.atom.atomId,
        parentAtomId: proposal.parent.atomId,
        committed: true,
        reason: 'Committed by the runtime hierarchy gate.',
        managementResults: [],
      }))
    ));
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [],
      reconciliations: [],
      reparents: [{
        action: 'move',
        basis: 'explicit-parent-relation',
        atom: { atomId: 'atom-child', expectedRevision: 2 },
        parent: { atomId: 'atom-parent', expectedRevision: 4 },
        relationId: 'relation:child-belongs-to-parent',
        reason: 'The active ownership relation proves the corrected semantic parent.',
      }],
      createSkill: null,
    })));
    const ctx = verifiedCtx();
    ctx.memoryKnownState = {
      version: 1,
      runId: ctx.runId,
      revision: 1,
      updatedAt: '2026-07-17T08:00:00.000Z',
      references: [
        knownReference('atom-child', 2),
        knownReference('atom-parent', 4),
      ],
    };

    const result = await createEvolveStage({
      llm,
      model: 'test',
      memoryHierarchy: { reparent },
    })(ctx);

    expect(reparent).toHaveBeenCalledWith([
      expect.objectContaining({
        action: 'move',
        basis: 'explicit-parent-relation',
        atom: { atomId: 'atom-child', expectedRevision: 2 },
        parent: { atomId: 'atom-parent', expectedRevision: 4 },
        relationId: 'relation:child-belongs-to-parent',
        evidenceRefs: expect.arrayContaining([
          'memory-v3:atom:atom-child@2',
          'memory-v3:atom:atom-parent@4',
          'memory-v3:relation:relation:child-belongs-to-parent',
          expect.stringContaining(':verification:1:pass'),
        ]),
      }),
    ]);
    expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
      proposedIntent: 'move',
      decision: 'committed',
      reconciliationDecision: 'committed',
    }));
    expect(result.meta?.memoryHierarchyChanges).toEqual([
      expect.objectContaining({ status: 'committed', committed: true }),
    ]);
  });

  it('audits additional reparent proposals instead of silently discarding them', async () => {
    const reparent = vi.fn(async (proposals: Parameters<MemoryAtomHierarchyServiceLike['reparent']>[0]) => (
      proposals.map((proposal) => ({
        proposalId: proposal.id,
        status: 'committed' as const,
        atomId: proposal.atom.atomId,
        parentAtomId: proposal.parent.atomId,
        committed: true,
        reason: 'Committed by the runtime hierarchy gate.',
        managementResults: [],
      }))
    ));
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [],
      reconciliations: [],
      reparents: [
        {
          action: 'move',
          basis: 'explicit-parent-relation',
          atom: { atomId: 'atom-child', expectedRevision: 2 },
          parent: { atomId: 'atom-parent', expectedRevision: 4 },
          relationId: 'relation:child-belongs-to-parent',
          reason: 'The active ownership relation proves the corrected semantic parent.',
        },
        {
          action: 'move',
          basis: 'explicit-parent-relation',
          atom: { atomId: 'atom-other-child', expectedRevision: 1 },
          parent: { atomId: 'atom-parent', expectedRevision: 4 },
          relationId: 'relation:other-belongs-to-parent',
          reason: 'The second proposal is intentionally beyond the per-run bound.',
        },
      ],
      createSkill: null,
    })));
    const ctx = verifiedCtx();
    ctx.memoryKnownState = {
      version: 1,
      runId: ctx.runId,
      revision: 1,
      updatedAt: '2026-07-17T08:00:00.000Z',
      references: [
        knownReference('atom-child', 2),
        knownReference('atom-other-child', 1),
        knownReference('atom-parent', 4),
      ],
    };

    await createEvolveStage({ llm, model: 'test', memoryHierarchy: { reparent } })(ctx);

    expect(reparent).toHaveBeenCalledTimes(1);
    expect(reparent.mock.calls[0]?.[0]).toHaveLength(1);
    expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
      id: `${ctx.runId}:evolve:reparent:2`,
      proposedIntent: 'move',
      decision: 'rejected',
      reconciliationDecision: 'rejected',
      reason: expect.stringContaining('Only one reparent proposal'),
    }));
  });

  it('rejects a hierarchy proposal that only references a D1 Atom', async () => {
    const reparent = vi.fn();
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [],
      reconciliations: [],
      reparents: [{
        action: 'move',
        basis: 'explicit-parent-relation',
        atom: { atomId: 'atom-child', expectedRevision: 2 },
        parent: { atomId: 'atom-parent', expectedRevision: 4 },
        relationId: 'relation:child-belongs-to-parent',
        reason: 'The index appears to suggest a different hierarchy parent.',
      }],
      createSkill: null,
    })));
    const ctx = verifiedCtx();
    const child = knownReference('atom-child', 2);
    child.envelope.disclosureLevel = 'D1';
    ctx.memoryKnownState = {
      version: 1,
      runId: ctx.runId,
      revision: 1,
      updatedAt: '2026-07-17T08:00:00.000Z',
      references: [child, knownReference('atom-parent', 4)],
    };

    await createEvolveStage({ llm, model: 'test', memoryHierarchy: { reparent } })(ctx);

    expect(reparent).not.toHaveBeenCalled();
    expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
      proposedIntent: 'move',
      decision: 'rejected',
      reason: expect.stringContaining('D2/D3'),
    }));
  });

  it('defers projection writes when immutable conversation source capture fails', async () => {
    const memoryWriter = writer();
    memoryWriter.captureConversationSources.mockRejectedValueOnce(new Error('source disk unavailable'));
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [{
        intent: 'write',
        branch: 'project',
        summary: 'Workspace uses pnpm',
        content: 'Use pnpm workspace commands for this repository.',
        retrievalKeys: ['pnpm'],
        importance: 0.8,
        confidence: 0.95,
        reason: 'Verified by the run.',
      }],
      createSkill: null,
    })));
    const ctx = verifiedCtx();

    await createEvolveStage({ llm, model: 'test', memoryWriter })(ctx);

    expect(memoryWriter.writeMany).not.toHaveBeenCalled();
    expect(ctx.memoryIntentDecisions).toEqual([
      expect.objectContaining({
        proposedIntent: 'write',
        decision: 'deferred',
        reason: expect.stringContaining('Conversation source capture failed'),
      }),
    ]);
  });

  it('commits one same-claim Atom revision only from a complete D3 KnownState reference', async () => {
    const revise = vi.fn(async (proposals: Parameters<MemoryAtomRevisionServiceLike['revise']>[0]) => (
      proposals.map((proposal) => ({
        proposalId: proposal.id,
        status: 'committed' as const,
        atomId: proposal.atom.atomId,
        committed: true,
        previousRevision: proposal.atom.expectedRevision,
        revision: proposal.atom.expectedRevision + 1,
        reason: 'Committed by the runtime Atom revision gate.',
        managementResults: [],
      }))
    ));
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [],
      revisions: [{
        action: 'revise',
        basis: 'same-claim-refinement',
        atom: { atomId: 'atom-revision', expectedRevision: 4 },
        replacement: {
          title: 'Workspace package manager',
          summary: 'The workspace uses pnpm for package management.',
          content: 'Use pnpm workspace commands when operating in this repository.',
          retrievalKeys: ['pnpm', 'workspace', 'package manager'],
        },
        reason: 'Clarifies the verified package manager claim without changing its meaning.',
      }],
      createSkill: null,
    })));
    const ctx = verifiedCtx();
    const reference = knownReference('atom-revision', 4);
    reference.envelope.disclosureLevel = 'D3';
    ctx.memoryKnownState = {
      version: 1,
      runId: ctx.runId,
      revision: 1,
      updatedAt: '2026-07-17T08:00:00.000Z',
      references: [reference],
    };

    const result = await createEvolveStage({ llm, model: 'test', memoryReviser: { revise } })(ctx);

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise).toHaveBeenCalledWith([
      expect.objectContaining({
        action: 'revise',
        basis: 'same-claim-refinement',
        atom: { atomId: 'atom-revision', expectedRevision: 4 },
        evidenceRefs: expect.arrayContaining([
          'memory-v3:atom:atom-revision@4',
          expect.stringContaining(':verification:1:pass'),
        ]),
      }),
    ]);
    expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
      proposedIntent: 'revise',
      decision: 'committed',
      reconciliationDecision: 'committed',
      summary: 'Refine the projection for atom-revision',
    }));
    expect(result.meta?.memoryAtomRevisions).toEqual([
      expect.objectContaining({ atomId: 'atom-revision', status: 'committed', revision: 5 }),
    ]);
  });

  it('rejects incomplete or mismatched revision targets before calling the revision service', async () => {
    for (const { mutate, reason } of [
      {
        mutate: (reference: RuntimeKnownStateMemoryReference) => reference,
        reason: 'complete D3',
      },
      {
        mutate: (reference: RuntimeKnownStateMemoryReference) => {
          reference.envelope.disclosureLevel = 'D3';
          reference.envelope.truncated = true;
          return reference;
        },
        reason: 'complete D3',
      },
      {
        mutate: (reference: RuntimeKnownStateMemoryReference) => {
          reference.envelope.disclosureLevel = 'D3';
          reference.envelope.atomId = 'atom-other';
          return reference;
        },
        reason: 'does not match',
      },
    ]) {
      const revise = vi.fn();
      const llm = createMockLlm(textResponse(JSON.stringify({
        memories: [],
        revisions: [revisionProposalJson('atom-revision', 4)],
        createSkill: null,
      })));
      const ctx = verifiedCtx();
      ctx.memoryKnownState = {
        version: 1,
        runId: ctx.runId,
        revision: 1,
        updatedAt: '2026-07-17T08:00:00.000Z',
        references: [mutate(knownReference('atom-revision', 4))],
      };

      await createEvolveStage({ llm, model: 'test', memoryReviser: { revise } })(ctx);

      expect(revise).not.toHaveBeenCalled();
      expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
        proposedIntent: 'revise',
        decision: 'rejected',
        reason: expect.stringContaining(reason),
      }));
    }
  });

  it('audits extra revision proposals while sending only the first proposal to Runtime', async () => {
    const revise = vi.fn(async (proposals: Parameters<MemoryAtomRevisionServiceLike['revise']>[0]) => (
      proposals.map((proposal) => ({
        proposalId: proposal.id,
        status: 'noop' as const,
        atomId: proposal.atom.atomId,
        committed: false,
        previousRevision: proposal.atom.expectedRevision,
        revision: proposal.atom.expectedRevision,
        reason: 'The projection already matches.',
        managementResults: [],
      }))
    ));
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [],
      revisions: [
        revisionProposalJson('atom-first', 2),
        revisionProposalJson('atom-second', 3),
      ],
      createSkill: null,
    })));
    const ctx = verifiedCtx();
    const first = knownReference('atom-first', 2);
    const second = knownReference('atom-second', 3);
    first.envelope.disclosureLevel = 'D3';
    second.envelope.disclosureLevel = 'D3';
    ctx.memoryKnownState = {
      version: 1,
      runId: ctx.runId,
      revision: 1,
      updatedAt: '2026-07-17T08:00:00.000Z',
      references: [first, second],
    };

    await createEvolveStage({ llm, model: 'test', memoryReviser: { revise } })(ctx);

    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise.mock.calls[0]?.[0]).toHaveLength(1);
    expect(revise.mock.calls[0]?.[0][0]?.atom.atomId).toBe('atom-first');
    expect(ctx.memoryIntentDecisions).toContainEqual(expect.objectContaining({
      id: `${ctx.runId}:evolve:revision:2`,
      proposedIntent: 'revise',
      decision: 'rejected',
      reason: expect.stringContaining('Only one Atom revision proposal'),
    }));
  });
});

function revisionProposalJson(atomId: string, expectedRevision: number) {
  return {
    action: 'revise',
    basis: 'same-claim-refinement',
    atom: { atomId, expectedRevision },
    replacement: {
      title: 'Workspace package manager',
      summary: 'The workspace uses pnpm for package management.',
      content: 'Use pnpm workspace commands when operating in this repository.',
      retrievalKeys: ['pnpm', 'workspace', 'package manager'],
    },
    reason: 'Clarifies the verified package manager claim without changing its meaning.',
  };
}

function knownReference(atomId: string, atomRevision: number): RuntimeKnownStateMemoryReference {
  return {
    atomId,
    atomRevision,
    sourceRefs: [`conversation-source:${atomId}`],
    evidenceRefs: [`tool:${atomId}`],
    decision: 'adopted',
    reason: 'Selected for the verified task.',
    envelope: {
      atomId,
      atomRevision,
      branch: 'project',
      scope: 'workspace',
      scopeKey: process.cwd(),
      tier: 2,
      disclosureLevel: 'D2',
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
      relationshipRelevance: 0.5,
      updatedAt: '2026-07-17T08:00:00.000Z',
      retrievalPath: 'hierarchy',
      matchReason: 'Selected for this task.',
      conflict: false,
      expired: false,
      truncated: false,
    },
    stages: ['enter', 'evolve'],
    firstSeenAt: '2026-07-17T08:00:00.000Z',
    updatedAt: '2026-07-17T08:00:00.000Z',
    reactivatedCount: 0,
  };
}

describe('CAPTURE daily timeline intents', () => {
  it('does not create a per-run daily atom under compaction-only learning', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({ observations: [] })));
    const result = await createCaptureStage({
      llm, model: 'test', memoryWriter, automaticEnabled: false, llmEnabled: true,
    })(verifiedCtx());

    expect(result.meta).toMatchObject({ skippedAutomaticCapture: true, reason: 'compaction-only-memory-policy' });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(memoryWriter.writeMany).not.toHaveBeenCalled();
  });

  it('does not auto-capture a Web-backed run when the user did not request persistence', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({ observations: [{
      intent: 'write', summary: 'Web lookup', content: 'Fetched page text.',
      retrievalKeys: ['web', 'lookup'], importance: 0.8, confidence: 0.9,
      reason: 'Record the lookup.',
    }] })));
    const ctx = attachWebEvidence(verifiedCtx());

    await createCaptureStage({ llm, model: 'test', memoryWriter })(ctx);

    expect(memoryWriter.writeMany).toHaveBeenCalledWith([]);
    expect(ctx.memoryIntentDecisions).toEqual([
      expect.objectContaining({ decision: 'rejected' }),
    ]);
  });

  it('forces observations into the daily workspace branch regardless of model wording', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({ observations: [{
      intent: 'write',
      summary: 'Build verification',
      content: 'The production build completed successfully.',
      retrievalKeys: ['build', 'verification'],
      importance: 0.5,
      confidence: 0.9,
      reason: 'Useful when diagnosing the next build regression.',
      epistemic: {
        domain: 'task',
        statementKind: 'reported-observation',
        assertedBy: { kind: 'tool', id: 'build-command' },
      },
    }] })));
    const ctx = verifiedCtx('Build passed');
    const result = await createCaptureStage({ llm, model: 'test', memoryWriter })(ctx);

    expect(result.next).toBe('finalize');
    const [intent] = memoryWriter.writeMany.mock.calls[0]![0] as MemoryWriteIntent[];
    expect(intent).toMatchObject({
      branch: 'daily', parentNodeId: 'daily:root', scope: 'workspace', scopeKey: ctx.cwd,
      sourceRunId: ctx.runId, sourceStage: 'capture', summary: 'Build verification',
      epistemic: {
        domain: 'task',
        statementKind: 'reported-observation',
        epistemicStatus: 'corroborated',
        authorityScope: { kind: 'tool-evidence', scope: 'workspace', scopeKey: ctx.cwd },
        assertedBy: { kind: 'tool', id: 'build-command' },
      },
    });
    expect(intent?.tier).toBe(3);
    expect(intent?.sourceRefs).toEqual(expect.arrayContaining([
      expect.stringContaining(':user-message:'),
      expect.stringContaining(':verification:1'),
    ]));
    expect(intent?.evidenceRefs).toEqual(expect.arrayContaining([
      expect.stringContaining(':verification:1:pass'),
    ]));
    expect(ctx.modelRequests?.map((request) => request.stage)).toEqual(['capture']);
  });

  it('keeps a model transport failure non-fatal and performs no write', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(''));
    llm.chat.mockRejectedValue(new Error('offline'));
    const result = await createCaptureStage({ llm, model: 'test', memoryWriter })(makeCtx());
    expect(result.ok).toBe(true);
    expect(memoryWriter.writeMany).toHaveBeenCalledWith([]);
  });
});
